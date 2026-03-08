# Ralph Context

## 2026-03-07 Batch (usage-limits core)

### Files created/modified
- `docs/migrations/2026-03-07-usage-limits.sql` (new)
- `src/usage-limits.ts` (new)
- `src/call-logger.ts`
- `src/deactivation-policy.ts`
- `src/index.ts`
- `src/db.ts`

### Key exports / interfaces
- `src/usage-limits.ts`
  - `checkAndHandleUsage(clientId: string): Promise<void>`
- `src/deactivation-policy.ts`
  - `isOverageDisabled(clientId: string): Promise<boolean>`
  - `renderOverageDisabledTwiml(businessName?: string | null): string`
  - `DeactivationReason` now includes `"overage_disabled"`
- `src/db.ts`
  - `Client` includes: `monthly_minutes_limit`, `overage_rate_cents`, `overage_cap_cents`

### Gotchas for next batch
- Overage-disabled state is stored on `usage_monthly` by month, not on `clients`.
- Incoming-call flow checks overage-disabled separately after `getDeactivationReason(...)`.
- Usage checks run asynchronously post-commit in `persistCallLog` via `setImmediate`, so failures only log and do not block call logging.
- Stripe pre-auth only runs when over-limit and `stripe_customer_id` exists.
