# Coder Context

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

