# Cadence SaaS Onboarding Blueprint

> End-to-end self-service onboarding, checkout, provisioning, and billing lifecycle for Cadence AI Receptionist under the Autom8 Everything umbrella.

**Status:** Architecture only — no code in this document.
**Date:** 2026-03-03
**Depends on:** `multi-tenant-blueprint.md` (implemented), existing `clients` table, existing Stripe webhook handler.

---

## Executive Summary

Today, Cadence onboards clients manually via CLI (`scripts/add-client.ts`). This blueprint adds a self-service flow: a prospect fills out an onboarding wizard on autom8everything.com, goes through Stripe Checkout ($199/mo, 7-day trial), and on successful checkout the system automatically provisions their Twilio number, generates their AI prompt, inserts their client row, and sends welcome instructions. The billing lifecycle hooks (already partially implemented) are extended to handle number retention/release policy.

The architecture adds three new components: (1) onboarding API endpoints on the Cadence backend, (2) a frontend wizard (static or embedded on autom8everything.com), and (3) an async provisioning pipeline triggered by Stripe's `checkout.session.completed` webhook.

---

## 1. System Architecture

### Components

```
┌─────────────────────────────────────────────────────┐
│               autom8everything.com                   │
│                                                      │
│  ┌──────────────────────────────┐                    │
│  │   Onboarding Wizard (React)  │                    │
│  │   /cadence/get-started       │                    │
│  └─────────────┬────────────────┘                    │
│                │                                     │
└────────────────┼─────────────────────────────────────┘
                 │ POST /api/onboarding/start
                 │ POST /api/onboarding/checkout
                 ▼
┌─────────────────────────────────────────────────────┐
│          Cadence v2 Backend (Railway)                │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Onboarding   │  │ Stripe       │  │ Provision  │ │
│  │ API          │  │ Webhook      │  │ Pipeline   │ │
│  │ /api/onboard │  │ /webhook/    │  │ (async)    │ │
│  │              │  │ stripe       │  │            │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                 │        │
│         ▼                 ▼                 ▼        │
│  ┌─────────────────────────────────────────────────┐ │
│  │              Neon Postgres                      │ │
│  │   clients | onboarding_sessions | audit_log     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  Existing: call routing, STT/LLM/TTS pipeline        │
└─────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
   ┌──────────┐        ┌──────────┐
   │  Twilio  │        │  Stripe  │
   │  API     │        │  API     │
   └──────────┘        └──────────┘
```

### Data Flow (happy path)

```
1. Prospect visits autom8everything.com/cadence/get-started
2. Fills out 4-step wizard (business info, hours, services, preferences)
3. Frontend POSTs answers → POST /api/onboarding/start
4. Backend stores answers in onboarding_sessions table, returns session_id
5. Frontend POSTs session_id → POST /api/onboarding/checkout
6. Backend creates Stripe Checkout Session ($199/mo, 7-day trial)
   - metadata: { onboarding_session_id: "<uuid>" }
   - Returns checkout URL
7. Frontend redirects to Stripe Checkout
8. Customer completes payment → Stripe fires checkout.session.completed webhook
9. Backend receives webhook → extracts onboarding_session_id from metadata
10. Provisioning pipeline runs (async, idempotent):
    a. Buy Twilio number (area-code aware)
    b. Generate system prompt from onboarding answers
    c. Insert client row in clients table
    d. Configure Twilio number webhook
    e. Update onboarding_session status → "provisioned"
    f. Send welcome email/SMS with number + instructions
11. Client is live — calls to their new number get their AI receptionist
```

---

## 2. API Contract List

### 2a. `POST /api/onboarding/start`

