# Cadence SaaS Blueprint (Railway `cadence-v2` Golden Base)

## 0) Reality check from current codebase (read-first findings)

This repo is **already partially into Phase 1–3**:
- Multi-tenant lookup is already live in `src/index.ts` (`getClientByPhone` on incoming `To`).
- Tenant config is injected into `CallHandler` at WebSocket start.
- Onboarding web flow exists (`src/onboarding.ts`) with Stripe checkout + async provisioning (`src/provisioning.ts`).
- Stripe lifecycle deactivation/reactivation exists (`src/stripe.ts`, `setClientActive` in `src/db.ts`).

What is missing for the requested full SaaS target:
- Strong tenant schema normalization (hours/services/faqs currently embedded in prompt/onboarding blobs).
- Native phone-based onboarding flow (480 onboarding line) as first-class voice workflow.
- Call/transcript persistence for dashboard analytics.
- Dashboard auth + client/admin web UI.
- Billing data model beyond minimal fields on `clients`.

---

## 1) Voice engine boundary (MUST NOT be modified)

### Hard freeze files/functions
These are the golden voice path and must remain unchanged:

1. `src/stt.ts`
   - `createLiveSTT(...)`
   - Deepgram live config (`model`, `encoding`, `utterance_end_ms`, etc.)
   - transcript buffering + `UtteranceEnd` behavior

2. `src/tts.ts`
   - `speak(...)`
   - Aura websocket URL + stream chunk behavior

3. `src/call-handler.ts`
   - `onMedia(...)` audio forwarding behavior
   - turn-taking gates (`isSpeaking` handling)
   - `onTranscript(...)` request/response loop timing semantics
   - `sendAudio(...)` Twilio media payload shape

4. `src/llm.ts`
   - `callChatApi(...)`
   - timeout/fallback flow Groq -> OpenAI -> graceful fallback

### Exact minimal tenant integration point (already present)

The minimal and correct injection seam is in `src/index.ts`:
- **Lookup by Twilio `To`**: `app.post('/incoming-call')` lines ~20–25.
- **Pass tenant identity into stream**: TwiML `<Parameter name="clientId" ...>` lines ~46–49.
- **Hydrate tenant config once at stream start**: lines ~67–90.
- **Create call session with tenant config**: `new CallHandler(ws, { ...systemPrompt, greeting, smsEnabled... })` lines ~80–90.

That seam is the only place tenant sourcing should change. The voice pipeline itself stays frozen.

---

## 2) Target architecture

## Core principle
- **Voice path stays dumb/fast**: resolve tenant once, run golden handler untouched.
- **Everything SaaS (onboarding, billing, dashboard, analytics)** is outside that hot path.

## Logical services (same Railway service initially; split later optional)
1. Voice ingress + WebSocket media (existing `src/index.ts`).
2. Tenant data access layer (`src/db.ts` + migrations).
3. Onboarding orchestration (phone + provisioning workers).
4. Stripe webhook + billing state engine.
5. Dashboard API (read/write tenant settings + analytics).

---

## 3) Database schema (full) + migrations

> Keep existing `clients` table as the canonical tenant table (rename not required). Add normalized config + call/billing/dashboard tables.

## Migration 003 — tenant config normalization
**File:** `sql/003-tenant-config.sql`

```sql
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS business_type TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Phoenix',
  ADD COLUMN IF NOT EXISTS sms_number TEXT,
  ADD COLUMN IF NOT EXISTS intake_mode TEXT NOT NULL DEFAULT 'standard' CHECK (intake_mode IN ('standard','onboarding')),
  ADD COLUMN IF NOT EXISTS fallback_mode TEXT NOT NULL DEFAULT 'out_of_service' CHECK (fallback_mode IN ('out_of_service','forward')),
  ADD COLUMN IF NOT EXISTS fallback_forward_number TEXT,
  ADD COLUMN IF NOT EXISTS tools_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS business_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

CREATE TABLE IF NOT EXISTS client_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_open BOOLEAN NOT NULL DEFAULT false,
  open_time TEXT,
  close_time TEXT,
  UNIQUE (client_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS client_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_text TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_hours_client ON client_hours(client_id);
CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services(client_id);
CREATE INDEX IF NOT EXISTS idx_client_faqs_client ON client_faqs(client_id);
```

## Migration 004 — calls + transcripts + usage
**File:** `sql/004-calls-transcripts.sql`

```sql
CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  twilio_call_sid TEXT UNIQUE,
  twilio_stream_sid TEXT,
  from_number TEXT,
  to_number TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  call_status TEXT NOT NULL DEFAULT 'in_progress' CHECK (call_status IN ('in_progress','completed','failed','blocked')),
  summary_text TEXT,
  booking_link_sent BOOLEAN NOT NULL DEFAULT false,
  escalation_requested BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id BIGSERIAL PRIMARY KEY,
  call_session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  turn_index INT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('caller','cadence','system')),
  utterance TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_session_id, turn_index, speaker)
);

CREATE TABLE IF NOT EXISTS usage_monthly (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month_start DATE NOT NULL,
  calls_count INT NOT NULL DEFAULT 0,
  minutes_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  transcripts_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_client_started ON call_sessions(client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_transcripts_session ON call_transcripts(call_session_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_client_month ON usage_monthly(client_id, month_start DESC);
```

