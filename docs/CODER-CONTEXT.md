# Coder Context

## 2026-03-07 (Usage limits core + overage disable flow)

### Task
Implement usage-limits migration and core runtime checks on `feature/usage-limits`.

### Changes made
- Added migration: `docs/migrations/2026-03-07-usage-limits.sql`
  - `clients`: `monthly_minutes_limit`, `overage_rate_cents`, `overage_cap_cents`
  - backfills for `starter` and `growth`
  - `usage_monthly`: `overage_preauth_intent_id`, `overage_billed_cents`, `overage_disabled`, `overage_notified_at`
- Added new module: `src/usage-limits.ts`
  - exports `checkAndHandleUsage(clientId)`
  - computes monthly minute limit using override or plan defaults
  - sends one Telegram over-limit alert per client/month
  - attempts Stripe manual-capture pre-auth and records intent id
  - soft-disables usage month on pre-auth failure and sends owner warning text + Telegram alert
- Updated `src/call-logger.ts`
  - imports `checkAndHandleUsage`
  - runs non-blocking usage check via `setImmediate` after transaction `COMMIT`
- Updated `src/deactivation-policy.ts`
  - `DeactivationReason` now includes `"overage_disabled"`
  - added `isOverageDisabled(clientId)` query helper
  - added `renderOverageDisabledTwiml(...)`
- Updated `src/index.ts`
  - `/incoming-call` now checks `isOverageDisabled(client.id)` after existing deactivation check and returns overage-disabled TwiML before stream connect
- Updated `src/db.ts`
  - `Client` interface now includes `monthly_minutes_limit`, `overage_rate_cents`, `overage_cap_cents`

### Files touched this batch
- `docs/migrations/2026-03-07-usage-limits.sql` (new)
- `src/usage-limits.ts` (new)
- `src/call-logger.ts`
- `src/deactivation-policy.ts`
- `src/index.ts`
- `src/db.ts`
- `docs/CODER-CONTEXT.md`
- `docs/ralph-context.md`

### Gotchas / notes
- `getDeactivationReason(...)` remains synchronous and only checks `active`/`trial_expired`; overage status is intentionally checked separately via `isOverageDisabled(...)` in request flow.
- Usage enforcement is post-commit and non-blocking; logging transaction behavior was not changed.
- Over-limit Telegram message uses capped overage amount.

### Verification
- `npm run build` ?

### Git
- Commit: pending in this batch
- Push: pending in this batch

---

## 2026-03-07 (Portal API extensions retry: final verification + commit handoff)

### Task
Retry portal API extension handoff on `feature/portal-extensions` and ensure this batch ends with a fresh commit + push.

### Changes made
- Re-verified all required implementation in `src/portal-api.ts`:
  - Tenant GET includes `systemPrompt` (`c.system_prompt` selected + serialized)
  - Tenant PATCH supports `systemPrompt` updates with min-length validation
  - `GET /api/portal/tenant/:tenantId/usage` implemented (current month usage + plan limits)
  - `POST /api/portal/tenant/:tenantId/test-call` implemented (E.164 validation, tenant Twilio number lookup, hourly in-memory rate limiting, Twilio call creation)
- Re-verified `twilio` dependency is present in `package.json`.
- Updated this context doc for the current retry and kept only the latest 3 batches.

### Files touched this batch
- `docs/CODER-CONTEXT.md`

### Key exports / behavior notes
- Portal router export remains default export from `src/portal-api.ts`.
- Usage endpoint returns zeroed totals when no current-month usage row exists.
- Test-call limiter remains in-memory/process-local (`Map<string, number[]>`).

### Gotchas / notes
- Test-call limiter resets on process restart and is not shared across multiple app instances.
- Test-call endpoint requires `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
- Test-call webhook URL uses `BASE_URL` fallback `https://cadence-v2-production.up.railway.app`.

### Verification
- `npm run build` ?
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ?

### Git
- Commit: recorded in this batch after commit/push
- Push: `origin/feature/portal-extensions`

---

## 2026-03-07 (Portal API extensions retry: commit + push)

### Task
Re-run verification for portal extensions on `feature/portal-extensions`, ensure the branch is ready, and complete commit/push handoff for retry.

### Changes made
- Verified `feature/portal-extensions` already contains all requested portal API implementation in `src/portal-api.ts`:
  - Tenant GET includes `systemPrompt` (`c.system_prompt` selected + serialized)
  - Tenant PATCH supports `systemPrompt` updates with min-length validation
  - `GET /api/portal/tenant/:tenantId/usage` implemented
  - `POST /api/portal/tenant/:tenantId/test-call` implemented with E.164 validation, per-tenant in-memory hourly rate limiting, and Twilio call creation
- Verified `twilio` dependency is present in `package.json`.
- Updated this context doc and kept only the last 3 batches.

### Files touched this batch
- `docs/CODER-CONTEXT.md`

### Gotchas / notes
- No additional source code changes were needed in this retry; implementation was already present from prior commits on this branch.
- Test-call limiter is process-local in-memory state (resets on restart and is not shared across instances).
- Test-call endpoint requires `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.

### Verification
- `npm run build` ?
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ?

### Git
- Commit: `2a570bb`
- Push: `origin/feature/portal-extensions`
