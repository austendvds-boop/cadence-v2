# Ralph Context

## 2026-03-07 Batch (portal usage overage fields + settlement cron)

### Files created/modified
- `src/portal-api.ts`
- `src/cron/settle-overages.ts` (new)
- `src/index.ts`
- `docs/CODER-CONTEXT.md`
- `docs/ralph-context.md`

### Key exports / interfaces
- `src/cron/settle-overages.ts`
  - `settleOverages(req: Request, res: Response): Promise<void>`
- `src/portal-api.ts`
  - `UsageMonthlyRow` now includes overage fields from `usage_monthly`
  - `/tenant/:tenantId/usage` response now includes `overage` object and plan overage rate/cap fields

### Gotchas for next batch
- `settleOverages` requires `STRIPE_SECRET_KEY` and optional `CRON_SECRET` auth; if `CRON_SECRET` is set, the route rejects missing/mismatched secret.
- Settlement query bills only previous month rows where `overage_billed_cents = 0` and usage exceeded `monthly_minutes_limit`.
- Current month reset step flips `overage_disabled` back to `false` for matching rows.

---

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
