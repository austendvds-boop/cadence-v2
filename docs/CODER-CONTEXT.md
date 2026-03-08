# Coder Context

## 2026-03-07 (Portal usage overage fields + settlement cron)

### Task
Extend portal usage API response with overage metadata and add monthly overage settlement cron route on `feature/usage-limits`.

### Changes made
- Updated `src/portal-api.ts`:
  - `UsageMonthlyRow` now includes:
    - `overage_preauth_intent_id`
    - `overage_billed_cents`
    - `overage_disabled`
    - `overage_notified_at`
  - Updated usage query to select overage columns from `usage_monthly`.
  - Updated `PLAN_LIMITS` minute limits:
    - `starter`: 200
    - `growth`: 500
  - Added clients overage config query:
    - `overage_rate_cents`
    - `overage_cap_cents`
  - Usage response now returns:
    - `usage`
    - `plan` (including `overageRateCents`, `overageCapCents`)
    - `overage` (`preauthIntentId`, `billedCents`, `disabled`, `notifiedAt`)
- Added new file `src/cron/settle-overages.ts`:
  - exports `settleOverages(req, res)`
  - validates `CRON_SECRET` from `x-cron-secret` or bearer token
  - selects last-month over-limit usage rows not yet billed
  - computes overage using client limits/rates/cap
  - cancels prior pre-auth intent if present
  - creates Stripe PaymentIntent and updates `usage_monthly.overage_billed_cents`
  - resets `overage_disabled=false` for current month rows
- Updated `src/index.ts`:
  - imported `settleOverages`
  - mounted `POST /cron/settle-overages`

### Files touched this batch
- `src/portal-api.ts`
- `src/cron/settle-overages.ts` (new)
- `src/index.ts`
- `docs/CODER-CONTEXT.md`
- `docs/ralph-context.md`

### Gotchas / notes
- `settleOverages` throws if `STRIPE_SECRET_KEY` missing (no local catch around `getStripe()`).
- Usage endpoint now performs 3 queries in parallel; plan and overage config both source from `clients`.
- `overageConfig` defaults to `0` values if client row is unexpectedly missing fields.

### Verification
- `npm run build` ✅

### Git
- Commit: pending in this batch
- Push: pending in this batch

---

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
