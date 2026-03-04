BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'onboarding_fields'
  ) THEN
    ALTER TABLE onboarding_fields
      DROP CONSTRAINT IF EXISTS onboarding_fields_field_name_check;

    ALTER TABLE onboarding_fields
      ADD CONSTRAINT onboarding_fields_field_name_check
      CHECK (field_name IN ('business_name', 'type', 'hours', 'services', 'faqs', 'call_handling', 'transfer_number', 'email'));
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (filename)
    VALUES ('008-onboarding-call-handling-field.sql')
    ON CONFLICT (filename) DO NOTHING;
  END IF;
END
$$;

COMMIT;