## Migration 005 — billing normalization
**File:** `sql/005-billing.sql`

```sql
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  status TEXT NOT NULL DEFAULT 'trialing',
  signup_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trial_end_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at TIMESTAMPTZ,
  last_payment_status TEXT,
  last_payment_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_events (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  stripe_event_id TEXT NOT NULL UNIQUE,
  stripe_event_type TEXT NOT NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_client ON billing_events(client_id, processed_at DESC);
```

## Migration 006 — dashboard auth (magic links)
**File:** `sql/006-dashboard-auth.sql`

```sql
CREATE TABLE IF NOT EXISTS dashboard_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('client_admin','platform_admin')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_magic_tokens_user ON magic_link_tokens(user_id, created_at DESC);
```

---

## 4) Per-phase implementation plan

## Phase 1 — Multi-tenant core hardening (DB-driven tenant config)

### Scope goal
Make tenant config complete + normalized while preserving current call quality.

### New files to create
1. `src/tenant-config.ts`
   - Read-only hydrator that joins `clients + hours + services + faqs` and builds runtime config object.
2. `src/tenant-prompt-builder.ts`
   - Deterministic prompt assembly from normalized tables (for regenerate/update operations only).
3. `sql/003-tenant-config.sql`
   - migration above.
4. `scripts/migrate-dvds-to-normalized-config.ts`
   - one-time DVDS data backfill into normalized tables.

### Minimal integration points with existing code
- `src/index.ts`: replace direct `getClientById/getClientByPhone` shape mapping with `getTenantRuntimeConfig(...)` return object.
- Keep `new CallHandler(ws, config)` call contract unchanged.

### Risk to voice quality
- **Low** if config object shape remains identical at handler boundary.
- Risk source is prompt drift, not transport/audio.

### Env vars
- Existing only: `DATABASE_URL`, `TWILIO_WEBSOCKET_URL`.
- Optional: `TENANT_CONFIG_CACHE_TTL_MS=30000` (safe read cache outside voice internals).

### Testing gate (must pass before Phase 2)
1. 10 live test calls to DVDS number.
2. Verify no regression in:
   - greeting playback,
   - STT turn endpointing,
   - response latency,
   - booking link SMS behavior.
3. Compare golden call transcript style (1–2 sentence concise responses) before/after.

**Estimated coder batches:** 2

---

## Phase 2 — Phone onboarding (480 line) + instant provisioning

### Scope goal
Prospect calls onboarding number, completes interview, client provisioned immediately.

### New files to create
1. `src/onboarding-call-handler.ts`
   - Dedicated onboarding voice workflow handler (separate from golden `CallHandler`).
   - Can use same STT/TTS/LLM primitives, but does not modify production call handler.
2. `src/onboarding-tools.ts`
   - Implements tools: `save_onboarding_field`, `complete_onboarding`, `provision_client`.
3. `src/onboarding-session-store.ts`
   - Persists per-call onboarding intake state.
4. `src/provision-client.ts`
   - Shared provisioning orchestration (Twilio number + DB row + prompt generation + notifications).
5. `sql/007-onboarding-phone.sql`
   - onboarding call state tables (`onboarding_call_sessions`, `onboarding_fields`).

### Minimal integration points with existing code
- `src/index.ts` WebSocket start branch:
  - if tenant `intake_mode='onboarding'` -> instantiate `OnboardingCallHandler`
  - else existing `CallHandler` (unchanged path).
- Reuse existing `purchaseAndConfigureTwilioNumber(...)` from `src/twilio-numbers.ts` and provisioning transaction flow.

### Risk to voice quality
- **Low for production tenants**, **Medium for onboarding number**.
- Justification: onboarding logic isolated in separate handler; production handler untouched.

### Env vars
- `ONBOARDING_NOTIFY_AUSTEN_NUMBER=+16026633503`
- `ONBOARDING_DEFAULT_COUNTRY=US`
- `CADENCE_BASE_URL` (already used)
- Twilio/DB vars already present.

### Testing gate
1. Place real call to onboarding 480 number.
2. Complete interview end-to-end.
3. Confirm:
   - Twilio number purchased,
   - webhook set to `/incoming-call`,
   - client row inserted active=true,
   - welcome SMS to client,
   - summary SMS to Austen,
   - immediate live inbound call works on new number.
4. Re-run DVDS regression call to ensure no golden path impact.

**Estimated coder batches:** 3

---

## Phase 3 — Stripe billing enforcement + lifecycle

### Scope goal
$199/mo + 7-day trial managed cleanly with auto deactivate/reactivate.

### New files to create
1. `src/billing-service.ts`
   - maps Stripe events -> billing_subscriptions + client active state transitions.
2. `src/billing-checkout.ts`
   - generates checkout links for post-onboarding SMS/email.
3. `sql/005-billing.sql`
   - migration above.
