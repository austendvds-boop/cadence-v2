BEGIN;

CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stream_sid TEXT,
  caller_phone TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  transcript_turns INTEGER NOT NULL DEFAULT 0,
  summary_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_sessions_duration_non_negative CHECK (duration_seconds >= 0),
  CONSTRAINT call_sessions_turns_non_negative CHECK (transcript_turns >= 0)
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_client_started
  ON call_sessions (client_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_sessions_stream_sid
  ON call_sessions (stream_sid)
  WHERE stream_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS call_transcripts (
  id BIGSERIAL PRIMARY KEY,
  call_session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('caller', 'cadence', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_transcripts_turn_index_non_negative CHECK (turn_index >= 0),
  CONSTRAINT call_transcripts_session_turn_uk UNIQUE (call_session_id, turn_index, speaker)
);

CREATE INDEX IF NOT EXISTS idx_call_transcripts_session
  ON call_transcripts (call_session_id, turn_index);

CREATE TABLE IF NOT EXISTS usage_monthly (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month_start DATE NOT NULL,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_duration_seconds INTEGER NOT NULL DEFAULT 0,
  total_transcript_turns INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_monthly_calls_non_negative CHECK (total_calls >= 0),
  CONSTRAINT usage_monthly_duration_non_negative CHECK (total_duration_seconds >= 0),
  CONSTRAINT usage_monthly_turns_non_negative CHECK (total_transcript_turns >= 0),
  CONSTRAINT usage_monthly_client_month_uk UNIQUE (client_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_monthly_month
  ON usage_monthly (month_start DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (filename)
    VALUES ('004-calls-transcripts.sql')
    ON CONFLICT (filename) DO NOTHING;
  END IF;
END
$$;

COMMIT;
