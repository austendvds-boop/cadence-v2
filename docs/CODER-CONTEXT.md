# Coder Context

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
- Commit: `<pending>`
- Push: `<pending>`

---

## 2026-03-06 (Portal API endpoints for autom8-everything cross-service access)

### Task
Add protected `/api/portal` endpoints authenticated by `X-Portal-Secret` for portal-to-cadence cross-service reads/updates.

### Changes made
- Added new router:
  - `src/portal-api.ts` (new)
    - Router-level `requirePortalSecret` middleware using `crypto.timingSafeEqual` with safe length handling.
    - `GET /tenant/:tenantId`
      - Returns tenant settings + business profile + hours/services/faqs from `clients`, `client_hours`, `client_services`, `client_faqs`.
      - 404 when tenant not found.
    - `PATCH /tenant/:tenantId`
      - Supports optional updates for `greeting`, `transferNumber`, `bookingUrl`, `timezone`, `businessProfile`, `hours`, `services`, `faqs`.
      - Uses transaction pattern aligned with dashboard settings updater.
      - Calls `clearTenantRuntimeConfigCache(tenantId)` after commit.
      - Returns `{ ok: true, tenant: ... }` with updated settings snapshot.
    - `GET /tenant/:tenantId/calls`
      - Supports `limit` (default 50, max 200) and `offset` (default 0).
      - Returns mapped call session payload + pagination.
- Updated API wiring:
  - `src/index.ts`
    - added `import portalApiRouter from "./portal-api"`
    - mounted `app.use("/api/portal", portalApiRouter)`
- Updated env template:
  - `.env.example`
    - added `PORTAL_API_SECRET=`

### Files touched
- `src/portal-api.ts` (new at the time)
- `src/index.ts`
- `.env.example`
- `docs/CODER-CONTEXT.md`

### Gotchas
- Middleware returns `500` if `PORTAL_API_SECRET` is missing/blank.
- Returns `401` for missing/incorrect `X-Portal-Secret`.

---

## 2026-03-04 (Phase 4a dashboard API + magic link auth)

### Task
Implement dashboard authentication and API surface: magic-link auth, client dashboard endpoints, admin endpoints, and auth schema migration with seeded platform admin user.

### Changes made
- Added migration `sql/006-dashboard-auth.sql`:
  - `dashboard_users`
  - `magic_link_tokens`
  - dashboard auth lookup indexes
  - platform admin seed (`aust@autom8everything.com`)
- Added `src/dashboard/auth.ts`:
  - `POST /dashboard/auth/request-link`
  - `GET /dashboard/auth/verify?token=...`
  - `POST /dashboard/auth/logout`
  - signed session cookie handling
  - Gmail credential parsing + SMTP send via nodemailer
- Added `src/dashboard/client-api.ts`:
  - `GET /dashboard/api/calls`
  - `GET /dashboard/api/usage`
  - `PUT /dashboard/api/settings`
- Added `src/dashboard/admin-api.ts`:
  - `GET /dashboard/api/admin/clients`
  - `GET /dashboard/api/admin/export`
- Updated `src/index.ts` route mounting for dashboard auth/admin/client APIs.
- Updated `package.json` dependencies:
  - added `nodemailer`
  - added `@types/nodemailer`

### Files touched
- `sql/006-dashboard-auth.sql`
- `src/dashboard/auth.ts`
- `src/dashboard/client-api.ts`
- `src/dashboard/admin-api.ts`
- `src/index.ts`
- `package.json`
- `docs/CODER-CONTEXT.md`

### Verification
- `npm run build` ✅
- Frozen voice files untouched (`src/stt.ts`, `src/tts.ts`, `src/call-handler.ts`, `src/llm.ts`) ✅
