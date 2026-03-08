import { pool } from "./db";
import { setCallEndedHook, type CallEndedEvent } from "./call-handler";
import { checkAndHandleUsage } from "./usage-limits";

type TranscriptTurn = {
  speaker: "caller" | "cadence";
  content: string;
};

let isCallLoggerRegistered = false;

function normalizeTranscriptTurns(turns: Array<{ role: "user" | "assistant"; content: string }>): TranscriptTurn[] {
  return turns
    .map(
      (turn): TranscriptTurn => ({
        speaker: turn.role === "user" ? "caller" : "cadence",
        content: turn.content.trim()
      })
    )
    .filter((turn) => turn.content.length > 0);
}

function normalizeSummary(summary: string[]): string[] {
  return summary.map((line) => line.trim()).filter((line) => line.length > 0);
}

function getDurationSeconds(startedAt: Date, endedAt: Date): number {
  const durationMs = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.round(durationMs / 1000));
}

async function persistCallLog(event: CallEndedEvent): Promise<void> {
  const startedAt = event.startedAt instanceof Date ? event.startedAt : new Date(event.startedAt);
  const endedAt = event.endedAt instanceof Date ? event.endedAt : new Date(event.endedAt);
  const durationSeconds = getDurationSeconds(startedAt, endedAt);

  const transcriptTurns = normalizeTranscriptTurns(event.conversationHistory);
  const summaryLines = normalizeSummary(event.callSummary);

  const streamSid = event.streamSid.trim() || null;
  const callerPhone = event.callerPhone.trim() || "unknown";

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    if (streamSid) {
      const existing = await dbClient.query<{ id: string }>(
        "SELECT id FROM call_sessions WHERE stream_sid = $1 LIMIT 1",
        [streamSid]
      );

      if (existing.rowCount && existing.rowCount > 0) {
        await dbClient.query("ROLLBACK");
        return;
      }
    }

    const insertedSession = await dbClient.query<{ id: string }>(
      `INSERT INTO call_sessions (
        client_id,
        stream_sid,
        caller_phone,
        started_at,
        ended_at,
        duration_seconds,
        transcript_turns,
        summary_lines
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id`,
      [
        event.client.clientId,
        streamSid,
        callerPhone,
        startedAt.toISOString(),
        endedAt.toISOString(),
        durationSeconds,
        transcriptTurns.length,
        JSON.stringify(summaryLines)
      ]
    );

    const callSessionId = insertedSession.rows[0].id;

    for (let index = 0; index < transcriptTurns.length; index += 1) {
      const turn = transcriptTurns[index];
      await dbClient.query(
        `INSERT INTO call_transcripts (
          call_session_id,
          turn_index,
          speaker,
          content
        ) VALUES ($1, $2, $3, $4)`,
        [callSessionId, index, turn.speaker, turn.content]
      );
    }

    await dbClient.query(
      `INSERT INTO usage_monthly (
        client_id,
        month_start,
        total_calls,
        total_duration_seconds,
        total_transcript_turns,
        updated_at
      ) VALUES (
        $1,
        date_trunc('month', $2::timestamptz)::date,
        1,
        $3,
        $4,
        now()
      )
      ON CONFLICT (client_id, month_start)
      DO UPDATE SET
        total_calls = usage_monthly.total_calls + EXCLUDED.total_calls,
        total_duration_seconds = usage_monthly.total_duration_seconds + EXCLUDED.total_duration_seconds,
        total_transcript_turns = usage_monthly.total_transcript_turns + EXCLUDED.total_transcript_turns,
        updated_at = now()`,
      [event.client.clientId, startedAt.toISOString(), durationSeconds, transcriptTurns.length]
    );

    await dbClient.query("COMMIT");

    // After COMMIT, check usage limits (non-blocking)
    setImmediate(() => {
      checkAndHandleUsage(event.client.clientId).catch((err) => {
        console.error(`[CALL:${event.streamSid}] usage check failed`, err);
      });
    });
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}

export function registerCallLogger(): void {
  if (isCallLoggerRegistered) return;
  isCallLoggerRegistered = true;

  setCallEndedHook(async (event) => {
    try {
      await persistCallLog(event);
    } catch (err) {
      console.error(`[CALL:${event.streamSid}] call logger failed`, err);
    }
  });
}
