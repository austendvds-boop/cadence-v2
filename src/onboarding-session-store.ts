import { pool } from "./db";

export const ONBOARDING_FIELD_NAMES = [
  "business_name",
  "type",
  "hours",
  "services",
  "faqs",
  "call_handling",
  "transfer_number",
  "email"
] as const;

export type OnboardingFieldName = (typeof ONBOARDING_FIELD_NAMES)[number];

export const REQUIRED_ONBOARDING_FIELDS: OnboardingFieldName[] = [
  "business_name",
  "type",
  "hours",
  "services",
  "faqs",
  "call_handling",
  "email"
];

export type OnboardingCallSessionStatus =
  | "greeting"
  | "interview"
  | "confirm"
  | "provisioning"
  | "provisioned"
  | "failed";

export interface OnboardingCallSessionState {
  id: string;
  clientId: string;
  callSid: string;
  streamSid: string;
  callerPhone: string;
  status: OnboardingCallSessionStatus;
  onboardingSessionId: string | null;
  provisionError: string | null;
  fields: Partial<Record<OnboardingFieldName, string>>;
  createdAt: string;
  updatedAt: string;
}

type OnboardingCallSessionRow = {
  id: string;
  client_id: string;
  call_sid: string;
  stream_sid: string | null;
  caller_phone: string | null;
  status: OnboardingCallSessionStatus;
  onboarding_session_id: string | null;
  provision_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type OnboardingFieldRow = {
  field_name: string;
  field_value: string;
};

function normalizeSessionKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("callSid is required for onboarding session operations");
  }
  return trimmed;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function sanitizeFieldValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isOnboardingFieldName(value: string): value is OnboardingFieldName {
  return (ONBOARDING_FIELD_NAMES as readonly string[]).includes(value);
}

export class OnboardingSessionStore {
  private readonly sessionsByCallSid = new Map<string, OnboardingCallSessionState>();

  async ensureSession(input: {
    clientId: string;
    callSid: string;
    streamSid: string;
    callerPhone: string;
  }): Promise<OnboardingCallSessionState> {
    const callSid = normalizeSessionKey(input.callSid || input.streamSid);
    const cached = this.sessionsByCallSid.get(callSid);
    if (cached) return cached;

    const existing = await this.fetchSessionByCallSid(callSid);
    if (existing) {
      this.sessionsByCallSid.set(callSid, existing);
      return existing;
    }

    const inserted = await pool.query<OnboardingCallSessionRow>(
      `INSERT INTO onboarding_call_sessions (
        client_id, call_sid, stream_sid, caller_phone, status
      ) VALUES ($1, $2, $3, $4, 'greeting')
      RETURNING
        id,
        client_id,
        call_sid,
        stream_sid,
        caller_phone,
        status,
        onboarding_session_id,
        provision_error,
        created_at,
        updated_at`,
      [input.clientId, callSid, input.streamSid || null, input.callerPhone || null]
    );

    const session = this.hydrateSessionRow(inserted.rows[0], {});
    this.sessionsByCallSid.set(callSid, session);
    return session;
  }

  async getSession(callSid: string): Promise<OnboardingCallSessionState | null> {
    const key = normalizeSessionKey(callSid);
    const cached = this.sessionsByCallSid.get(key);
    if (cached) return cached;

    const loaded = await this.fetchSessionByCallSid(key);
    if (!loaded) return null;

    this.sessionsByCallSid.set(key, loaded);
    return loaded;
  }

  async saveField(callSid: string, field: OnboardingFieldName, value: string): Promise<OnboardingCallSessionState | null> {
    const key = normalizeSessionKey(callSid);
    const session = await this.getSession(key);
    if (!session) return null;

    const normalizedValue = sanitizeFieldValue(value);

    await pool.query(
      `INSERT INTO onboarding_fields (onboarding_call_session_id, field_name, field_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (onboarding_call_session_id, field_name)
       DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = now()`,
      [session.id, field, normalizedValue]
    );

    await pool.query("UPDATE onboarding_call_sessions SET updated_at = now() WHERE id = $1", [session.id]);

    const next: OnboardingCallSessionState = {
      ...session,
      fields: {
        ...session.fields,
        [field]: normalizedValue
      },
      updatedAt: new Date().toISOString()
    };

    this.sessionsByCallSid.set(key, next);
    return next;
  }

