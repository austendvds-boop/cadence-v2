-- Usage limits columns on clients
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS monthly_minutes_limit integer,
  ADD COLUMN IF NOT EXISTS overage_rate_cents integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS overage_cap_cents integer NOT NULL DEFAULT 7500;

-- Backfill limits based on existing plan
UPDATE clients SET monthly_minutes_limit = 200 WHERE plan = 'starter' AND monthly_minutes_limit IS NULL;
UPDATE clients SET monthly_minutes_limit = 500 WHERE plan = 'growth' AND monthly_minutes_limit IS NULL;
-- trial: handled in code as 120 min. pro: NULL means unlimited.

-- Overage tracking on usage_monthly
ALTER TABLE usage_monthly
  ADD COLUMN IF NOT EXISTS overage_preauth_intent_id text,
  ADD COLUMN IF NOT EXISTS overage_billed_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overage_notified_at timestamptz;
