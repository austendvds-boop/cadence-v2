# Coder Context

## 2026-03-04 (Phase 3a Stripe billing integration)

### Task
Implement Phase 3a billing components: Stripe checkout session generation for post-onboarding, billing webhook mapping into dedicated billing tables, deactivation TwiML policy, and Stripe webhook route wiring.

### Changes made
- Added new billing migration:
  - `sql/005-billing.sql`
    - `billing_subscriptions` table
    - `billing_events` table
    - indexes for client/customer/subscription/event lookup
- Added `src/billing-service.ts`:
  - `createCheckoutSession(clientId, email)`
  - `handleWebhookEvent(event)`
  - Stripe event mapping for:
    - `checkout.session.completed`
    - `customer.subscription.created`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `invoice.paid`
    - `invoice.payment_failed`
  - Updates both `billing_subscriptions` + `clients.active` lifecycle
  - Persists webhook payload/idempotency records in `billing_events`
- Added `src/billing-checkout.ts`:
  - Generates post-onboarding checkout link + SMS/email copy from Stripe checkout session.
- Added `src/deactivation-policy.ts`:
  - Deactivation reason helper + polite "temporarily unavailable" TwiML renderer for inactive/trial-expired clients.
- Updated `src/stripe.ts`:
  - Delegates Stripe lifecycle mapping to `billing-service.ts`
  - Preserves onboarding provisioning trigger for `checkout.session.completed` with `onboarding_session_id`
- Updated `src/index.ts`:
  - Wired `POST /stripe-webhook` (and kept `/webhook/stripe` compatibility path)
  - Wired deactivation policy check into `POST /incoming-call` before Twilio stream connect.
- Updated `src/provision-client.ts`:
  - Creates Stripe checkout link post-provisioning via `generatePostOnboardingCheckoutLink(...)`
  - Sends billing checkout link in owner welcome SMS when owner email exists
  - Adds billing checkout metadata to returned result + audit log entries.

### Files touched (Phase 3a)
- `sql/005-billing.sql` (new)
- `src/billing-service.ts` (new)
- `src/billing-checkout.ts` (new)
- `src/deactivation-policy.ts` (new)
- `src/stripe.ts`
- `src/index.ts`
- `src/provision-client.ts`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ✅

### Git
- Commit: `<pending>`
- Push: `<pending>`

## 2026-03-03

### Task
Fix Deepgram live STT config so `UtteranceEnd` events fire reliably when using `utterance_end_ms`.

### Changes made
- Updated `src/stt.ts` in the `client.listen.live({...})` options:
  - Added `interim_results: true`

### Files touched
- `src/stt.ts`

### Verification
- `npm run build` ✅ (TypeScript compile passed clean)

### Git
- Commit: `cd3085d` — `fix: add interim_results for UtteranceEnd to work`
- Push: `main` pushed to `origin`/GitHub (`austendvds-boop/cadence-v2`)

## 2026-03-03 (Crash-safety hardening)

### Task
Harden Deepgram STT callback handling so async errors in transcript processing cannot bubble up and disrupt live call flow.

### Changes made
- Updated `src/stt.ts`:
  - Wrapped `LiveTranscriptionEvents.Transcript` handler body in `try/catch`.
  - Added defensive parse-error logging with prefix: `[STT] transcript parse error`.
  - Wrapped `await onTranscript(utterance)` inside `LiveTranscriptionEvents.UtteranceEnd` handler in `try/catch`.
  - Added callback-error logging with prefix: `[STT] onTranscript callback error`.
- Preserved existing behavior otherwise:
  - Final transcript buffering logic unchanged.
  - Buffer reset timing unchanged.
  - No prompt/content or flow logic changes.

### Files touched
- `src/stt.ts`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅

### Git
- Commit: `<pending>` — `fix: harden STT callback error handling`
- Push: `<pending>`

## 2026-03-03 (Multi-tenant platform + billing)

### Task
Implement Cadence v2 multi-tenant architecture per `docs/multi-tenant-blueprint.md`, migrate DVDS as client #1, add Stripe webhook billing enforcement, and prepare Railway env migration.

### Changes made
- Added Neon/Postgres data layer and hot-path client lookup:
  - New `src/db.ts` with pooled DB connection, client lookup helpers, trial expiry check, and Stripe lookup helpers.
