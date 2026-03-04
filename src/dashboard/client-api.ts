import express from "express";
import { pool } from "../db";
import { clearTenantRuntimeConfigCache } from "../tenant-config";
import {
  isPlatformAdmin,
  requireDashboardUser,
  type DashboardAuthedRequest
} from "./auth";

const router = express.Router();

type CallSessionRow = {
  id: string;
  client_id: string;
  stream_sid: string | null;
  caller_phone: string | null;
  started_at: Date | string;
  ended_at: Date | string;
  duration_seconds: number;
  transcript_turns: number;
  summary_lines: unknown;
};

type UsageMonthlyRow = {
  month_start: Date | string;
  total_calls: number;
  total_duration_seconds: number;
  total_transcript_turns: number;
  updated_at: Date | string;
};

type UpdatedClientRow = {
  id: string;
  business_name: string;
  greeting: string;
  transfer_number: string | null;
  sms_enabled: boolean;
  booking_url: string | null;
  owner_phone: string | null;
  timezone: string | null;
  fallback_mode: string | null;
  intake_mode: string | null;
  sms_number: string | null;
};

type RawBody = Record<string, unknown>;

function parseDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return new Date(0).toISOString();
  return parsed.toISOString();
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, Math.floor(value)));
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    }
  }

  return fallback;
}

function asOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
}

function normalizeSummaryLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function serializeClientSettings(row: UpdatedClientRow) {
  return {
    id: row.id,
    businessName: row.business_name,
    greeting: row.greeting,
    transferNumber: row.transfer_number,
    smsEnabled: row.sms_enabled,
    bookingUrl: row.booking_url,
    ownerPhone: row.owner_phone,
    timezone: row.timezone,
    fallbackMode: row.fallback_mode,
    intakeMode: row.intake_mode,
    smsNumber: row.sms_number
  };
}

function resolveClientId(req: DashboardAuthedRequest): string | null {
  const user = req.dashboardUser;
  if (!user) return null;

  const queryClientId = typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
  if (queryClientId && isPlatformAdmin(user)) {
    return queryClientId;
  }

  return user.clientId;
}

async function ensureClientAccess(req: DashboardAuthedRequest, res: express.Response): Promise<string | null> {
  const clientId = resolveClientId(req);

  if (!clientId) {
    res.status(403).json({ error: "No client scope available for this account" });
    return null;
  }

  return clientId;
}

router.use(requireDashboardUser);

router.get("/settings", async (req, res) => {
  const clientId = await ensureClientAccess(req, res);
  if (!clientId) return;

  const result = await pool.query<UpdatedClientRow>(
    `SELECT
      id,
      business_name,
      greeting,
      transfer_number,
      sms_enabled,
      booking_url,
      owner_phone,
      timezone,
      fallback_mode,
      intake_mode,
      sms_number
     FROM clients
     WHERE id = $1
     LIMIT 1`,
    [clientId]
  );

  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.status(200).json({
    settings: serializeClientSettings(row)
  });
});

router.get("/calls", async (req, res) => {
  const clientId = await ensureClientAccess(req, res);
  if (!clientId) return;

  const limit = parseBoundedInt(req.query.limit, 50, 1, 200);
  const offset = parseBoundedInt(req.query.offset, 0, 0, 100_000);

  const result = await pool.query<CallSessionRow>(
    `SELECT
      id,
      client_id,
      stream_sid,
      caller_phone,
      started_at,
      ended_at,
      duration_seconds,
      transcript_turns,
      summary_lines
     FROM call_sessions
     WHERE client_id = $1
     ORDER BY started_at DESC
     LIMIT $2 OFFSET $3`,
    [clientId, limit, offset]
  );

  res.status(200).json({
    calls: result.rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      streamSid: row.stream_sid,
      callerPhone: row.caller_phone,
      startedAt: parseDate(row.started_at),
      endedAt: parseDate(row.ended_at),
      durationSeconds: row.duration_seconds,
      transcriptTurns: row.transcript_turns,
      summaryLines: normalizeSummaryLines(row.summary_lines)
    })),
    pagination: { limit, offset }
  });
});

