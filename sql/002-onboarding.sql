CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending_checkout'
    CHECK (status IN ('pending_checkout', 'checkout_complete', 'provisioning', 'provisioned', 'failed')),

  business_name TEXT NOT NULL,
  business_description TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  website TEXT NOT NULL,
  hours TEXT NOT NULL,
  services TEXT NOT NULL,
  faqs TEXT NOT NULL,
  booking_instructions TEXT NOT NULL,
  transfer_number TEXT,
  booking_url TEXT,
  greeting TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  preferred_area_code TEXT NOT NULL,

  stripe_checkout_session_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,

  provisioned_client_id UUID REFERENCES clients(id),
  provisioned_phone_number TEXT,
  provision_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provisioned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_onboarding_stripe_checkout
  ON onboarding_sessions (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS onboarding_session_id UUID REFERENCES onboarding_sessions(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS number_release_after TIMESTAMPTZ;