- Added prompt template generator:
  - New `src/prompt-template.ts` with `generateSystemPrompt()` and typed params.
- Added Stripe webhook handling:
  - New `src/stripe.ts` with verification and handlers for `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`.
- Added provisioning CLI:
  - New `scripts/add-client.ts` to collect business data, buy/configure Twilio number, generate prompt, and insert client row.
- Added DB schema migration:
  - New `sql/001-clients.sql` creating `clients` table + indexes.
- Updated call routing:
  - `src/index.ts` now routes incoming calls by Twilio `To` number, checks `active` + trial status, passes `clientId`/`from` via Twilio stream parameters, and exposes `/webhook/stripe` raw-body endpoint.
- Updated runtime call pipeline:
  - `src/call-handler.ts` now accepts per-client config (`systemPrompt`, `transferNumber`, `greeting`, `ownerPhone`, `twilioNumber`, etc.).
  - `src/llm.ts` now takes `systemPrompt` argument instead of hardcoded prompt import.
  - `src/sms.ts` now sends from client Twilio number and sends summaries to client owner phone.
- Installed dependencies:
  - `pg`, `@types/pg`, `stripe`, `tsx`.

### Data migration
- Executed `sql/001-clients.sql` against Neon database from `credentials/neon-cadence-db.txt`.
- Upserted DVDS client row:
  - `phone_number`: `+19284477047`
  - `business_name`: `Deer Valley Driving School`
  - `transfer_number`: `+16026633502`
  - `system_prompt`: full text pulled from `src/system-prompt.ts`
  - `sms_enabled`: `true`
  - `plan`: `starter`
  - `active`: `true`
  - `trial_ends_at`: `NULL`

### Verification
- `npm run build` ✅ (clean TypeScript compile)

### Deployment notes
- Railway GraphQL update attempted with token at `credentials/railway-token.txt`, but API returned `Not Authorized` for both `me` query and variable upsert mutation. Env var update is blocked until valid Railway API auth token/permissions are provided.

## 2026-03-03 (SaaS onboarding MVP - Phase 1)

### Task
Implement onboarding + Stripe checkout + async provisioning pipeline + frontend integration for self-serve Cadence signup.

### Backend changes (`cadence-v2`)
- Added `sql/002-onboarding.sql`:
  - `onboarding_sessions`
  - `processed_stripe_events`
  - `audit_log`
  - `clients` column additions (`owner_name`, `owner_email`, `onboarding_session_id`, `twilio_number_sid`, `deactivated_at`, `number_release_after`)
- Added onboarding API router (`src/onboarding.ts`):
  - `POST /api/onboarding/start`
  - `POST /api/onboarding/checkout`
  - `GET /api/onboarding/status/:sessionId`
  - scoped CORS for `https://autom8everything.com`
- Added async provisioning pipeline (`src/provisioning.ts`):
  - status claim (`checkout_complete` -> `provisioning`) for race safety
  - Twilio number purchase + fallback area code search
  - number webhook configuration
  - prompt generation via `generateSystemPrompt`
  - client insert + onboarding session linkage
  - onboarding audit log insert
  - owner welcome SMS
- Added Twilio number helper (`src/twilio-numbers.ts`) with fallback map and provisioning utilities.
- Added audit helper (`src/audit.ts`).
- Extended Stripe webhook (`src/stripe.ts`):
  - handles `checkout.session.completed`
  - dedupes via `processed_stripe_events`
  - triggers async provisioning pipeline and returns webhook 200 quickly
  - writes billing/provisioning audit events
- Updated `src/db.ts`:
  - expanded `Client` shape to include onboarding/deactivation fields
  - added `OnboardingSession` type and query helper
  - deactivation enhancement in `setClientActive(false)` to set `deactivated_at` and `number_release_after = now() + 30 days`
- Updated `src/index.ts` to mount onboarding routes.
- Updated `src/sms.ts` to export `sendSms` helper.
- Updated `.env.example` with onboarding/checkout/provisioning vars.

### Verification
- `npm run build` ✅

### Git
- Commit: `<pending>`
- Push: `<pending>`

## 2026-03-03 (Onboarding CORS origin fix)

### Task
Fix live onboarding POST `/api/onboarding/start` CORS failure (status 0) by allowing both autom8 root + www and supporting strict Vercel production alias origin when configured.

