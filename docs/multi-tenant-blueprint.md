# Cadence Multi-Tenant Blueprint

> Single deployment, unlimited client businesses. Each client gets their own Twilio number, custom system prompt, and isolated call sessions.

---

## Executive Summary

The current Cadence v2 is single-tenant: one hardcoded DVDS system prompt, one Twilio number, one business. This blueprint converts it to multi-tenant by adding a Postgres lookup layer between Twilio and the call handler. When a call arrives, we match the `To` number against a `clients` table, load that client's system prompt and config, and pass it into an isolated `CallHandler` session. No architectural rewrites — the STT/LLM/TTS pipeline stays identical. We're adding a database lookup at the front door and parameterizing what's currently hardcoded.

Stripe webhook integration enforces billing: subscriptions that lapse or fail payment automatically deactivate the client's phone line. Trial expiration is checked at call time.

---

## File Structure (after changes)

```
cadence-v2/
├── docs/
│   └── multi-tenant-blueprint.md    # this file
├── scripts/
│   └── add-client.ts                # NEW — admin CLI for provisioning
├── sql/
│   └── 001-clients.sql              # NEW — initial schema migration
├── src/
│   ├── index.ts                     # MODIFY — call routing + Stripe webhook
│   ├── call-handler.ts              # MODIFY — accept client config as constructor params
│   ├── db.ts                        # NEW — Postgres connection + queries
│   ├── llm.ts                       # MODIFY — accept systemPrompt param instead of import
│   ├── sms.ts                       # MODIFY — accept client's Twilio number as `from`
│   ├── stt.ts                       # NO CHANGE
│   ├── system-prompt.ts             # REWRITE — template function replacing hardcoded string
│   ├── tts.ts                       # NO CHANGE
│   └── stripe.ts                    # NEW — Stripe webhook handler
├── package.json                     # MODIFY — add pg, stripe deps
└── tsconfig.json
```

---

## Database Schema (Neon Postgres)

File: `sql/001-clients.sql`

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name   TEXT NOT NULL,
  phone_number    TEXT NOT NULL UNIQUE,       -- Twilio number assigned to this client (E.164: +16025551234)
  system_prompt   TEXT NOT NULL,              -- full generated system prompt string
  transfer_number TEXT,                       -- human handoff number (E.164), nullable
  greeting        TEXT NOT NULL,              -- e.g. "Thanks for calling Deer Valley Driving School. How can I help you today?"
  sms_enabled     BOOLEAN NOT NULL DEFAULT false,
  booking_url     TEXT,                       -- URL to text to callers, nullable
  owner_phone     TEXT,                       -- owner's cell for call summaries, nullable
  plan            TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'growth')),
  trial_ends_at   TIMESTAMPTZ,               -- null = no trial (paid from day one)
  active          BOOLEAN NOT NULL DEFAULT true,
  stripe_customer_id  TEXT,                   -- Stripe customer ID, nullable until they subscribe
  stripe_subscription_id TEXT,               -- Stripe subscription ID, nullable
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup on incoming calls (the hot path)
CREATE INDEX idx_clients_phone ON clients (phone_number);