  async setStatus(
    callSid: string,
    status: OnboardingCallSessionStatus,
    options?: { onboardingSessionId?: string | null; provisionError?: string | null }
  ): Promise<OnboardingCallSessionState | null> {
    const key = normalizeSessionKey(callSid);
    const session = await this.getSession(key);
    if (!session) return null;

    const onboardingSessionId = options?.onboardingSessionId ?? session.onboardingSessionId;
    const provisionError = options?.provisionError ?? (status === "failed" ? session.provisionError : null);

    const updated = await pool.query<OnboardingCallSessionRow>(
      `UPDATE onboarding_call_sessions
       SET status = $2,
           onboarding_session_id = $3,
           provision_error = $4,
           updated_at = now()
       WHERE id = $1
       RETURNING
         id,
         client_id,
         call_sid,
         stream_sid,
         caller_phone,
         status,
         onboarding_session_id,
         provision_error,
         created_at,
         updated_at`,
      [session.id, status, onboardingSessionId, provisionError]
    );

    const row = updated.rows[0] || {
      id: session.id,
      client_id: session.clientId,
      call_sid: session.callSid,
      stream_sid: session.streamSid,
      caller_phone: session.callerPhone,
      status,
      onboarding_session_id: onboardingSessionId,
      provision_error: provisionError,
      created_at: session.createdAt,
      updated_at: new Date().toISOString()
    };

    const next = this.hydrateSessionRow(row, session.fields);
    this.sessionsByCallSid.set(key, next);
    return next;
  }

  async getMissingRequiredFields(callSid: string): Promise<OnboardingFieldName[]> {
    const session = await this.getSession(callSid);
    if (!session) return [...REQUIRED_ONBOARDING_FIELDS];

    return REQUIRED_ONBOARDING_FIELDS.filter((field) => {
      const value = session.fields[field];
      return !value || value.trim().length === 0;
    });
  }

  private async fetchSessionByCallSid(callSid: string): Promise<OnboardingCallSessionState | null> {
    const rowResult = await pool.query<OnboardingCallSessionRow>(
      `SELECT
         id,
         client_id,
         call_sid,
         stream_sid,
         caller_phone,
         status,
         onboarding_session_id,
         provision_error,
         created_at,
         updated_at
       FROM onboarding_call_sessions
       WHERE call_sid = $1
       LIMIT 1`,
      [callSid]
    );

    const row = rowResult.rows[0];
    if (!row) return null;

    const fieldResult = await pool.query<OnboardingFieldRow>(
      `SELECT field_name, field_value
       FROM onboarding_fields
       WHERE onboarding_call_session_id = $1`,
      [row.id]
    );

    const fields: Partial<Record<OnboardingFieldName, string>> = {};
    for (const fieldRow of fieldResult.rows) {
      if (!isOnboardingFieldName(fieldRow.field_name)) continue;
      fields[fieldRow.field_name] = fieldRow.field_value;
    }

    return this.hydrateSessionRow(row, fields);
  }

  private hydrateSessionRow(
    row: OnboardingCallSessionRow,
    fields: Partial<Record<OnboardingFieldName, string>>
  ): OnboardingCallSessionState {
    return {
      id: row.id,
      clientId: row.client_id,
      callSid: row.call_sid,
      streamSid: row.stream_sid || "",
      callerPhone: row.caller_phone || "unknown",
      status: row.status,
      onboardingSessionId: row.onboarding_session_id,
      provisionError: row.provision_error,
      fields,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at)
    };
  }
}

export const onboardingSessionStore = new OnboardingSessionStore();