router.get("/usage", async (req, res) => {
  const clientId = await ensureClientAccess(req, res);
  if (!clientId) return;

  const months = parseBoundedInt(req.query.months, 6, 1, 36);

  const result = await pool.query<UsageMonthlyRow>(
    `SELECT
      month_start,
      total_calls,
      total_duration_seconds,
      total_transcript_turns,
      updated_at
     FROM usage_monthly
     WHERE client_id = $1
     ORDER BY month_start DESC
     LIMIT $2`,
    [clientId, months]
  );

  res.status(200).json({
    usage: result.rows.map((row) => ({
      monthStart: parseDate(row.month_start).slice(0, 10),
      totalCalls: row.total_calls,
      totalDurationSeconds: row.total_duration_seconds,
      totalTranscriptTurns: row.total_transcript_turns,
      updatedAt: parseDate(row.updated_at)
    }))
  });
});

router.put("/settings", async (req, res) => {
  const clientId = await ensureClientAccess(req, res);
  if (!clientId) return;

  const body = (asPlainObject(req.body) || {}) as RawBody;

  const updates: Array<{ clause: string; value: unknown }> = [];

  const addUpdate = (column: string, value: unknown, cast?: string) => {
    const placeholder = `$${updates.length + 2}`;
    updates.push({ clause: `${column} = ${placeholder}${cast || ""}`, value });
  };

  if (Object.prototype.hasOwnProperty.call(body, "businessName")) {
    const businessName = asOptionalString(body.businessName);
    if (!businessName) {
      res.status(400).json({ error: "businessName must be a non-empty string" });
      return;
    }
    addUpdate("business_name", businessName);
  }

  if (Object.prototype.hasOwnProperty.call(body, "greeting")) {
    const greeting = asOptionalString(body.greeting);
    if (!greeting) {
      res.status(400).json({ error: "greeting must be a non-empty string" });
      return;
    }
    addUpdate("greeting", greeting);
  }

  if (Object.prototype.hasOwnProperty.call(body, "transferNumber")) {
    addUpdate("transfer_number", asOptionalString(body.transferNumber));
  }

  if (Object.prototype.hasOwnProperty.call(body, "smsEnabled")) {
    if (typeof body.smsEnabled !== "boolean") {
      res.status(400).json({ error: "smsEnabled must be boolean" });
      return;
    }
    addUpdate("sms_enabled", body.smsEnabled);
  }

  if (Object.prototype.hasOwnProperty.call(body, "bookingUrl")) {
    addUpdate("booking_url", asOptionalString(body.bookingUrl));
  }

  if (Object.prototype.hasOwnProperty.call(body, "ownerPhone")) {
    addUpdate("owner_phone", asOptionalString(body.ownerPhone));
  }

  if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
    addUpdate("timezone", asOptionalString(body.timezone));
  }

  if (Object.prototype.hasOwnProperty.call(body, "fallbackMode")) {
    addUpdate("fallback_mode", asOptionalString(body.fallbackMode));
  }

  if (Object.prototype.hasOwnProperty.call(body, "intakeMode")) {
    addUpdate("intake_mode", asOptionalString(body.intakeMode));
  }

  if (Object.prototype.hasOwnProperty.call(body, "smsNumber")) {
    addUpdate("sms_number", asOptionalString(body.smsNumber));
  }

  if (Object.prototype.hasOwnProperty.call(body, "businessProfile")) {
    const profile = asPlainObject(body.businessProfile);
    if (!profile) {
      res.status(400).json({ error: "businessProfile must be a JSON object" });
      return;
    }
    addUpdate("business_profile", JSON.stringify(profile), "::jsonb");
  }

  if (Object.prototype.hasOwnProperty.call(body, "toolsConfig")) {
    const tools = asPlainObject(body.toolsConfig);
    if (!tools) {
      res.status(400).json({ error: "toolsConfig must be a JSON object" });
      return;
    }
    addUpdate("tools_config", JSON.stringify(tools), "::jsonb");
  }

  const hasHours = Object.prototype.hasOwnProperty.call(body, "hours");
  const hasServices = Object.prototype.hasOwnProperty.call(body, "services");
  const hasFaqs = Object.prototype.hasOwnProperty.call(body, "faqs");

  if (updates.length === 0 && !hasHours && !hasServices && !hasFaqs) {
    res.status(400).json({ error: "No supported settings provided" });
    return;
  }

  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");

    if (updates.length > 0) {
      const sql = `UPDATE clients
        SET ${updates.map((item) => item.clause).join(", ")}, updated_at = now()
        WHERE id = $1`;
      await dbClient.query(sql, [clientId, ...updates.map((item) => item.value)]);
    }

    if (hasHours) {
      if (!Array.isArray(body.hours)) {
        res.status(400).json({ error: "hours must be an array" });
        await dbClient.query("ROLLBACK");
        return;
      }

      await dbClient.query("DELETE FROM client_hours WHERE client_id = $1", [clientId]);

      for (const rawHour of body.hours) {
        const hour = asPlainObject(rawHour);
        if (!hour) continue;

        const dayOfWeek = parseBoundedInt(hour.dayOfWeek, -1, -1, 6);
        if (dayOfWeek < 0 || dayOfWeek > 6) continue;

        const isOpen = Boolean(hour.isOpen);
        const openTime = asOptionalString(hour.openTime);
        const closeTime = asOptionalString(hour.closeTime);

        if (isOpen && (!openTime || !closeTime || !isValidTimeString(openTime) || !isValidTimeString(closeTime))) {
          continue;
        }

        await dbClient.query(
          `INSERT INTO client_hours (client_id, day_of_week, is_open, open_time, close_time)
           VALUES ($1, $2, $3, $4::time, $5::time)`,
          [clientId, dayOfWeek, isOpen, isOpen ? openTime : null, isOpen ? closeTime : null]
        );
      }
    }

    if (hasServices) {
      if (!Array.isArray(body.services)) {
        res.status(400).json({ error: "services must be an array" });
        await dbClient.query("ROLLBACK");
        return;
      }

      await dbClient.query("DELETE FROM client_services WHERE client_id = $1", [clientId]);

      for (let index = 0; index < body.services.length; index += 1) {
        const service = asPlainObject(body.services[index]);
        if (!service) continue;

        const name = asOptionalString(service.name);
        if (!name) continue;

        const description = asOptionalString(service.description);
        const priceText = asOptionalString(service.priceText);
        const active = typeof service.active === "boolean" ? service.active : true;
        const sortOrder = parseBoundedInt(service.sortOrder, index, 0, 9999);

        await dbClient.query(
          `INSERT INTO client_services (client_id, name, description, price_text, active, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [clientId, name, description, priceText, active, sortOrder]
        );
      }
    }

    if (hasFaqs) {
      if (!Array.isArray(body.faqs)) {
        res.status(400).json({ error: "faqs must be an array" });
        await dbClient.query("ROLLBACK");
        return;
      }

      await dbClient.query("DELETE FROM client_faqs WHERE client_id = $1", [clientId]);

      for (let index = 0; index < body.faqs.length; index += 1) {
        const faq = asPlainObject(body.faqs[index]);
        if (!faq) continue;

        const question = asOptionalString(faq.question);
        const answer = asOptionalString(faq.answer);
        if (!question || !answer) continue;

        const active = typeof faq.active === "boolean" ? faq.active : true;
        const sortOrder = parseBoundedInt(faq.sortOrder, index, 0, 9999);

        await dbClient.query(
          `INSERT INTO client_faqs (client_id, question, answer, active, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [clientId, question, answer, active, sortOrder]
        );
      }
    }

    const updated = await dbClient.query<UpdatedClientRow>(
      `SELECT
        id,
        business_name,
        greeting,
        transfer_number,
        sms_enabled,
        booking_url,
        owner_phone,
        timezone,
        fallback_mode,
        intake_mode,
        sms_number
       FROM clients
       WHERE id = $1
       LIMIT 1`,
      [clientId]
    );

    await dbClient.query("COMMIT");
    clearTenantRuntimeConfigCache(clientId);

    const row = updated.rows[0];
    if (!row) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    res.status(200).json({
      ok: true,
      settings: serializeClientSettings(row)
    });
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error("[DASHBOARD_CLIENT_API] failed to update settings", err);
    res.status(500).json({ error: "Failed to update settings" });
  } finally {
    dbClient.release();
  }
});

export default router;