Saves onboarding wizard answers. No auth required (public endpoint — prospect hasn't paid yet).

**Request:**
```json
{
  "business_name": "Phoenix Auto Repair",
  "business_description": "Full-service auto repair shop serving the Valley since 2005",
  "phone_number": "+16025551234",
  "website": "https://phoenixautorepair.com",
  "hours": "Monday through Friday 7 AM to 6 PM, Saturday 8 AM to 2 PM",
  "services": "Oil changes, brake repair, engine diagnostics, tire rotation...",
  "faqs": "Do you work on all makes? Yes. Do you offer financing? Yes via...",
  "booking_instructions": "Book online at our website or call us directly",
  "transfer_number": "+16025559999",
  "booking_url": "https://phoenixautorepair.com/book",
  "greeting": "Thanks for calling Phoenix Auto Repair. How can I help you today?",
  "owner_name": "Mike Chen",
  "owner_email": "mike@phoenixautorepair.com",
  "owner_phone": "+16025558888",
  "preferred_area_code": "602"
}
```

**Response (201):**
```json
{
  "session_id": "uuid-here",
  "status": "pending_checkout"
}
```

**Validation:**
- `business_name`: required, 2-200 chars
- `owner_email`: required, valid email format
- `owner_phone`: required, E.164 format
- `preferred_area_code`: required, 3-digit US area code
- All other text fields: required, 1-5000 chars
- `transfer_number`: optional, E.164 if provided
- `booking_url`: optional, valid URL if provided

**Rate limiting:** 10 requests per IP per hour (prevent spam provisioning).

### 2b. `POST /api/onboarding/checkout`

Creates a Stripe Checkout Session for a given onboarding session.

**Request:**
```json
{
  "session_id": "uuid-here"
}
```

**Response (200):**
```json
{
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_live_..."
}
```

**Errors:**
- `404` — session not found or already provisioned
- `409` — checkout session already created for this onboarding session (returns existing URL if still valid)

**Auth:** None (public). The session_id is a UUID — unguessable.

### 2c. `GET /api/onboarding/status/:session_id`

Polling endpoint for the frontend to check provisioning status after checkout.

**Response (200):**
```json
{
  "session_id": "uuid-here",
  "status": "provisioned",
  "phone_number": "+16025551234",
  "business_name": "Phoenix Auto Repair"
}
```

**Status values:** `pending_checkout` → `checkout_complete` → `provisioning` → `provisioned` → `failed`

**Auth:** None. Session ID is the auth token (UUID, unguessable).

### 2d. `POST /webhook/stripe` (existing, extended)

Already handles `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`.

**New event:** `checkout.session.completed`
- Extracts `onboarding_session_id` from session metadata
- Triggers provisioning pipeline

**Idempotency:** Handled via `onboarding_sessions.status` + `stripe_checkout_session_id` dedup (see §4).

### 2e. `POST /api/admin/clients/:id/deactivate` (future, Phase 2)

Admin endpoint for manual deactivation. Not in MVP.

---

## 3. Data Model Changes

### 3a. New table: `onboarding_sessions`

```sql
CREATE TABLE onboarding_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status                   TEXT NOT NULL DEFAULT 'pending_checkout'
                           CHECK (status IN (
                             'pending_checkout',
                             'checkout_complete',
                             'provisioning',
                             'provisioned',
                             'failed'
                           )),

  -- Wizard answers (stored as-is from the form)
  business_name            TEXT NOT NULL,
  business_description     TEXT NOT NULL,
  phone_number             TEXT NOT NULL,
  website                  TEXT NOT NULL,
  hours                    TEXT NOT NULL,
  services                 TEXT NOT NULL,
  faqs                     TEXT NOT NULL,
  booking_instructions     TEXT NOT NULL,
  transfer_number          TEXT,
  booking_url              TEXT,
  greeting                 TEXT NOT NULL,
  owner_name               TEXT NOT NULL,
  owner_email              TEXT NOT NULL,
  owner_phone              TEXT NOT NULL,
  preferred_area_code      TEXT NOT NULL,

  -- Stripe linkage
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,

  -- Provisioning result
  provisioned_client_id    UUID REFERENCES clients(id),
  provisioned_phone_number TEXT,
  provision_error          TEXT,

  -- Timestamps
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  provisioned_at           TIMESTAMPTZ
);

CREATE INDEX idx_onboarding_stripe_checkout
  ON onboarding_sessions (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
```

### 3b. New table: `audit_log`

```sql
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,          -- 'client', 'onboarding_session', 'subscription'
  entity_id   TEXT NOT NULL,          -- UUID of the entity
  action      TEXT NOT NULL,          -- 'provisioned', 'deactivated', 'payment_failed', etc.
  details     JSONB,                  -- freeform context
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
```

### 3c. Changes to existing `clients` table

Add columns (non-breaking, nullable):

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS onboarding_session_id UUID REFERENCES onboarding_sessions(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT;  -- Twilio resource SID for number management
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS number_release_after TIMESTAMPTZ;  -- when to release Twilio number
```

**Migration file:** `sql/002-onboarding.sql`

---

## 4. Webhook / Idempotency Strategy

### Core principle: every webhook handler is safe to call multiple times with the same event.

**Stripe event deduplication:**
1. Stripe sends an `event.id` with every webhook. Store processed event IDs in a lightweight table:

```sql
CREATE TABLE processed_stripe_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

2. Before processing any event, check: `SELECT 1 FROM processed_stripe_events WHERE event_id = $1`. If found, return 200 immediately.
3. After successful processing, insert the event ID.
4. Wrap steps 2-3 in a transaction with the actual work.

**Provisioning idempotency:**
- The `onboarding_sessions.status` field acts as a state machine gate.
- Provisioning only proceeds if status is `checkout_complete`. If it's already `provisioning` or `provisioned`, skip.
- Use `UPDATE ... SET status = 'provisioning' WHERE id = $1 AND status = 'checkout_complete' RETURNING id` — the `WHERE` clause prevents races. If zero rows affected, another process already claimed it.

**Retry policy:**
- If provisioning fails (Twilio API down, etc.), set status to `failed` with `provision_error`.
- Phase 1: Manual retry via admin CLI. Phase 2: Automatic retry with exponential backoff (1min, 5min, 30min, then alert).

**Webhook response time:**
- Always return 200 to Stripe within 5 seconds.
- Provisioning runs async (fire-and-forget after status update). Don't block the webhook response on Twilio number purchase.

---

## 5. Twilio Number Provisioning Strategy

### Purchase flow

```
1. Search: GET /AvailablePhoneNumbers/US/Local
   Params: AreaCode={preferred_area_code}, VoiceEnabled=true, SmsEnabled=true, Limit=1

2. If no results in preferred area code:
   Fallback 1: Search neighboring area codes (maintain a small lookup map of related codes)
   Fallback 2: Search same state, any area code (NPA lookup by state)
   Fallback 3: Search any US number (VoiceEnabled=true, SmsEnabled=true, Limit=1)
   If all fail: Set onboarding status = 'failed', provision_error = 'no_numbers_available'
   Alert Austen via SMS.

3. Purchase: POST /IncomingPhoneNumbers
   Body: { PhoneNumber: "+1XXXXXXXXXX" }
   Store the returned SID in clients.twilio_number_sid

4. Configure: POST /IncomingPhoneNumbers/{sid}
   Body: {
     VoiceUrl: "https://{CADENCE_BASE_URL}/incoming-call",
     VoiceMethod: "POST",
     FriendlyName: "Cadence - {business_name}"
   }
```

### Fallback area code map (Phase 1, hardcoded)

```
602 → [480, 623, 520]   (Phoenix metro)
480 → [602, 623, 520]
623 → [602, 480, 520]
818 → [213, 310, 323]   (LA area)
...
```

Keep this small — 10-20 entries for likely early customers. Expand as needed.

### Number retention/release policy

| Scenario | Action | Timeline |
|---|---|---|
| Subscription canceled | Deactivate client, hold number | 30 days |
| Payment failed | Deactivate client, hold number | 30 days after deactivation |
| 30 days post-deactivation, no reactivation | Release number via Twilio API | Automated (Phase 2) or manual (Phase 1) |
| Client reactivates within 30 days | Reactivate with same number | Immediate |
| Client reactivates after number released | Provision new number | Same flow as new signup |

**Implementation:**
- On deactivation: set `clients.deactivated_at = now()` and `clients.number_release_after = now() + 30 days`
- Phase 1: Weekly manual check — query `SELECT * FROM clients WHERE number_release_after < now() AND active = false AND twilio_number_sid IS NOT NULL`
- Phase 2: Cron job that releases numbers and nullifies `twilio_number_sid` + `phone_number`

---

## 6. Environment Variables

### Secrets (store in Railway encrypted env vars)

| Variable | Purpose | Status |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection string | **Exists** |
| `STRIPE_SECRET_KEY` | Stripe API key | **Exists** |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | **Exists** — needs updating if new events added |
| `TWILIO_ACCOUNT_SID` | Twilio API auth | **Exists** |
| `TWILIO_AUTH_TOKEN` | Twilio API auth | **Exists** |
| `DEEPGRAM_API_KEY` | STT + TTS | **Exists** |
| `GROQ_API_KEY` | Primary LLM | **Exists** |
| `OPENAI_API_KEY` | Fallback LLM | **Exists** |
| `SENDGRID_API_KEY` | Welcome email delivery (Phase 2) | **TBD** |

### Public config (non-secret, store in Railway env vars)

| Variable | Purpose | Status |
|---|---|---|
| `CADENCE_BASE_URL` | Public URL for Twilio webhooks, e.g. `https://cadence-v2-production.up.railway.app` | **TBD** — must be set |
| `TWILIO_WEBSOCKET_URL` | WebSocket URL for media streams | **Exists** |
| `STRIPE_PRICE_ID` | Stripe Price ID for $199/mo Cadence plan | **TBD** — create in Stripe Dashboard |
| `ONBOARDING_SUCCESS_URL` | Where Stripe redirects after successful checkout, e.g. `https://autom8everything.com/cadence/welcome?session_id={CHECKOUT_SESSION_ID}` | **TBD** |
| `ONBOARDING_CANCEL_URL` | Where Stripe redirects if checkout canceled, e.g. `https://autom8everything.com/cadence/get-started` | **TBD** |
| `GROQ_MODEL` | LLM model name | **Exists** |
| `OPENAI_MODEL` | Fallback LLM model name | **Exists** |

### Stripe setup (one-time, manual)

1. Create Product "Cadence AI Receptionist" in Stripe Dashboard
2. Create Price: $199/mo, recurring
3. Copy Price ID → set as `STRIPE_PRICE_ID`
4. Update webhook endpoint to include `checkout.session.completed` event
5. If new webhook endpoint, update `STRIPE_WEBHOOK_SECRET`

---

## 7. Rollout Plan

### Phase 1: MVP (target: 1-2 weeks of coder work)

**Goal:** A prospect can sign up, pay, and be auto-provisioned without Austen touching anything.

**Scope:**
- [ ] SQL migration `002-onboarding.sql` (new tables + client column additions)
- [ ] `POST /api/onboarding/start` — validate + store wizard answers
- [ ] `POST /api/onboarding/checkout` — create Stripe Checkout Session
- [ ] `GET /api/onboarding/status/:session_id` — polling endpoint
- [ ] Extend `POST /webhook/stripe` to handle `checkout.session.completed`
- [ ] Provisioning pipeline: buy number → generate prompt → insert client → configure webhook
- [ ] `processed_stripe_events` table + dedup logic
- [ ] Audit log writes for provisioning + billing events
- [ ] Welcome SMS to owner_phone after provisioning ("Your Cadence line is live at +1...")
- [ ] Hardcoded area code fallback map (5-10 entries)
- [ ] Frontend: minimal onboarding wizard (can be a standalone page at `/cadence/get-started`)
- [ ] Frontend: success page at `/cadence/welcome` showing their new number
- [ ] Update deactivation logic to set `deactivated_at` + `number_release_after`

**Not in Phase 1:**
- No welcome email (SMS only)
- No automatic number release (manual)
- No retry on failed provisioning (manual)
- No customer portal / self-service management
- No admin dashboard

### Phase 2: Hardening (target: 2-4 weeks after Phase 1 launch)

**Scope:**
- [ ] Welcome email via SendGrid (branded, includes quick-start guide)
- [ ] Automatic provisioning retry with exponential backoff
- [ ] Cron job for number release (30 days post-deactivation)
- [ ] Customer portal: view number, update business info, manage subscription
- [ ] Stripe Customer Portal integration (subscription management, invoice history)
- [ ] Admin dashboard: list clients, view status, manually retry failed provisions
- [ ] Rate limiting on onboarding endpoints (express-rate-limit or similar)
- [ ] In-memory LRU cache for client lookup (call hot path optimization)
- [ ] Monitoring: alert on failed provisioning, failed webhooks, low Twilio balance
- [ ] Per-client LLM model selection (column on clients table)
- [ ] Per-client TTS voice selection

---

## 8. Risks + Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| 1 | **Twilio number unavailable in preferred area code** | Medium | Low | Fallback chain: nearby codes → same state → any US number. Notify owner which code was assigned. |
| 2 | **Provisioning fails after payment** | Low | High | Customer has paid but no service. Mitigation: audit log captures failure. SMS alert to Austen. Manual provisioning via existing CLI as backup. Refund policy: provision within 24h or auto-refund. |
| 3 | **Stripe webhook replay / out-of-order** | Medium | Low | Event dedup table. Status state machine with conditional UPDATE prevents double-provisioning. |
| 4 | **Onboarding session spam** | Low | Medium | Rate limit 10/hr per IP. Sessions expire after 24h (no checkout). Phase 2: add CAPTCHA. |
| 5 | **System prompt injection via wizard answers** | Low | Medium | Wizard answers are inserted into a template, not executed. The prompt is text for the LLM, not code. Validate max lengths. Sanitize obvious injection patterns (e.g., "ignore previous instructions"). |
| 6 | **Twilio number cost accumulation** | Low | Medium | $1.15/mo per number. At 100 clients = $115/mo overhead. Acceptable. Number release policy prevents orphan numbers. |
| 7 | **Database as single point of failure** | Low | High | Neon has 99.95% SLA. Phase 2: add read replica or in-memory cache for call routing. Not a concern at <50 clients. |
| 8 | **Stripe Checkout session expires** | Medium | Low | Stripe Checkout sessions expire after 24h by default. If expired, frontend shows "session expired" and lets prospect start over. Onboarding session stays in `pending_checkout` and can be re-used. |

---

## 9. Handoff Checklist for Coder

### Before starting

- [ ] Read this blueprint end-to-end
- [ ] Read `multi-tenant-blueprint.md` for existing architecture context
- [ ] Confirm `DATABASE_URL` is accessible from local dev (Neon connection string)
- [ ] Confirm `STRIPE_SECRET_KEY` is available (or get test mode key)
- [ ] Create Stripe test Product + Price ($199/mo) and note the Price ID

### Implementation order (recommended)

1. **Database migration** — `sql/002-onboarding.sql` with all new tables/columns
2. **Stripe event dedup** — `processed_stripe_events` table + dedup helper function
3. **Onboarding API** — `POST /api/onboarding/start` + `GET /api/onboarding/status/:session_id`
4. **Stripe Checkout creation** — `POST /api/onboarding/checkout`
5. **Provisioning pipeline** — extracted into `src/provisioning.ts` as a standalone async function
6. **Webhook extension** — add `checkout.session.completed` handler to existing `src/stripe.ts`
7. **Audit logging** — helper function, called from provisioning + billing handlers
8. **Welcome SMS** — send after successful provisioning
9. **Deactivation enhancement** — update existing `setClientActive` to populate `deactivated_at` + `number_release_after`
10. **Frontend wizard** — last, since API must be working first

### File organization (suggested new files)

```
src/
  onboarding.ts          # Express router for /api/onboarding/* endpoints
  provisioning.ts        # Async provisioning pipeline (buy number, gen prompt, insert client)
  audit.ts               # Audit log helper
  twilio-numbers.ts      # Twilio number search/purchase/configure/release
sql/
  002-onboarding.sql     # Migration for onboarding_sessions, audit_log, client columns
```

### Key implementation notes

- **Provisioning must be async.** The `checkout.session.completed` webhook handler should: (1) update session status to `checkout_complete`, (2) return 200 to Stripe, (3) trigger provisioning in a `setImmediate` / fire-and-forget `async` call. Do NOT block the webhook response on Twilio API calls.
- **Use transactions** for the provisioning insert. The client row insert + onboarding session status update + audit log write should be in one transaction.
- **Stripe Checkout Session creation** must include `metadata.onboarding_session_id` — this is how the webhook links back to the onboarding session.
- **Stripe Checkout Session config:**
  ```
  mode: 'subscription'
  line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }]
  subscription_data: { trial_period_days: 7 }
  success_url: ONBOARDING_SUCCESS_URL
  cancel_url: ONBOARDING_CANCEL_URL
  metadata: { onboarding_session_id: session.id }
  ```
- **CORS:** The onboarding API endpoints need CORS headers if the frontend is hosted on a different domain (autom8everything.com) than the backend (railway). Use `cors` middleware scoped to `/api/onboarding/*` with `origin: 'https://autom8everything.com'`.
- **Frontend hosting:** The wizard can be a static React/Next page deployed on Vercel (autom8everything.com likely already there) or embedded as a standalone HTML page. Keep it simple — no framework required if it's just a 4-step form.

### Verification checklist

- [ ] Can create onboarding session via API
- [ ] Can create Stripe Checkout Session and get redirect URL
- [ ] Stripe test checkout triggers `checkout.session.completed` webhook
- [ ] Webhook correctly triggers provisioning
- [ ] Twilio number is purchased and configured with correct webhook URL
- [ ] Client row is inserted with correct system prompt, greeting, etc.
- [ ] Welcome SMS is sent to owner phone
- [ ] Duplicate webhook doesn't create duplicate client
- [ ] Failed provisioning sets status to `failed` with error details
- [ ] `invoice.payment_failed` deactivates client and sets `deactivated_at`
- [ ] `customer.subscription.deleted` deactivates client and sets `number_release_after`
- [ ] Deactivated client's calls get "service unavailable" message
- [ ] Onboarding status endpoint reflects correct state through full flow
- [ ] CORS works from autom8everything.com domain

---

## Acceptance Criteria

1. **A prospect with zero technical knowledge can go from autom8everything.com to a live AI receptionist without human intervention.** The entire flow — wizard → checkout → provisioning → live calls — completes without Austen doing anything.

2. **Provisioning completes within 60 seconds of successful checkout.** Twilio number purchase + prompt generation + DB insert + webhook config + welcome SMS, all within a minute.

3. **No duplicate clients.** Replayed webhooks, double-clicks on checkout, or concurrent requests never create duplicate client rows or purchase duplicate numbers.

4. **Payment failure immediately disables service.** A client whose payment fails cannot receive AI-answered calls until payment is recovered.

5. **Number retention policy is enforced.** Deactivated clients keep their number for 30 days. Numbers are not released prematurely.

6. **Every provisioning action is auditable.** The `audit_log` table records who was provisioned, when, what number, any failures, and all billing state changes.

7. **Graceful failure.** If provisioning fails (Twilio API down, no numbers available), the system: stores the error, alerts Austen via SMS, and the prospect sees a "we're setting up your line" message (not a crash).
