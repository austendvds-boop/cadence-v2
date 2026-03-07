# Coder Context

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
- `npm run build` ✅
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ✅

### Git
- Commit: `2a570bb`
- Push: `origin/feature/portal-extensions`

---

## 2026-03-07 (Portal API extensions retry: verification + handoff)

### Task
Finalize `feature/portal-extensions` for portal API enhancements (system prompt support, usage endpoint, test-call endpoint), verify build, and push branch updates.

### Changes made
- Verified `src/portal-api.ts` includes all requested portal extensions:
  - Tenant GET now includes `systemPrompt` (`c.system_prompt` selected + serialized)
  - Tenant PATCH now supports `systemPrompt` updates with min-length validation
  - Added `GET /api/portal/tenant/:tenantId/usage` (current month usage + plan limits)
  - Added `POST /api/portal/tenant/:tenantId/test-call` (E.164 validation, per-tenant in-memory rate limit, Twilio call creation)
- Verified `twilio` dependency is present in `package.json`.
- Updated this context doc for handoff.

### Files touched this batch
- `docs/CODER-CONTEXT.md`

### Key exports / behavior notes
- Portal router export remains default export from `src/portal-api.ts`.
- New in-memory limiter for test calls:
  - `testCallRateLimitByTenant` map
  - Max 3 test calls per tenant per rolling hour
- Usage plan limits map in portal API:
  - trial → 50 calls / 120 minutes
  - starter → 200 calls / 500 minutes
  - growth → 500 calls / 1500 minutes

### Gotchas for next batch
- Test-call limiter is process-local in-memory state (resets on restart, not shared across multiple instances).
- Test-call endpoint requires `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
- Test-call webhook URL uses `BASE_URL` with fallback to Railway production URL.

### Verification
- `npm run build` ✅
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ✅

### Git
- Commit: `05e5337`
- Push: `origin/feature/portal-extensions`

---

## 2026-03-07 (Portal API extensions: system prompt, usage, and test call)

### Task
Extend portal API for autom8everything cross-service access with additional tenant fields and new usage/test-call endpoints.

### Changes made
- Updated `src/portal-api.ts`:
  - Added `systemPrompt` to tenant response pipeline:
    - `getPortalTenant()` now selects `c.system_prompt`
    - `PortalTenantRow` now includes `system_prompt`
    - `serializePortalTenant()` now returns `systemPrompt`
  - Extended `PATCH /api/portal/tenant/:tenantId`:
    - Added `systemPrompt` support with validation (trimmed non-empty string, minimum 10 chars)
    - Uses existing update pattern: `addUpdate("system_prompt", systemPrompt)`
  - Added new endpoint: `GET /api/portal/tenant/:tenantId/usage`
    - Reads current-month usage from `usage_monthly`
    - Reads client plan from `clients.plan`
    - Applies plan limits map:
      - trial → callLimit 50, minuteLimit 120
      - starter → callLimit 200, minuteLimit 500
      - growth → callLimit 500, minuteLimit 1500
    - Returns zeroed usage when no current-month row exists
  - Added new endpoint: `POST /api/portal/tenant/:tenantId/test-call`
    - Accepts `{ toPhone }`
    - Validates E.164 format (`/^\+[1-9]\d{7,14}$/`)
    - Looks up tenant Twilio number via `clients.phone_number`
    - Enforces in-memory per-tenant rate limit (max 3 calls per rolling hour)
    - Initiates outbound test call with Twilio REST API using `/incoming-call` webhook URL
    - Returns `429` with `Rate limit: max 3 test calls per hour` when capped
- Updated dependencies:
  - `package.json` + lockfile: added `twilio`

### Files touched
- `src/portal-api.ts`
- `package.json`
- `package-lock.json`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ✅

### Gotchas for next batch
- Test-call limiter is in-memory and resets on process restart or horizontal scaling.
- Test-call endpoint requires `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` env vars.
- Usage endpoint defaults unknown/missing plans to trial limits.

### Git
- Commit: `d492341`
- Push: `origin/feature/portal-extensions`