-- Stripe webhook lookups
CREATE INDEX idx_clients_stripe_customer ON clients (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_clients_stripe_subscription ON clients (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
```

**Why UUID for `id`?** Safe to expose in APIs/URLs later without leaking row count or creation order. `gen_random_uuid()` is built into Postgres via pgcrypto.

**Why `system_prompt` stored as full text (not assembled at runtime)?** The prompt is generated once at provisioning time from a template. Storing the full string means the call hot path is a single SELECT with zero computation. If the client updates their hours, the admin CLI regenerates and UPDATEs the prompt. Simple.

---

## Environment Variables

### Existing (no changes)
| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_WEBSOCKET_URL` | WebSocket URL for media streams (e.g. `wss://cadence.up.railway.app/media-stream`) |
| `TWILIO_SMS_NUMBER` | **Deprecated in multi-tenant** — SMS now comes from client's own number. Keep for backward compat during migration. |
| `DEEPGRAM_API_KEY` | Deepgram STT + TTS |
| `GROQ_API_KEY` | Groq LLM (primary) |
| `GROQ_MODEL` | Groq model name (default: `llama-3.3-70b-versatile`) |
| `OPENAI_API_KEY` | OpenAI fallback LLM |
| `OPENAI_MODEL` | OpenAI model name (default: `gpt-4o`) |
| `AUSTEN_CELL_NUMBER` | **Deprecated in multi-tenant** — replaced by per-client `owner_phone` |
| `PORT` | Server port (default: 3000) |

### New
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (e.g. `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/cadence?sslmode=require`) |
| `STRIPE_SECRET_KEY` | Stripe API secret key for webhook signature verification and API calls |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook endpoint signing secret (starts with `whsec_`) |

---

## File-by-File Changes

### 1. `src/db.ts` — NEW

Postgres connection pool and query functions. Single pool shared across all requests.

```typescript
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // Neon requires SSL
  max: 10,                              // 10 connections is plenty for a voice app
});

export interface Client {
  id: string;
  business_name: string;
  phone_number: string;
  system_prompt: string;
  transfer_number: string | null;
  greeting: string;
  sms_enabled: boolean;
  booking_url: string | null;
  owner_phone: string | null;
  plan: string;
  trial_ends_at: Date | null;
  active: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

/**
 * Look up a client by their assigned Twilio phone number.
 * This is the hot path — called on every incoming call.
 */
export async function getClientByPhone(phoneNumber: string): Promise<Client | null> {
  const result = await pool.query<Client>(
    "SELECT * FROM clients WHERE phone_number = $1 LIMIT 1",
    [phoneNumber]
  );
  return result.rows[0] || null;
}

/**
 * Check if a client's trial has expired.
 * Returns true if the client is on a trial plan AND trial_ends_at is in the past
 * AND they have no active Stripe subscription.
 */
export function isTrialExpired(client: Client): boolean {
  if (client.plan !== "trial") return false;
  if (!client.trial_ends_at) return false;
  return client.trial_ends_at < new Date() && !client.stripe_subscription_id;
}

/**
 * Set a client's active status. Used by Stripe webhooks and trial enforcement.
 */
export async function setClientActive(clientId: string, active: boolean): Promise<void> {
  await pool.query(
    "UPDATE clients SET active = $1, updated_at = now() WHERE id = $2",
    [active, clientId]
  );
}

/**
 * Find client by Stripe customer ID. Used by Stripe webhooks.
 */
export async function getClientByStripeCustomer(stripeCustomerId: string): Promise<Client | null> {
  const result = await pool.query<Client>(
    "SELECT * FROM clients WHERE stripe_customer_id = $1 LIMIT 1",
    [stripeCustomerId]
  );
  return result.rows[0] || null;
}

/**
 * Find client by Stripe subscription ID. Used by Stripe webhooks.
 */
export async function getClientByStripeSubscription(subscriptionId: string): Promise<Client | null> {
  const result = await pool.query<Client>(
    "SELECT * FROM clients WHERE stripe_subscription_id = $1 LIMIT 1",
    [subscriptionId]
  );
  return result.rows[0] || null;
}

export { pool };
```

**Dependencies to add:** `pg` + `@types/pg`

### 2. `src/index.ts` — MODIFY

Three changes: (a) look up client on `/incoming-call`, (b) pass client config into WebSocket via custom parameters, (c) add `/webhook/stripe` endpoint.

```typescript
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { CallHandler } from "./call-handler";
import { getClientByPhone, isTrialExpired } from "./db";
import { handleStripeWebhook } from "./stripe";

const app = express();

// Stripe webhooks need the raw body for signature verification.
// Must be registered BEFORE express.json() / express.urlencoded().
app.post("/webhook/stripe", express.raw({ type: "application/json" }), handleStripeWebhook);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/incoming-call", async (req, res) => {
  const toNumber: string = req.body.To || req.body.Called || "";
  const fromNumber: string = req.body.From || req.body.Caller || "";

  // 1. Look up client by the Twilio number that was called
  const client = await getClientByPhone(toNumber);

  if (!client) {
    return res.type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>This number is not currently active. Goodbye.</Say>\n  <Hangup/>\n</Response>`
    );
  }

  // 2. Check billing status
  if (!client.active || isTrialExpired(client)) {
    return res.type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>This service is currently unavailable.</Say>\n  <Hangup/>\n</Response>`
    );
  }

  // 3. Connect to media stream, passing client ID + caller number as custom parameters
  const streamUrl = process.env.TWILIO_WEBSOCKET_URL;
  if (!streamUrl) {
    return res.status(500).type("text/plain").send("Missing TWILIO_WEBSOCKET_URL");
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="clientId" value="${client.id}" />
      <Parameter name="from" value="${fromNumber}" />
    </Stream>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// In-memory client cache to avoid DB lookup on every WebSocket connection.
// The /incoming-call handler already validated the client — we just need to
// pass the config to CallHandler. Twilio's Stream custom parameters deliver
// the clientId in the "start" event, so we look it up once there.

wss.on("connection", (ws) => {
  // CallHandler is now created lazily after we receive the "start" event
  // with the clientId. See CallHandler constructor change below.
  let handler: CallHandler | null = null;

  ws.on("message", async (message) => {
    try {
      const raw = message.toString();
      const parsed = JSON.parse(raw);

      if (!handler && parsed.event === "start") {
        // Extract clientId from custom parameters, look up client
        const clientId = parsed.start?.customParameters?.clientId;
        if (!clientId) {
          console.error("no clientId in stream start event");
          ws.close();
          return;
        }

        const { getClientByPhone: _, ...dbModule } = await import("./db");
        const client = await (await import("./db")).pool.query(
          "SELECT * FROM clients WHERE id = $1 LIMIT 1",
          [clientId]
        ).then(r => r.rows[0]);

        if (!client) {
          console.error(`client not found: ${clientId}`);
          ws.close();
          return;
        }

        handler = new CallHandler(ws, {
          clientId: client.id,
          businessName: client.business_name,
          systemPrompt: client.system_prompt,
          transferNumber: client.transfer_number,
          greeting: client.greeting,
          smsEnabled: client.sms_enabled,
          bookingUrl: client.booking_url,
          ownerPhone: client.owner_phone,
          twilioNumber: client.phone_number,
        });
      }

      if (handler) {
        await handler.handleMessage(raw);
      }
    } catch (err) {
      console.error("failed to handle ws message", err);
    }
  });

  ws.on("error", (err) => {
    console.error("twilio ws error", err);
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`cadence-v2 listening on ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    wss.close();
    server.close(() => process.exit(0));
  });
}
```

**Key design decision:** Client config is passed to `CallHandler` via Twilio's `<Stream><Parameter>` mechanism. The `/incoming-call` endpoint already validated the client and checked billing — the WebSocket handler just needs to load the config by ID. This means the WebSocket path never sees an inactive client.

**Alternative considered and rejected:** Storing client config in a `Map<streamSid, Client>` between the HTTP handler and WebSocket handler. This creates a race condition (stream connects before map entry is written) and stale state problems. Using Twilio's built-in custom parameters is cleaner.

### 3. `src/stripe.ts` — NEW

Stripe webhook handler. Handles subscription lifecycle events to enforce billing.

```typescript
import { Request, Response } from "express";
import Stripe from "stripe";
import { getClientByStripeCustomer, getClientByStripeSubscription, setClientActive } from "./db";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key);
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[STRIPE] Missing STRIPE_WEBHOOK_SECRET");
    res.status(500).send("Server misconfigured");
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[STRIPE] Signature verification failed:", err);
    res.status(400).send("Invalid signature");
    return;
  }

  console.log(`[STRIPE] Received event: ${event.type}`);

  switch (event.type) {
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      const client = await getClientByStripeCustomer(customerId);
      if (client) {
        await setClientActive(client.id, true);
        console.log(`[STRIPE] Activated client ${client.business_name} (invoice paid)`);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      const client = await getClientByStripeCustomer(customerId);
      if (client) {
        await setClientActive(client.id, false);
        console.log(`[STRIPE] Deactivated client ${client.business_name} (payment failed)`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const client = await getClientByStripeSubscription(subscription.id);
      if (client) {
        await setClientActive(client.id, false);
        console.log(`[STRIPE] Deactivated client ${client.business_name} (subscription canceled)`);
      }
      break;
    }

    default:
      // Ignore events we don't care about
      break;
  }

  // Always return 200 to Stripe — even if we didn't process the event.
  // Returning non-200 causes Stripe to retry, which we don't want for unknown events.
  res.status(200).json({ received: true });
}
```

**Why check both customer ID and subscription ID?** `invoice.paid` and `invoice.payment_failed` carry the customer ID on the invoice object. `customer.subscription.deleted` carries the subscription ID. We index both columns for fast lookups.

### 4. `src/call-handler.ts` — MODIFY

Accept client config as a constructor parameter. Remove all hardcoded DVDS references.

```typescript
// New interface for client config passed to CallHandler
export interface ClientConfig {
  clientId: string;
  businessName: string;
  systemPrompt: string;
  transferNumber: string | null;
  greeting: string;
  smsEnabled: boolean;
  bookingUrl: string | null;
  ownerPhone: string | null;
  twilioNumber: string;      // client's Twilio number (used as SMS sender)
}
```

**Changes to constructor:**
```typescript
constructor(private readonly ws: WebSocket, private readonly client: ClientConfig) {}
```

**Changes to `onStart`:**
- Replace hardcoded `"Thanks for calling Deer Valley Driving School..."` with `this.client.greeting`

**Changes to `onTranscript`:**
- Pass `this.client.systemPrompt` to `chat()` instead of the imported `SYSTEM_PROMPT`
- Pass `this.client.bookingUrl` to SMS logic (or skip SMS if `!this.client.smsEnabled`)
- `sendBookingLink` gets `this.client.twilioNumber` as the `from` number and `this.client.bookingUrl` as the URL

**Changes to `onStop`:**
- `sendCallSummary` uses `this.client.ownerPhone` instead of `AUSTEN_CELL_NUMBER`
- `sendCallSummary` sends from `this.client.twilioNumber`
- If `this.client.ownerPhone` is null, skip the summary SMS

### 5. `src/llm.ts` — MODIFY

Accept `systemPrompt` as a parameter instead of importing the hardcoded constant.

```typescript
// BEFORE
import { SYSTEM_PROMPT } from "./system-prompt";
export async function chat(history: ...): Promise<string> {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

// AFTER
export async function chat(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): Promise<string> {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...history];
```

That's the only change. The rest of `llm.ts` stays identical.

### 6. `src/sms.ts` — MODIFY

Accept `from` number and dynamic URLs instead of reading from env.

```typescript
// BEFORE
async function sendSms(to: string, body: string): Promise<void> {
  const from = requireEnv("TWILIO_SMS_NUMBER");

// AFTER
async function sendSms(to: string, from: string, body: string): Promise<void> {
  // `from` is now the client's Twilio number
```

```typescript
// BEFORE
export async function sendBookingLink(to: string): Promise<void> {
  await sendSms(to, "Here is the DVDS booking link: ...");

// AFTER
export async function sendBookingLink(to: string, from: string, bookingUrl: string): Promise<void> {
  await sendSms(to, from, `Here's the link to book: ${bookingUrl}`);
```

```typescript
// BEFORE
export async function sendCallSummary(callerPhone: string, summary: string[]): Promise<void> {
  const austen = requireEnv("AUSTEN_CELL_NUMBER");
  await sendSms(austen, `Cadence call summary\nCaller: ${callerPhone}\n${bullets}`);

// AFTER
export async function sendCallSummary(
  callerPhone: string,
  summary: string[],
  ownerPhone: string,
  from: string,
  businessName: string
): Promise<void> {
  const bullets = summary.length > 0 ? summary.map((s) => `• ${s}`).join("\n") : "• No key points captured";
  await sendSms(ownerPhone, from, `${businessName} — call summary\nCaller: ${callerPhone}\n${bullets}`);
}
```

### 7. `src/system-prompt.ts` — REWRITE

Replace the hardcoded string with a template function. The existing DVDS prompt becomes the first client provisioned via the template.

```typescript
export interface PromptParams {
  businessName: string;
  businessDescription: string;   // e.g. "a driving school serving the greater Phoenix area since 2011"
  phoneNumber: string;            // business phone (for the AI to reference)
  website: string;
  hours: string;                  // e.g. "Monday through Friday, 8 AM to 6 PM, and Saturday 9 AM to 3 PM"
  services: string;               // paragraph describing what the business offers
  faqs: string;                   // paragraph of common Q&A the AI should know
  bookingInstructions: string;    // how callers should book (website, in-person, etc.)
  transferNumber: string | null;  // human handoff number
  smsBookingUrl: string | null;   // URL to text to callers
}

export function generateSystemPrompt(params: PromptParams): string {
  const transferLine = params.transferNumber
    ? `If the caller requests to speak with a person, offer to transfer them to ${params.transferNumber}.`
    : `If the caller requests to speak with a person, take their name and number and let them know someone will call them back.`;

  const smsLine = params.smsBookingUrl
    ? `You may offer to text the booking link (${params.smsBookingUrl}) once per call — only when the caller is ready to schedule or specifically asks for it. If you have already offered during this call, do not offer again. Never offer to text pricing, packages, or general information.`
    : `Do not offer to text anything to the caller.`;

  return `You are Cadence, the AI receptionist for ${params.businessName}. You are professional, warm, and concise, and you always speak in complete sentences. This is a phone call, so keep every response to one or two short sentences, never use lists or bullet points out loud, and never use markdown. Every single response must end with an open question or a clear call to action.

About ${params.businessName}: ${params.businessDescription}. The phone number is ${params.phoneNumber}, and the website is ${params.website}.

Hours of operation: ${params.hours}.

Services and offerings:
${params.services}

Frequently asked questions:
${params.faqs}

Booking:
${params.bookingInstructions}

${transferLine}

${smsLine}

Hard rules: If a caller asks about something outside your knowledge, offer to have someone call them back. Always end with an open question or a call to action. Always keep the response to one or two sentences.`;
}
```

**Why store the full generated prompt instead of the params?** Because the prompt is the contract with the LLM. If we store only params and regenerate at call time, a template change could silently alter every client's behavior. Storing the full prompt means each client's behavior is frozen until explicitly updated. The template is used only at provisioning time and during explicit updates.

### 8. `scripts/add-client.ts` — NEW

Admin CLI for provisioning new clients.

```typescript
/**
 * Usage:
 *   npx tsx scripts/add-client.ts
 *
 * Interactive prompts for all required fields.
 * Purchases a Twilio number, generates the system prompt, inserts into DB.
 *
 * Required env vars: DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 */

import readline from "readline";
import pg from "pg";
import { generateSystemPrompt, PromptParams } from "../src/system-prompt";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

async function purchaseTwilioNumber(areaCode: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  // 1. Search for available numbers
  const searchUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&SmsEnabled=true&Limit=1`;
  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!searchRes.ok) throw new Error(`Twilio search failed: ${searchRes.status}`);
  const searchData = await searchRes.json() as { available_phone_numbers: Array<{ phone_number: string }> };
  if (!searchData.available_phone_numbers.length) {
    throw new Error(`No numbers available in area code ${areaCode}`);
  }
  const number = searchData.available_phone_numbers[0].phone_number;

  // 2. Purchase the number
  const buyUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`;
  const buyRes = await fetch(buyUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ PhoneNumber: number }).toString(),
  });
  if (!buyRes.ok) throw new Error(`Twilio purchase failed: ${buyRes.status}`);

  // 3. Configure the number's webhook (voice URL)
  const buyData = await buyRes.json() as { sid: string };
  const webhookUrl = process.env.CADENCE_BASE_URL
    ? `${process.env.CADENCE_BASE_URL}/incoming-call`
    : null;

  if (webhookUrl) {
    const configUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${buyData.sid}.json`;
    await fetch(configUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        VoiceUrl: webhookUrl,
        VoiceMethod: "POST",
      }).toString(),
    });
  }

  return number;
}

async function main() {
  console.log("\n🎙️  Cadence — Add New Client\n");

  const businessName = await ask("Business name: ");
  const businessDescription = await ask("Business description (one line): ");
  const phoneNumber = await ask("Business phone number (for AI to reference): ");
  const website = await ask("Website URL: ");
  const hours = await ask("Hours of operation: ");
  const services = await ask("Services (paragraph): ");
  const faqs = await ask("FAQs (paragraph): ");
  const bookingInstructions = await ask("Booking instructions: ");
  const transferNumber = (await ask("Transfer number (E.164, or blank to skip): ")) || null;
  const smsBookingUrl = (await ask("Booking URL for SMS (or blank): ")) || null;
  const greeting = await ask("Greeting message (what AI says when answering): ");
  const ownerPhone = (await ask("Owner's phone for call summaries (E.164, or blank): ")) || null;
  const areaCode = await ask("Area code for new Twilio number: ");
  const plan = (await ask("Plan (trial/starter/growth) [trial]: ")) || "trial";
  const trialDays = plan === "trial" ? Number(await ask("Trial length in days [14]: ")) || 14 : 0;

  rl.close();

  // Generate system prompt
  const promptParams: PromptParams = {
    businessName,
    businessDescription,
    phoneNumber,
    website,
    hours,
    services,
    faqs,
    bookingInstructions,
    transferNumber,
    smsBookingUrl,
  };
  const systemPrompt = generateSystemPrompt(promptParams);

  // Purchase Twilio number
  console.log(`\n📞 Purchasing Twilio number in area code ${areaCode}...`);
  const twilioNumber = await purchaseTwilioNumber(areaCode);
  console.log(`✅ Acquired: ${twilioNumber}`);

  // Insert into database
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const trialEndsAt = trialDays > 0
    ? new Date(Date.now() + trialDays * 86400000).toISOString()
    : null;

  const result = await pool.query(
    `INSERT INTO clients (
      business_name, phone_number, system_prompt, transfer_number,
      greeting, sms_enabled, booking_url, owner_phone,
      plan, trial_ends_at, active
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id`,
    [
      businessName, twilioNumber, systemPrompt, transferNumber,
      greeting, !!smsBookingUrl, smsBookingUrl, ownerPhone,
      plan, trialEndsAt, true,
    ]
  );

  const clientId = result.rows[0].id;
  console.log(`\n✅ Client provisioned successfully!`);
  console.log(`   Client ID:    ${clientId}`);
  console.log(`   Phone Number: ${twilioNumber}`);
  console.log(`   Plan:         ${plan}${trialEndsAt ? ` (trial ends ${trialEndsAt})` : ""}`);
  console.log(`   Business:     ${businessName}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
```

### 9. `package.json` — MODIFY

Add new dependencies:

```json
{
  "dependencies": {
    "@deepgram/sdk": "^3.12.0",
    "express": "^4.21.2",
    "pg": "^8.13.0",
    "stripe": "^17.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.13.10",
    "@types/pg": "^8.11.0",
    "@types/ws": "^8.5.14",
    "tsx": "^4.19.0",
    "typescript": "^5.8.2"
  }
}
```

New deps: `pg`, `@types/pg`, `stripe`, `tsx` (for running the add-client script without compiling).

---

## Call Routing Flow (step by step)

```
1. Caller dials +16025551234

2. Twilio receives the call, hits POST /incoming-call
   Body includes: { To: "+16025551234", From: "+14805559999", ... }

3. Server queries: SELECT * FROM clients WHERE phone_number = '+16025551234'

4a. No client found →
    Return TwiML: <Say>This number is not currently active. Goodbye.</Say><Hangup/>

4b. Client found but active=false OR trial expired →
    Return TwiML: <Say>This service is currently unavailable.</Say><Hangup/>

4c. Client found and active →
    Return TwiML:
    <Response>
      <Connect>
        <Stream url="wss://cadence.up.railway.app/media-stream">
          <Parameter name="clientId" value="uuid-here" />
          <Parameter name="from" value="+14805559999" />
        </Stream>
      </Connect>
    </Response>

5. Twilio opens WebSocket to /media-stream, sends "start" event with customParameters

6. Server extracts clientId from start event, loads client row from DB

7. Creates CallHandler with client's systemPrompt, greeting, transferNumber, etc.

8. CallHandler.onStart() speaks the client's custom greeting via TTS

9. Call proceeds normally — STT → LLM (with client's system prompt) → TTS
   All SMS sent from client's own Twilio number.

10. On call end, summary SMS goes to client's owner_phone (if configured)
```

---

## Stripe Billing Flow (step by step)

```
1. Client signs up → Stripe customer created → stripe_customer_id saved to DB

2. Client subscribes to a plan → stripe_subscription_id saved to DB

3. Monthly invoice paid:
   Stripe sends "invoice.paid" webhook → /webhook/stripe
   → Look up client by stripe_customer_id
   → Set active = true (ensures reactivation after failed payment recovery)

4. Payment fails:
   Stripe sends "invoice.payment_failed" webhook → /webhook/stripe
   → Look up client by stripe_customer_id
   → Set active = false
   → Next incoming call gets: "This service is currently unavailable."

5. Subscription canceled:
   Stripe sends "customer.subscription.deleted" webhook → /webhook/stripe
   → Look up client by stripe_subscription_id
   → Set active = false

6. Trial enforcement (checked at call time, not via webhook):
   If client.plan === 'trial' AND trial_ends_at < now() AND no stripe_subscription_id
   → Treated as inactive at call routing time
```

**Stripe webhook setup (one-time):**
1. In Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://cadence.up.railway.app/webhook/stripe`
3. Events to listen for: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`
4. Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET` env var

---

## Provisioning Flow (step by step)

```
1. Run: npx tsx scripts/add-client.ts
   (requires DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN in env)

2. Answer interactive prompts:
   - Business name, description, hours, services, FAQs
   - Transfer number, greeting, owner phone
   - Area code for Twilio number
   - Plan selection (trial/starter/growth)

3. Script generates the full system prompt from template

4. Script calls Twilio API:
   - Searches for available number in the given area code
   - Purchases the number
   - Configures the number's voice webhook URL to point to /incoming-call
     (if CADENCE_BASE_URL env var is set)

5. Script inserts client row into Neon Postgres

6. Output: client ID + assigned phone number

7. Client is immediately live — next call to that number gets their AI receptionist
```

---

## Migration Path (existing DVDS client)

The existing DVDS deployment should become the first client row in the database. Steps:

1. Run the schema migration (`sql/001-clients.sql`)
2. Run `add-client.ts` with DVDS's details (or insert manually)
3. The existing Twilio number for DVDS becomes `phone_number` in their client row
4. The existing hardcoded system prompt in `system-prompt.ts` becomes the `system_prompt` column value
5. Deploy the updated code
6. Remove the old `TWILIO_SMS_NUMBER` and `AUSTEN_CELL_NUMBER` env vars once confirmed working

No downtime needed — the old single-tenant code can run until the new code is deployed and the DVDS client row exists.

---

## What's NOT In This Blueprint (intentionally)

- **No auth UI / dashboard** — admin CLI only for now. Dashboard comes later.
- **No per-client LLM model selection** — all clients use the same Groq → OpenAI fallback. Can be added as a column later if needed.
- **No per-client TTS voice selection** — all clients use Aura 2 Thalia. Easy to add as a column later.
- **No rate limiting** — Railway handles DDoS at the infrastructure level. Per-client call limits can come with the dashboard.
- **No call logging to DB** — call summaries still go via SMS. Structured call logging is a dashboard feature.
- **No Stripe Checkout / subscription creation** — this blueprint only handles the webhook side (enforcement). Client onboarding and checkout flow is a separate piece of work.

---

## Risk Callouts

1. **DB as single point of failure.** Every incoming call does a DB query. Neon has good uptime but if it's unreachable, all calls fail. Mitigation: add a simple in-memory LRU cache (keyed by phone number, 5-minute TTL) in a future iteration. Not worth the complexity now with low client count.

2. **Twilio number webhook configuration.** Each purchased number must have its voice webhook pointed at the Cadence deployment URL. The provisioning script does this if `CADENCE_BASE_URL` is set. If it's not set, the number must be configured manually in the Twilio console.

3. **System prompt size.** Postgres `TEXT` has no practical limit, but very long system prompts will increase LLM token usage and cost. The template keeps prompts reasonable, but there's no enforcement. Consider adding a character limit in the provisioning script (e.g., 8000 chars max).

4. **Stripe webhook ordering.** Stripe doesn't guarantee event ordering. An `invoice.paid` event could arrive after a `customer.subscription.deleted` event for the same billing cycle. The current logic is idempotent (last write wins on the `active` flag), which is fine — the final state will be correct after all events are processed.
