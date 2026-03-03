CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,
  system_prompt TEXT NOT NULL,
  transfer_number TEXT,
  greeting TEXT NOT NULL,
  sms_enabled BOOLEAN NOT NULL DEFAULT false,
  booking_url TEXT,
  owner_phone TEXT,
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'starter', 'growth')),
  trial_ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone_number);
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer ON clients (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_stripe_subscription ON clients (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