4. `src/deactivation-policy.ts`
   - enforces fallback behavior when inactive (`out_of_service` message vs forward).

### Minimal integration points with existing code
- `src/stripe.ts`: delegate event handling to `billing-service.ts`.
- `src/index.ts /incoming-call`: keep existing active/trial check, add explicit fallback mode handling.

### Risk to voice quality
- **Low**.
- Billing changes are pre-call routing; no audio pipeline changes.

### Env vars
- `STRIPE_SECRET_KEY` (existing)
- `STRIPE_WEBHOOK_SECRET` (existing)
- `STRIPE_PRICE_ID` (existing)
- `BILLING_GRACE_HOURS` (optional, e.g., 24)

### Testing gate
1. Stripe test mode events:
   - `checkout.session.completed`,
   - `invoice.paid`,
   - `invoice.payment_failed`,
   - `customer.subscription.deleted`.
2. Verify active flag transitions and call behavior by placing test calls to tenant numbers.
3. Confirm reactivation restores live answering without redeploy.

**Estimated coder batches:** 2

---

## Phase 4 — Client dashboard + admin console

### Scope goal
Magic-link auth web app for client self-serve + Austen admin visibility.

### New files to create
1. `src/dashboard/auth.ts`
   - magic-link issue/verify endpoints.
2. `src/dashboard/client-api.ts`
   - client reads: calls, summaries, monthly usage.
   - client writes: hours, faqs, greeting.
3. `src/dashboard/admin-api.ts`
   - all clients, billing status, call volume, CSV export.
4. `src/dashboard/csv-export.ts`
5. `sql/006-dashboard-auth.sql`
6. New web app repo or folder (recommended separate app):
   - `apps/cadence-dashboard/` (frontend)

### Minimal integration points with existing code
- none in voice handler files.
- add read/write APIs against shared DB only.

### Risk to voice quality
- **Low**.
- Separate web app path, DB-backed, no real-time call loop modifications.

### Env vars
- `DASHBOARD_BASE_URL`
- `MAGIC_LINK_SIGNING_SECRET`
- `MAGIC_LINK_TTL_MINUTES=15`
- `SMTP_*` or transactional email provider keys

### Testing gate
1. Magic-link login works (issue + consume token once).
2. Client can edit greeting/hours/faqs and next live call reflects updates.
3. Admin CSV export includes accurate billing + usage totals.
4. DVDS live call regression still clean.

**Estimated coder batches:** 3

---

## 5) Onboarding flow diagram (phone call -> live AI in minutes)

```text
Prospect dials onboarding 480 number
  -> Twilio POST /incoming-call with To=480...
  -> Tenant lookup resolves onboarding tenant (intake_mode=onboarding)
  -> WebSocket /media-stream starts
  -> OnboardingCallHandler runs interview
      -> tool: save_onboarding_field (name, business type, hours, services, FAQs, transfer #, etc.)
      -> validates required fields
      -> tool: complete_onboarding
  -> provisioning pipeline starts
      1) buy Twilio local number (preferred area code with fallback)
      2) configure number webhook -> {CADENCE_BASE_URL}/incoming-call
      3) generate system prompt from captured fields
      4) insert clients row + normalized config rows
      5) set active=true, plan=trial, trial_end=+7 days
      6) send welcome SMS to client with new number
      7) send provisioning summary SMS to Austen (+16026633503)
  -> done: new client number is immediately live
```

---

## 6) Execution order + dependencies + parallelization

## Required order
1. **Phase 1 first** (stabilize tenant data model + preserve boundary).
2. **Phase 2 second** (phone onboarding depends on clean tenant write model).
3. **Phase 3 third** (billing attaches to provisioned clients).
4. **Phase 4 last** (dashboard consumes all prior tables/events).

## What can run in parallel
- During Phase 2: onboarding prompt design and Twilio provisioning helper refinements can run parallel.
- During Phase 3: Stripe event mapping and inactive-call fallback behavior can run parallel, then integrate.
- During Phase 4: frontend UI can run parallel with backend dashboard APIs once contracts are locked.

---

## 7) Scope estimate (coder batches)

- Phase 1: **2 batches**
- Phase 2: **3 batches**
- Phase 3: **2 batches**
- Phase 4: **3 batches**

**Total:** ~10 sequential coder batches (realistic, quality-first, no voice regressions).

---

## 8) Non-negotiable quality gates

1. No edits to frozen voice files/functions listed in Section 1.
2. Every phase ends with real inbound call smoke tests on:
   - DVDS production number,
   - one non-DVDS tenant number,
   - onboarding number (once Phase 2 starts).
3. Any voice regression blocks rollout regardless of feature completeness.
4. Stripe webhook idempotency must be proven with replayed events.
5. New tenant provisioning must be one-transaction or compensating rollback safe.

---

## 9) Final recommendation

The repo already has the right skeleton. The safest path is:
- treat current `clients` as tenant core,
- isolate new onboarding intelligence in a separate onboarding handler,
- keep golden `CallHandler` + STT/TTS/LLM untouched,
- build dashboard and billing as DB/API layers around the voice core.

That preserves the one thing that already works perfectly: call quality.