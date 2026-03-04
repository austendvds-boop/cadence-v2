BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS business_type TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS sms_number TEXT,
  ADD COLUMN IF NOT EXISTS intake_mode TEXT,
  ADD COLUMN IF NOT EXISTS fallback_mode TEXT,
  ADD COLUMN IF NOT EXISTS tools_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS business_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE clients SET tools_config = '{}'::jsonb WHERE tools_config IS NULL;
UPDATE clients SET business_profile = '{}'::jsonb WHERE business_profile IS NULL;

ALTER TABLE clients ALTER COLUMN tools_config SET DEFAULT '{}'::jsonb;
ALTER TABLE clients ALTER COLUMN tools_config SET NOT NULL;
ALTER TABLE clients ALTER COLUMN business_profile SET DEFAULT '{}'::jsonb;
ALTER TABLE clients ALTER COLUMN business_profile SET NOT NULL;

CREATE TABLE IF NOT EXISTS client_hours (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_open BOOLEAN NOT NULL DEFAULT false,
  open_time TIME,
  close_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_hours_open_window_chk CHECK (
    (is_open = false AND open_time IS NULL AND close_time IS NULL)
    OR (is_open = true AND open_time IS NOT NULL AND close_time IS NOT NULL AND open_time < close_time)
  ),
  CONSTRAINT client_hours_client_day_uk UNIQUE (client_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS client_services (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_text TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_faqs (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_business_type ON clients (business_type);
CREATE INDEX IF NOT EXISTS idx_clients_timezone ON clients (timezone);
CREATE INDEX IF NOT EXISTS idx_clients_sms_number ON clients (sms_number);

CREATE INDEX IF NOT EXISTS idx_client_hours_client_id ON client_hours (client_id);
CREATE INDEX IF NOT EXISTS idx_client_hours_client_day ON client_hours (client_id, day_of_week);

CREATE INDEX IF NOT EXISTS idx_client_services_client_id ON client_services (client_id);
CREATE INDEX IF NOT EXISTS idx_client_services_client_active_sort ON client_services (client_id, active, sort_order);

CREATE INDEX IF NOT EXISTS idx_client_faqs_client_id ON client_faqs (client_id);
CREATE INDEX IF NOT EXISTS idx_client_faqs_client_active_sort ON client_faqs (client_id, active, sort_order);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (filename)
    VALUES ('003-tenant-config.sql')
    ON CONFLICT (filename) DO NOTHING;
  END IF;
END
$$;

COMMIT;
