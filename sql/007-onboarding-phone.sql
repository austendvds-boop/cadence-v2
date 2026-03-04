BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  call_sid TEXT NOT NULL UNIQUE,
  stream_sid TEXT,
  caller_phone TEXT,
  status TEXT NOT NULL DEFAULT 'greeting'
    CHECK (status IN ('greeting', 'interview', 'confirm', 'provisioning', 'provisioned', 'failed')),
  onboarding_session_id UUID REFERENCES onboarding_sessions(id),
  provision_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_call_sessions_client_id
  ON onboarding_call_sessions (client_id);

CREATE INDEX IF NOT EXISTS idx_onboarding_call_sessions_status
  ON onboarding_call_sessions (status);

CREATE TABLE IF NOT EXISTS onboarding_fields (
  id BIGSERIAL PRIMARY KEY,
  onboarding_call_session_id UUID NOT NULL REFERENCES onboarding_call_sessions(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL
    CHECK (field_name IN ('business_name', 'type', 'hours', 'services', 'faqs', 'transfer_number', 'email')),
  field_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_fields_session_field_uk UNIQUE (onboarding_call_session_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_fields_session_id
  ON onboarding_fields (onboarding_call_session_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (filename)
    VALUES ('007-onboarding-phone.sql')
    ON CONFLICT (filename) DO NOTHING;
  END IF;
END
$$;

COMMIT;
