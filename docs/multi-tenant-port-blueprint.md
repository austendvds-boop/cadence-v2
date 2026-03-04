# Multi-Tenant Port Blueprint: cadence (Render) → cadence-v2 (Railway)

**Generated:** 2026-03-04  
**Purpose:** Port enterprise features from cadence onto the cadence-v2 golden voice base without touching the voice engine.  
**Rule:** If it's in the voice engine boundary section → it is untouchable. Everything else is fair game.

---

## Table of Contents

1. [Voice Engine Boundary — DO NOT TOUCH](#1-voice-engine-boundary--do-not-touch)
2. [What cadence-v2 Already Has](#2-what-cadence-v2-already-has)
3. [Enterprise Feature Inventory (cadence → port targets)](#3-enterprise-feature-inventory-cadence--port-targets)
4. [Safe Port Plan — Feature by Feature](#4-safe-port-plan--feature-by-feature)
5. [Execution Order](#5-execution-order)
6. [DB Schema Plan](#6-db-schema-plan)
7. [Environment Variables](#7-environment-variables)
8. [Testing Gates (Voice Quality Verification)](#8-testing-gates-voice-quality-verification)

---

## 1. Voice Engine Boundary — DO NOT TOUCH

These files and functions constitute the voice engine. **Zero modifications permitted.** Any coder touching these files has violated the spec.

### Protected Files

| File | What It Does |
|------|-------------|
| `src/stt.ts` | Deepgram SDK STT — nova-2, mulaw 8kHz, UtteranceEnd endpointing |
| `src/tts.ts` | Deepgram Aura WebSocket TTS — aura-2-thalia-en, mulaw 8kHz streaming |
| `src/call-handler.ts` | CallHandler class — full call lifecycle: barge-in via `isSpeaking` flag, transcript → LLM → TTS pipeline |
| `src/llm.ts` | Groq primary + OpenAI fallback chat completion |
| `src/sms.ts` | sendBookingLink, sendCallSummary (called by CallHandler) |

### Protected Contracts

The `ClientConfig` interface in `call-handler.ts` is the **sole integration seam** between the voice engine and the rest of the system. It is the only approved way to pass data into a call:

```typescript
export interface ClientConfig {
  clientId: string;
  businessName: string;
  systemPrompt: string;
  transferNumber: string | null;
  greeting: string;
  smsEnabled: boolean;
  bookingUrl: string | null;
  ownerPhone: string | null;
  twilioNumber: string;
}
```

### Protected Code Blocks in `src/index.ts`

The WebSocket server block (`wss.on('connection', ...)`) is voice-engine wiring. The ONLY permitted modification to it is passing additional fields to `new CallHandler(ws, {...})` when the DB schema gains new columns. No logic changes to the message handling loop.

### Protected Code Blocks in `src/db.ts`

The `getClientByPhone` and `getClientById` functions are used by the voice path. Column additions to the DB `Client` interface are safe; no query logic changes.

### Why cadence's voice is broken

cadence (Render) replaced `@deepgram/sdk` with a raw WebSocket connection in `src/stt/deepgram.ts` to work around Render's infrastructure. This degraded STT quality and barge-in reliability. cadence-v2 uses the SDK correctly. This must never be replicated.

---

## 2. What cadence-v2 Already Has

Do not re-implement these — they exist in cadence-v2 and just need schema/config upgrades.

| Feature | Files |
|---------|-------|
| DB-backed multi-tenant call routing | `src/index.ts` → `getClientByPhone(toNumber)` |
| Client model with Stripe fields, active flag, trial/starter/growth plan | `src/db.ts` (Client interface) |
| Onboarding flow (start → checkout → provision) | `src/onboarding.ts` |
| Stripe webhooks: checkout.completed, invoice.paid/failed, subscription.deleted | `src/stripe.ts` |
| Twilio number provisioning (area code fallbacks) | `src/twilio-numbers.ts` |
| System prompt generation | `src/prompt-template.ts` |
| Audit log | `src/audit.ts` |
| Basic SQL schema | `sql/001-clients.sql`, `sql/002-onboarding.sql` |

---

## 3. Enterprise Feature Inventory (cadence → port targets)

All features below exist in cadence and are **absent** from cadence-v2.

### Feature 1: Magic Link Auth System
**cadence files:** `src/api/auth.ts`, `src/middleware/auth.ts`  
**What it does:** JWT-based magic link email login. POST /api/auth/magic-link sends link, GET /api/auth/verify validates + sets httpOnly cookie. requireAuth / requirePageAuth / requireAdmin middleware guards all protected routes.

### Feature 2: Admin Panel (server-rendered HTML)
**cadence files:** `src/api/admin.ts`, `src/api/ui-shell.ts`, `public/cadence-ui.css`  
**What it does:** GET /admin — client roster with stats (total, active, trial, past_due, canceled), status filter, CSV export. GET /admin/client/:id — full client editor (all fields, model overrides, system prompt, tools). Load-more call log. Admin-only behind requireAdmin middleware.

### Feature 3: Client Dashboard (server-rendered HTML)
**cadence files:** `src/api/dashboard.ts`, `src/api/ui-shell.ts`  
**What it does:** GET /dashboard — client's own view: subscription status, Cadence number, trial end date, monthly call count, call log, self-service settings forms (transfer number, greeting, hours, FAQs), billing portal link.

### Feature 4: Client Self-Service API
**cadence files:** `src/api/clients.ts`  
**What it does:** PATCH /api/clients/:id — clients can update transfer_number, greeting, hours, faqs. GET /api/clients/:id/billing-portal — redirects to Stripe billing portal. Authorization: client can only edit their own record.

### Feature 5: Admin API
**cadence files:** `src/api/admin.ts`, `src/api/clients.ts`  
**What it does:** GET /api/admin/clients — list all clients with status filter. GET /api/admin/export — CSV export. PATCH /api/admin/clients/:id — admin can update all fields (business name, owner info, system_prompt, tts_model, stt_model, llm_model, tools_allowed, subscription_status, Twilio number, Stripe IDs).

### Feature 6: Call Logs API
**cadence files:** `src/api/calls.ts`  
**What it does:** GET /api/clients/:id/calls?limit=&offset= — paginated call log. POST /api/call-status — Twilio call status webhook for duration tracking (updates `duration_seconds` on call record when call completes).

### Feature 7: Tenant Routing Cache
**cadence files:** `src/config/tenant-routing.ts`  
**What it does:** In-memory cache keyed by normalized Twilio number, 5-min TTL. `resolveTenantForIncomingNumber(toNumber)` → checks cache → falls back to DB. `invalidateTenantCacheByTwilioNumber()` called after any client update. Prevents a DB query on every audio frame.

### Feature 8: TenantConfig Object (per-tenant model overrides)
**cadence files:** `src/config/tenants.ts`  
**What it does:** `TenantConfig` struct with `ttsModel`, `sttModel` fields that flow into the voice engine. In cadence, these override Deepgram model per client. **In cadence-v2 this is partially relevant** — the current stt.ts/tts.ts hardcode the model. If per-tenant model selection is desired later, these fields exist in the DB after the schema migration, ready to use.

### Feature 9: Enhanced Stripe Billing
**cadence files:** `src/api/stripe.ts`  
**What it does over cadence-v2's current stripe.ts:**
- `subscriptions` table with full period tracking (trial_start, trial_end, current_period_start/end, cancel_at_period_end, last_payment_error)
- `stripe_events` dedup table (vs cadence-v2's `processed_stripe_events` — functionally identical, just renamed)
- `customer.subscription.created` + `customer.subscription.updated` handlers — upsert subscription record
- `customer.subscription.deleted` — releases Twilio number, sends churn SMS to owner, sends churn alert email to admin
- `invoice.payment_failed` — only deactivates after retries exhausted (checks `next_payment_attempt`)
- Grandfathered client protection — never deactivates clients without a Stripe subscription
- Protected Twilio number handling — never releases DVDS/core numbers
- POST /api/provision — manual provision trigger (useful for admin)
- POST /api/stripe/checkout — creates Stripe checkout session and bootstraps client record

### Feature 10: Twilio Number Management (Provisioning + Release)
**cadence files:** `src/twilio/provisioning.ts`  
**What it does over cadence-v2's twilio-numbers.ts:**
- `isProtectedTwilioPhoneNumber()` — guards DVDS number from accidental release
- `releaseNumber(sid)` — releases number on churn
- `provisionIncomingNumber()` with graceful area code fallback (same logic as cadence-v2 but also handles already-provisioned clients)

### Feature 11: Richer Client Schema (hours, faqs, area_code, model overrides)
**cadence files:** `db/migrations/001_init_schema.sql`, `db/migrations/007_add_tenant_baseline_metadata.sql`  
**What it does:** Adds `hours JSONB`, `faqs JSONB`, `area_code TEXT`, `tts_model`, `stt_model`, `llm_model`, `tools_allowed TEXT[]`, `grandfathered BOOLEAN`, `tenant_key TEXT`, `bootstrap_state` to clients table. Adds `subscriptions` table, `stripe_events` table, `call_logs` table, `magic_link_tokens` table.

### Feature 12: Call Log Persistence (call_logs table)
**cadence files:** `src/db/queries.ts` (upsertCallLog, logCall, getCallLogsPage, updateCallDurationBySid)  
**What it does:** Persists every call with callSid, callerNumber, durationSeconds, transcriptSummary, toolCalls. cadence-v2's websocket close handler already calls `upsertCallLog` — it just needs the `call_logs` table to exist in the DB.

### Feature 13: UI Shell (shared HTML components)
**cadence files:** `src/api/ui-shell.ts`, `public/cadence-ui.css`  
**What it does:** renderAppShell(), escapeHtml(), statusBadgeClass() — shared layout shell for all server-rendered pages. The CSS lives in public/ and is served as static files.

### Feature 14: Cookie-Parser Middleware
**cadence files:** `src/index.ts` (cookie-parser import)  
**What it does:** Parses `cadence_token` cookie for session auth. Must be added to cadence-v2's express app before auth middleware runs.

---

## 4. Safe Port Plan — Feature by Feature

### Batch A: DB Schema Migration (Risk: LOW — DB only, zero voice impact)

**Files to CREATE:**
- `sql/003-enterprise-schema.sql` — single idempotent migration covering all additions

**Columns to add to existing `clients` table (all `IF NOT EXISTS`):**
```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS area_code TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS hours JSONB NOT NULL DEFAULT '{}';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS faqs JSONB NOT NULL DEFAULT '[]';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tts_model TEXT NOT NULL DEFAULT 'aura-2-thalia-en';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stt_model TEXT NOT NULL DEFAULT 'nova-2';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS llm_model TEXT NOT NULL DEFAULT 'gpt-4o-mini';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tools_allowed TEXT[] NOT NULL DEFAULT ARRAY['transfer_to_human','send_sms'];
ALTER TABLE clients ADD COLUMN IF NOT EXISTS grandfathered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_key TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS bootstrap_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'trial'
  CHECK (subscription_status IN ('pending','trial','active','past_due','canceled'));
```

**New tables to CREATE:**
```sql
-- call_logs
CREATE TABLE IF NOT EXISTS call_logs (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  call_sid TEXT NOT NULL UNIQUE,
  caller_number TEXT,
  duration_seconds INTEGER,
  transcript_summary TEXT,
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_logs_client_created ON call_logs (client_id, created_at DESC);

-- subscriptions (full billing period tracking)
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  status TEXT NOT NULL,
  trial_start TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  last_payment_error TEXT,
  last_invoice_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- stripe_events dedup (rename from processed_stripe_events for consistency)
-- Keep processed_stripe_events, just add stripe_events as alias or use existing
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- magic_link_tokens
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_magic_link_token_hash ON magic_link_tokens (token_hash);
```

**DB client interface changes in `src/db.ts`:**  
Update the `Client` interface to include the new columns. This is **not** a voice engine change — `db.ts` is a data access file, not part of the call path itself. The `getClientByPhone` query already does `SELECT *` so new columns flow through automatically.

**Integration point:** Update the `ClientConfig` block in `src/index.ts` to pass `client.tts_model` etc. This is a one-line-per-field addition to the existing constructor call — no logic changes.

---

### Batch B: Tenant Routing Cache (Risk: LOW — replaces direct DB call, same result)

**Files to CREATE:**
- `src/tenant-routing.ts` — copy of cadence's `src/config/tenant-routing.ts`, adapted for cadence-v2's `Client` type

**Integration point in `src/index.ts`:**
Replace `const client = await getClientByPhone(toNumber)` in `/incoming-call` handler with a call to `resolveTenantForIncomingNumber(toNumber)`. This is a drop-in replacement returning the same data — it just adds a cache layer. The WebSocket handler already fetches by clientId separately, so no change there.

Export `invalidateTenantCacheByTwilioNumber` from `src/tenant-routing.ts` for use by the admin/client PATCH APIs.

---

### Batch C: Auth System (Risk: ZERO — new routes only)

**Files to CREATE:**
- `src/middleware/auth.ts` — requireAuth, requirePageAuth, requireAdmin, AuthenticatedRequest type
- `src/api/auth.ts` — renderLoginPage, handleMagicLinkRequest, handleMagicLinkVerify

**New npm packages needed:**
- `jsonwebtoken` + `@types/jsonwebtoken`
- `nodemailer` + `@types/nodemailer`
- `cookie-parser` + `@types/cookie-parser`

**Integration point in `src/index.ts`:**
Add `app.use(cookieParser())` before route definitions.
Add auth routes:
```typescript
app.post('/api/auth/magic-link', handleMagicLinkRequest);
app.get('/api/auth/verify', handleMagicLinkVerify);
app.get('/login', renderLoginPage);
```

No changes to voice path whatsoever.

---

### Batch D: UI Shell + CSS (Risk: ZERO — static files + utility functions)

**Files to CREATE:**
- `src/api/ui-shell.ts` — renderAppShell, escapeHtml, statusBadgeClass
- `public/cadence-ui.css` — copy from cadence's public/

**Integration point:** None required beyond importing from ui-shell.ts in dashboard/admin files.

---

### Batch E: Client Dashboard + Self-Service API (Risk: ZERO — new routes only)

**Files to CREATE:**
- `src/api/dashboard.ts` — renderDashboard (server-rendered HTML)
- `src/api/clients.ts` — handlePatchOwnClient, handleClientBillingPortal, getAuthenticatedClient
- `src/api/calls.ts` — handleClientCallsList

**New DB queries needed in `src/db.ts`:**
- `getSubscriptionByClientId(clientId)` — reads from subscriptions table
- `getCallLogsPage(clientId, {limit, offset})` — paginated call log
- `updateCallDurationBySid(callSid, seconds)` — updates duration on call record

**Integration point in `src/index.ts`:**
```typescript
app.get('/dashboard', requirePageAuth, renderDashboard);
app.patch('/api/clients/:id', requireAuth, handlePatchOwnClient);
app.get('/api/clients/:id/calls', requireAuth, handleClientCallsList);
app.get('/api/clients/:id/billing-portal', requireAuth, handleClientBillingPortal);
```

---

### Batch F: Admin Panel + Admin API (Risk: ZERO — new routes only)

**Files to CREATE:**
- `src/api/admin.ts` — renderAdmin, renderAdminClient, handleAdminClientsList, handleAdminClientsExport, handlePatchAdminClient

**New DB queries needed in `src/db.ts`:**
- `listAllClients({status?})` — all clients with optional status filter
- `getClientStats()` — aggregate counts by status + today's calls
- `updateClient(clientId, input)` — update arbitrary fields

**Integration point in `src/index.ts`:**
```typescript
app.get('/admin', requirePageAuth, requireAdmin, renderAdmin);
app.get('/admin/client/:id', requirePageAuth, requireAdmin, renderAdminClient);
app.get('/api/admin/clients', requireAuth, requireAdmin, handleAdminClientsList);
app.get('/api/admin/export', requireAuth, requireAdmin, handleAdminClientsExport);
app.patch('/api/admin/clients/:id', requireAuth, requireAdmin, handlePatchAdminClient);
```

---

### Batch G: Call Status Webhook (Risk: ZERO — new route only)

**Files to CREATE:**
- Add `handleTwilioCallStatus` to `src/api/calls.ts`

**Integration point in `src/index.ts`:**
```typescript
app.post('/api/call-status', handleTwilioCallStatus);
```

This also needs `upsertCallLog` and `updateCallDurationBySid` in `src/db.ts` (already planned in Batch E).

---

### Batch H: Enhanced Stripe Billing (Risk: LOW — upgrades stripe.ts logic, no voice path)

**Files to MODIFY (not voice engine):**
- `src/stripe.ts` — the existing file already handles webhooks but is missing subscription tracking, churn handling, number release

**Additions to `src/stripe.ts`:**
- `upsertSubscription(input)` — writes to subscriptions table
- Handle `customer.subscription.created` + `customer.subscription.updated` — upsert subscription, provision number if active/trial
- Handle `customer.subscription.deleted` — release Twilio number, deactivate client, send churn SMS, admin email
- Enhanced `invoice.payment_failed` — check `next_payment_attempt` before deactivating (don't deactivate on first failed attempt)
- `shouldSkipChurnDeactivation()` — guard for grandfathered clients
- `isProtectedTwilioPhoneNumber()` — guard for DVDS core number

**New route in `src/index.ts`:**
```typescript
app.post('/api/provision', handleProvisionRequest); // manual provision trigger
app.post('/api/stripe/checkout', handleStripeCheckout); // create checkout session
```

**Note:** cadence-v2's existing `stripe.ts` webhook handler processes `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`. The enhanced version is a superset of this — same events plus more granular subscription tracking. When replacing, be careful to **keep** the `runProvisioningForOnboarding` call on `checkout.session.completed` that triggers the onboarding provisioning pipeline.

---

### Batch I: Twilio Provisioning Upgrade (Risk: LOW — used only in provisioning and churn flows)

**Files to MODIFY (not voice engine):**
- `src/twilio-numbers.ts` — add `isProtectedTwilioPhoneNumber()` and `releaseNumber(sid)`

The existing `purchaseAndConfigureTwilioNumber` logic stays unchanged. Additions only.

---

## 5. Execution Order

```
Batch A: DB Schema Migration        (no code deps)
    ↓
Batch B: Tenant Routing Cache       (depends on: db.ts Client interface from A)
    ↓
Batch C: Auth System                (depends on: nothing except npm packages)
    ↓
Batch D: UI Shell + CSS             (depends on: nothing)
    ↓  ↓
Batch E: Client Dashboard + API     (depends on: C auth middleware, D ui-shell, A call_logs table)
Batch F: Admin Panel + Admin API    (depends on: C auth middleware, D ui-shell, A schema)
    ↓
Batch G: Call Status Webhook        (depends on: A call_logs table, E upsertCallLog in db.ts)
    ↓
Batch H: Enhanced Stripe Billing    (depends on: A subscriptions table, I provisioning)
    ↓
Batch I: Twilio Provisioning Upgrade (depends on: nothing — additive to existing file)
```

**Parallelism:** Batches E and F can run in parallel since they touch different files. All others are strictly sequential.

**Recommended batching for coder tasks:**
1. **Coder task 1:** Batch A (DB schema migration only — run `sql/003-enterprise-schema.sql` against Railway Postgres)
2. **Coder task 2:** Batches B + C + D (tenant cache + auth + UI shell — foundational infrastructure)
3. **Coder task 3:** Batches E + F + G (all API/UI routes — pure additions, no conflicts)
4. **Coder task 4:** Batches H + I (billing + provisioning upgrade — most logic-dense)

---

## 6. DB Schema Plan

### cadence-v2 current `clients` columns → what needs adding

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `area_code` | TEXT | null | Preferred Twilio area code |
| `hours` | JSONB | `{}` | Business hours for system prompt |
| `faqs` | JSONB | `[]` | FAQs for system prompt |
| `tts_model` | TEXT | `aura-2-thalia-en` | Per-tenant TTS model override |
| `stt_model` | TEXT | `nova-2` | Per-tenant STT model override |
| `llm_model` | TEXT | `gpt-4o-mini` | Per-tenant LLM model override |
| `tools_allowed` | TEXT[] | `{transfer_to_human,send_sms}` | Allowed tools list |
| `grandfathered` | BOOLEAN | false | Skip churn deactivation |
| `tenant_key` | TEXT | null | Core tenant alias (e.g., 'dvds') |
| `bootstrap_state` | TEXT | `active` | Provisioning state machine |
| `subscription_status` | TEXT | `trial` | Replace `active` boolean with status |

**Important:** cadence-v2 currently has `active BOOLEAN` and `plan TEXT`. cadence uses `subscription_status TEXT` as the single status field. During migration, either:
- Keep both (`active` + `subscription_status`) with `subscription_status` being the source of truth going forward, or
- Migrate: `UPDATE clients SET subscription_status = CASE WHEN active THEN plan ELSE 'canceled' END`

The recommended approach: keep `active` for backward compatibility with existing voice path code (`if (!client.active || isTrialExpired(client))`) and add `subscription_status` as the new field used by admin/dashboard/billing. Both columns serve different code paths.

### New tables summary

| Table | Purpose | Key FK |
|-------|---------|--------|
| `call_logs` | Per-call record with transcript summary | `client_id` → clients |
| `subscriptions` | Full Stripe subscription period tracking | `client_id` → clients (UNIQUE) |
| `stripe_events` | Idempotency dedup for Stripe webhooks | none |
| `magic_link_tokens` | (Optional) Store tokens for revocation | none |

**Note:** cadence-v2 already has `processed_stripe_events` for Stripe dedup. The cadence repo uses `stripe_events`. Either rename or use existing — functionally identical. Recommend keeping `processed_stripe_events` to avoid migration risk.

---

## 7. Environment Variables

### Already in cadence-v2 Railway (from `.env.example`)

| Variable | Type | Notes |
|----------|------|-------|
| `DATABASE_URL` | SECRET | Railway Postgres connection string |
| `DEEPGRAM_API_KEY` | SECRET | Used by stt.ts and tts.ts |
| `TWILIO_ACCOUNT_SID` | SECRET | Twilio account |
| `TWILIO_AUTH_TOKEN` | SECRET | Twilio auth |
| `TWILIO_WEBSOCKET_URL` | PUBLIC | WebSocket URL for Twilio stream |
| `STRIPE_SECRET_KEY` | SECRET | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | SECRET | Stripe webhook signature |
| `STRIPE_PRICE_ID` | PUBLIC | Stripe subscription price ID |
| `GROQ_API_KEY` | SECRET | Groq LLM |
| `OPENAI_API_KEY` | SECRET | OpenAI fallback LLM |
| `PORT` | PUBLIC | Server port (Railway sets this) |
| `CADENCE_BASE_URL` | PUBLIC | Base URL for Twilio voice webhook config |
| `ONBOARDING_SUCCESS_URL` | PUBLIC | Redirect after successful checkout |
| `ONBOARDING_CANCEL_URL` | PUBLIC | Redirect on checkout cancel |

### New — need to add to Railway

| Variable | Type | Secret? | Description |
|----------|------|---------|-------------|
| `JWT_SECRET` | SECRET | ✅ | Long random string for JWT signing. Generate with `openssl rand -hex 64`. |
| `BASE_URL` | PUBLIC | ❌ | `https://cadence-v2.up.railway.app` — used in magic links and Stripe checkout URLs |
| `ADMIN_EMAIL` | PUBLIC | ❌ | `aust@autom8everything.com` — the admin account email |
| `SMTP_HOST` | PUBLIC | ❌ | `smtp.gmail.com` |
| `SMTP_PORT` | PUBLIC | ❌ | `587` |
| `SMTP_USER` | SECRET | ✅ | Gmail address for sending magic links |
| `SMTP_PASS` | SECRET | ✅ | Gmail App Password (not regular password) — see credentials/gmail-autom8.txt |
| `SMTP_FROM` | PUBLIC | ❌ | Display from address, e.g. `Cadence <noreply@autom8everything.com>` |
| `STRIPE_CHECKOUT_SUCCESS_URL` | PUBLIC | ❌ | Where to redirect after checkout success |
| `STRIPE_CHECKOUT_CANCEL_URL` | PUBLIC | ❌ | Where to redirect on checkout cancel |
| `TWILIO_SMS_NUMBER` | PUBLIC | ❌ | Twilio number used for system-level SMS (churn notices, welcome SMS). Can be same as DVDS number or a dedicated number. |

### Variables in cadence not needed in cadence-v2

| Variable | Why skipped |
|----------|-------------|
| `BASELINE_VERSION_CURRENT` | cadence's baseline/tenantKey system — skip unless bootstrap system is ported |
| `UTTERANCE_END_MS` | cadence-v2 hardcodes 1000ms in stt.ts — don't configure |
| `ENDPOINTING_MS` | cadence-v2 doesn't use this — its voice engine handles endpointing via UtteranceEnd |
| `MAX_HISTORY_MESSAGES` | cadence-v2 doesn't limit history in llm.ts — skip |
| `LOG_LEVEL` | cadence-v2 uses console.log directly — no pino logger |

---

## 8. Testing Gates (Voice Quality Verification)

**After every coder batch, before marking complete, run this exact test:**

### The 928 Voice Quality Test

1. Call the Cadence 928 number
2. Let the greeting play fully
3. Start talking while Cadence is mid-sentence (barge-in test)
   - **Pass:** Cadence stops speaking immediately, listens
   - **Fail:** Cadence keeps talking, or there's a delay, or audio is doubled
4. Have a 30-second conversation — ask about pricing, hours, and booking
   - **Pass:** Responses are coherent, no garbled audio, no echo
   - **Fail:** Stuttering, echo, repeated words, or very long delays before response
5. Talk again while Cadence is responding (second barge-in test)
   - **Pass:** Clean interrupt, immediate silence
   - **Fail:** Any overlap, echo, or audio artifact

### Gate Criteria

| Gate | Requirement |
|------|------------|
| Barge-in latency | < 300ms from when caller speaks to when Cadence audio stops |
| TTS quality | Clean Aura voice, no artifacts, no echo |
| STT accuracy | Can transcribe a 10-word sentence correctly 90%+ of the time |
| Response latency | First word of Cadence response within 2 seconds of caller finishing |
| No regression | Any failure here means the batch caused a regression — roll back and investigate |

### Batch-Specific Verification

| After Batch | Additional Checks |
|-------------|-------------------|
| A (DB schema) | Call the 928 number and confirm existing voice flow still works. No schema migration should break anything because we're adding columns, not modifying existing ones. |
| B (Tenant cache) | Confirm `/incoming-call` still routes correctly by calling 928 twice in quick succession — second call should hit cache. |
| C-D (Auth + UI) | Hit `/login` in browser — see the magic link form. Voice test should still pass (these routes don't touch call path). |
| E-F (Dashboard + Admin) | Log in as admin, view client list, view DVDS client record. Voice test required after every batch. |
| G (Call status webhook) | After a 928 call, check DB `call_logs` table — should have a row with duration_seconds populated. |
| H (Stripe upgrade) | Test with Stripe test mode webhook: send a `customer.subscription.deleted` event — confirm client is deactivated and Twilio number is released (test client, not DVDS). |
| I (Provisioning) | Confirm `isProtectedTwilioPhoneNumber` returns true for the DVDS number. Manual provision of a test client should succeed. |

### Rollback Trigger

If any test after a batch shows barge-in broken, audio echo, STT failure, or > 3s response latency:
1. Git revert the batch commit
2. Check if any voice engine files were modified (should be zero)
3. Check if `src/index.ts` WS block was changed (only permitted change: ClientConfig constructor fields)
4. The DB schema additions are non-reversible but also can't cause voice issues — focus on code changes

---

## Appendix: File Diff Summary (cadence-v2 after porting)

### New files to create

```
src/tenant-routing.ts
src/middleware/auth.ts
src/api/auth.ts
src/api/ui-shell.ts
src/api/dashboard.ts
src/api/clients.ts
src/api/calls.ts
src/api/admin.ts
public/cadence-ui.css
sql/003-enterprise-schema.sql
```

### Files to modify (non-voice engine)

```
src/index.ts        — add routes, cookie-parser, richer ClientConfig fields
src/db.ts           — add new columns to Client interface, add new query functions
src/stripe.ts       — add subscription tracking, churn handling, enhanced webhook handlers
src/twilio-numbers.ts — add isProtectedTwilioPhoneNumber(), releaseNumber()
package.json        — add jsonwebtoken, nodemailer, cookie-parser + @types
```

### Files that must NOT be modified

```
src/stt.ts          ← VOICE ENGINE — LOCKED
src/tts.ts          ← VOICE ENGINE — LOCKED
src/call-handler.ts ← VOICE ENGINE — LOCKED
src/llm.ts          ← VOICE ENGINE — LOCKED
src/sms.ts          ← VOICE ENGINE — LOCKED
```

---

*Blueprint complete. Any coder executing these batches should read this document first, implement only what's described, and run the 928 voice test after every batch before reporting completion.*
