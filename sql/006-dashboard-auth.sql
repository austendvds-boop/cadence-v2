BEGIN;

CREATE TABLE IF NOT EXISTS dashboard_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('client_admin', 'platform_admin')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_dashboard_users_client_id
  ON dashboard_users (client_id);

CREATE INDEX IF NOT EXISTS idx_dashboard_users_role_active
  ON dashboard_users (role, active);

CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_user_created
  ON magic_link_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires
  ON magic_link_tokens (expires_at);

INSERT INTO dashboard_users (client_id, email, role, active)
VALUES (NULL, 'aust@autom8everything.com', 'platform_admin', true)
ON CONFLICT (email)
DO UPDATE SET
  role = EXCLUDED.role,
  active = true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (filename)
    VALUES ('006-dashboard-auth.sql')
    ON CONFLICT (filename) DO NOTHING;
  END IF;
END
$$;

COMMIT;