### Changes made
- Updated `src/onboarding.ts` CORS origin allowlist logic:
  - Added explicit allowlist entries:
    - `https://autom8everything.com`
    - `https://www.autom8everything.com`
  - Added strict origin extraction from `ONBOARDING_SUCCESS_URL` and `ONBOARDING_CANCEL_URL` (HTTPS origin only), so a configured Vercel production alias origin is allowed without using any wildcard.
  - Preserved existing OPTIONS preflight handling (`204` + early return) and existing endpoint behavior.

### Files touched
- `src/onboarding.ts`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅

### Git
- Commit: `<pending>`
- Push: `<pending>`

## 2026-03-04 (Phase 2c onboarding e2e smoke + prompt polish)

### Task
Add an end-to-end onboarding smoke test, add shared provisioning entrypoint (`provision-client.ts`) for safe mock invocation, polish onboarding prompt copy, and verify DVDS inbound call path is unaffected.

### Changes made
- Added new onboarding prompt constants in `src/onboarding-prompt.ts`:
  - Exact required greeting string.
  - Exact confirmation phrase (`"Let me make sure I got everything right..."`).
  - Exact sign-off phrase (`"You're all set! Someone from our team will reach out within 24 hours. Thanks for choosing Autom8!"`).
  - Full onboarding system prompt constrained to casual/friendly 2–3 sentence turns.
- Added `src/provision-client.ts` shared provisioning orchestrator:
  - Exports typed `provisionClient(...)` function.
  - Supports `dryRun` mode for safe mock invocation (no Twilio purchase / no DB insert).
  - In non-dry mode handles Twilio number purchase/config, client insert, audit log write, optional welcome SMS.
- Added `scripts/smoke-onboarding-e2e.ts`:
  - Verifies onboarding tenant exists for `+14806313993`.
  - Applies/persists polished onboarding greeting + system prompt to that tenant row.
  - Verifies `POST /incoming-call` TwiML shape for onboarding line.
  - Verifies `POST /incoming-call` TwiML shape for DVDS production line `+19284477047`.
  - Verifies `provision-client.ts` mock dry-run invocation does not crash.
  - Verifies Twilio API auth/access by listing available numbers.
  - Emits machine-readable `SMOKE_RESULT_JSON=...` summary.
- Updated `package.json` scripts:
  - Added `smoke:onboarding-e2e` -> `tsx scripts/smoke-onboarding-e2e.ts`.
- Polished live phone-onboarding conversational flow (without touching frozen voice core files):
  - Updated `src/onboarding-call-handler.ts` to:
    - Open with the required Autom8 greeting line.
    - Collect the requested intake fields conversationally, including explicit `call_handling`.
    - Confirm with exact phrase `"Let me make sure I got everything right..."`.
    - Sign off with exact phrase `"You're all set! Someone from our team will reach out within 24 hours. Thanks for choosing Autom8!"`.
    - Keep tone instructions at 2-3 short sentences per turn, casual/friendly/efficient.
  - Updated `src/onboarding-session-store.ts` field schema to include `call_handling` as a required onboarding field.
  - Updated `src/onboarding-tools.ts` to persist captured `call_handling` into `onboarding_sessions.booking_instructions` during provisioning session creation.
- Added migration `sql/008-onboarding-call-handling-field.sql` to allow `call_handling` in `onboarding_fields.field_name` constraint.
  - Applied migration against production DB (`neon-cadence-db`) with safe table-existence guard.

### Files touched
- `src/onboarding-prompt.ts`
- `src/provision-client.ts`
- `src/onboarding-call-handler.ts`
- `src/onboarding-session-store.ts`
- `src/onboarding-tools.ts`
- `scripts/smoke-onboarding-e2e.ts`
- `sql/008-onboarding-call-handling-field.sql`
- `package.json`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅
- `npm run smoke:onboarding-e2e` ✅
  - onboarding tenant lookup (`+14806313993`) ✅
  - onboarding prompt polish/update ✅
  - onboarding `/incoming-call` TwiML ✅
  - DVDS `/incoming-call` TwiML (`+19284477047`) ✅
  - `provision-client.ts` dry-run call ✅
  - Twilio available-number API call ✅
- SQL migration apply run (`sql/008-onboarding-call-handling-field.sql`) ✅
- Frozen voice files unchanged (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ✅

### Git
- Commit: `<pending>`
- Push: `<pending>`

