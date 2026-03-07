import crypto from "crypto";
import express from "express";
import Twilio from "twilio";
import { pool } from "./db";
import { clearTenantRuntimeConfigCache } from "./tenant-config";

type RawBody = Record<string, unknown>;

type PortalTenantRow = {
  id: string;
  business_name: string;
  greeting: string;
  transfer_number: string | null;
  sms_enabled: boolean;
  booking_url: string | null;
  owner_phone: string | null;
  timezone: string | null;
  fallback_mode: string | null;
  system_prompt: string | null;
  business_profile: unknown;
  hours: unknown;
  services: unknown;
  faqs: unknown;
};

type CallSessionRow = {
  id: string;
  caller_phone: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_seconds: number;
  summary_lines: unknown;
};

type UsageMonthlyRow = {
  total_calls: number;
  total_duration_seconds: number;
  total_transcript_turns: number;
  month_start: Date | string;
};

type PlanRow = {
  plan: string | null;
};

const PLAN_LIMITS: Record<string, { callLimit: number; minuteLimit: number }> = {
  trial: { callLimit: 50, minuteLimit: 120 },
  starter: { callLimit: 200, minuteLimit: 500 },
  growth: { callLimit: 500, minuteLimit: 1500 }
};

const TEST_CALL_WINDOW_MS = 60 * 60 * 1000;
const TEST_CALL_MAX_PER_WINDOW = 3;
const TEST_CALL_PHONE_REGEX = /^\+[1-9]\d{7,14}$/;
const testCallRateLimitByTenant = new Map<string, number[]>();

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function parseDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return new Date(0).toISOString();
  return parsed.toISOString();
}

function parseDateOnly(value: Date | string | null): string {
  if (value === null) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  return new Date().toISOString().slice(0, 10);
}

function normalizeSummaryLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
}

function toInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeHours(value: unknown) {
  return asArray(value)
    .map((raw) => {
      const row = asObject(raw);
      const dayOfWeek = toInteger(row.day_of_week, -1);
      if (dayOfWeek < 0 || dayOfWeek > 6) return null;

      return {
        dayOfWeek,
        isOpen: toBoolean(row.is_open, false),
        openTime: asOptionalString(row.open_time),
        closeTime: asOptionalString(row.close_time)
      };
    })
    .filter((row): row is { dayOfWeek: number; isOpen: boolean; openTime: string | null; closeTime: string | null } => row !== null)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

function normalizeServices(value: unknown) {
  return asArray(value)
    .map((raw) => {
      const row = asObject(raw);
      const name = asOptionalString(row.name);
      if (!name) return null;

      return {
        id: toInteger(row.id, 0),
        name,
        description: asOptionalString(row.description),
        priceText: asOptionalString(row.price_text),
        active: toBoolean(row.active, true),
        sortOrder: toInteger(row.sort_order, 0)
      };
    })
    .filter((row): row is { id: number; name: string; description: string | null; priceText: string | null; active: boolean; sortOrder: number } => row !== null)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.id !== b.id) return a.id - b.id;
      return a.name.localeCompare(b.name);
    });
}

function normalizeFaqs(value: unknown) {
  return asArray(value)
    .map((raw) => {
      const row = asObject(raw);
      const question = asOptionalString(row.question);
      const answer = asOptionalString(row.answer);
      if (!question || !answer) return null;

      return {
        id: toInteger(row.id, 0),
        question,
        answer,
        active: toBoolean(row.active, true),
        sortOrder: toInteger(row.sort_order, 0)
      };
    })
    .filter((row): row is { id: number; question: string; answer: string; active: boolean; sortOrder: number } => row !== null)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.id !== b.id) return a.id - b.id;
      return a.question.localeCompare(b.question);
    });
}

function normalizeBusinessProfile(value: unknown): Record<string, unknown> {
  return asObject(value);
}

function serializePortalTenant(row: PortalTenantRow) {
  return {
    businessName: row.business_name,
    greeting: row.greeting,
    transferNumber: row.transfer_number,
    smsEnabled: row.sms_enabled,
    bookingUrl: row.booking_url,
    ownerPhone: row.owner_phone,
    timezone: row.timezone,
    fallbackMode: row.fallback_mode,
    systemPrompt: row.system_prompt,
    businessProfile: normalizeBusinessProfile(row.business_profile),
    hours: normalizeHours(row.hours),
    services: normalizeServices(row.services),
    faqs: normalizeFaqs(row.faqs)
  };
}

async function getPortalTenant(clientId: string): Promise<PortalTenantRow | null> {
  const result = await pool.query<PortalTenantRow>(
    `SELECT
      c.id,
      c.business_name,
      c.greeting,
      c.transfer_number,
      c.sms_enabled,
      c.booking_url,
      c.owner_phone,
      c.timezone,
      c.fallback_mode,
      c.system_prompt,
      COALESCE(c.business_profile, '{}'::jsonb) AS business_profile,
      COALESCE(h.hours, '[]'::jsonb) AS hours,
      COALESCE(s.services, '[]'::jsonb) AS services,
      COALESCE(f.faqs, '[]'::jsonb) AS faqs
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'day_of_week', day_of_week,
          'is_open', is_open,
          'open_time', to_char(open_time, 'HH24:MI:SS'),
          'close_time', to_char(close_time, 'HH24:MI:SS')
        )
        ORDER BY day_of_week
      ) AS hours
      FROM client_hours
      WHERE client_id = c.id
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', id,
          'name', name,
          'description', description,
          'price_text', price_text,
          'active', active,
          'sort_order', sort_order
        )
        ORDER BY sort_order, id
      ) AS services
      FROM client_services
      WHERE client_id = c.id
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', id,
          'question', question,
          'answer', answer,
          'active', active,
          'sort_order', sort_order
        )
        ORDER BY sort_order, id
      ) AS faqs
      FROM client_faqs
      WHERE client_id = c.id
    ) f ON true
    WHERE c.id = $1
    LIMIT 1`,
    [clientId]
  );

  return result.rows[0] || null;
}

function isAuthorizedSecret(secret: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(secret, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    const padded = Buffer.alloc(expectedBuffer.length);
    crypto.timingSafeEqual(expectedBuffer, padded);
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requirePortalSecret(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const secret = process.env.PORTAL_API_SECRET?.trim();
  if (!secret) {
    res.status(500).json({ error: "Portal API not configured" });
    return;
  }

  const header = req.headers["x-portal-secret"];
  const provided = (Array.isArray(header) ? header[0] : header)?.toString().trim();

  if (!provided || !isAuthorizedSecret(secret, provided)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

const router = express.Router();
router.use(requirePortalSecret);

router.get("/tenant/:tenantId", async (req, res) => {
  try {
    const tenantId = req.params.tenantId.trim();
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    const tenant = await getPortalTenant(tenantId);
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    res.status(200).json({ tenant: serializePortalTenant(tenant) });
  } catch (err) {
    console.error("[PORTAL_API] failed to fetch tenant", err);
    res.status(500).json({ error: "Failed to fetch tenant" });
  }
});

router.patch("/tenant/:tenantId", async (req, res) => {
  const tenantId = req.params.tenantId.trim();
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }

  const body = (asPlainObject(req.body) || {}) as RawBody;
  const updates: Array<{ clause: string; value: unknown }> = [];

  const addUpdate = (column: string, value: unknown, cast?: string) => {
    const placeholder = `$${updates.length + 2}`;
    updates.push({ clause: `${column} = ${placeholder}${cast || ""}`, value });
  };

  if (Object.prototype.hasOwnProperty.call(body, "greeting")) {
    const greeting = asOptionalString(body.greeting);
    if (!greeting) {
      res.status(400).json({ error: "greeting must be a non-empty string" });
      return;
    }
    addUpdate("greeting", greeting);
  }

  if (Object.prototype.hasOwnProperty.call(body, "systemPrompt")) {
    const systemPrompt = asOptionalString(body.systemPrompt);
    if (!systemPrompt || systemPrompt.length < 10) {
      res.status(400).json({ error: "systemPrompt must be a non-empty string with at least 10 characters" });
      return;
    }
    addUpdate("system_prompt", systemPrompt);
  }

  if (Object.prototype.hasOwnProperty.call(body, "transferNumber")) {
    addUpdate("transfer_number", asOptionalString(body.transferNumber));
  }

  if (Object.prototype.hasOwnProperty.call(body, "bookingUrl")) {
    addUpdate("booking_url", asOptionalString(body.bookingUrl));
  }

  if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
    addUpdate("timezone", asOptionalString(body.timezone));
  }

  if (Object.prototype.hasOwnProperty.call(body, "businessProfile")) {
    const profile = asPlainObject(body.businessProfile);
    if (!profile) {
      res.status(400).json({ error: "businessProfile must be a JSON object" });
      return;
    }
    addUpdate("business_profile", JSON.stringify(profile), "::jsonb");
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

    const exists = await dbClient.query<{ id: string }>("SELECT id FROM clients WHERE id = $1 LIMIT 1", [tenantId]);
    if (!exists.rows[0]) {
      await dbClient.query("ROLLBACK");
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (updates.length > 0) {
      const sql = `UPDATE clients
        SET ${updates.map((item) => item.clause).join(", ")}, updated_at = now()
        WHERE id = $1`;
      await dbClient.query(sql, [tenantId, ...updates.map((item) => item.value)]);
    }

    if (hasHours) {
      if (!Array.isArray(body.hours)) {
        res.status(400).json({ error: "hours must be an array" });
        await dbClient.query("ROLLBACK");
        return;
      }

      await dbClient.query("DELETE FROM client_hours WHERE client_id = $1", [tenantId]);

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
          [tenantId, dayOfWeek, isOpen, isOpen ? openTime : null, isOpen ? closeTime : null]
        );
      }
    }

    if (hasServices) {
      if (!Array.isArray(body.services)) {
        res.status(400).json({ error: "services must be an array" });
        await dbClient.query("ROLLBACK");
        return;
      }

      await dbClient.query("DELETE FROM client_services WHERE client_id = $1", [tenantId]);

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
          [tenantId, name, description, priceText, active, sortOrder]
        );
      }
    }

    if (hasFaqs) {
      if (!Array.isArray(body.faqs)) {
        res.status(400).json({ error: "faqs must be an array" });
        await dbClient.query("ROLLBACK");
        return;
      }

      await dbClient.query("DELETE FROM client_faqs WHERE client_id = $1", [tenantId]);

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
          [tenantId, question, answer, active, sortOrder]
        );
      }
    }

    await dbClient.query("COMMIT");

    clearTenantRuntimeConfigCache(tenantId);

    const tenant = await getPortalTenant(tenantId);
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    res.status(200).json({ ok: true, tenant: serializePortalTenant(tenant) });
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error("[PORTAL_API] failed to update tenant", err);
    res.status(500).json({ error: "Failed to update tenant" });
  } finally {
    dbClient.release();
  }
});

router.get("/tenant/:tenantId/calls", async (req, res) => {
  try {
    const tenantId = req.params.tenantId.trim();
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    const limit = parseBoundedInt(req.query.limit, 50, 1, 200);
    const offset = parseBoundedInt(req.query.offset, 0, 0, 100_000);

    const result = await pool.query<CallSessionRow>(
      `SELECT
        id,
        caller_phone,
        started_at,
        ended_at,
        duration_seconds,
        summary_lines
       FROM call_sessions
       WHERE client_id = $1
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset]
    );

    res.status(200).json({
      calls: result.rows.map((row) => ({
        id: row.id,
        callerPhone: row.caller_phone,
        startedAt: parseDate(row.started_at),
        endedAt: parseDate(row.ended_at),
        durationSeconds: row.duration_seconds,
        summaryLines: normalizeSummaryLines(row.summary_lines)
      })),
      pagination: { limit, offset }
    });
  } catch (err) {
    console.error("[PORTAL_API] failed to fetch calls", err);
    res.status(500).json({ error: "Failed to fetch calls" });
  }
});

router.get("/tenant/:tenantId/usage", async (req, res) => {
  try {
    const tenantId = req.params.tenantId.trim();
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    const [usageResult, planResult] = await Promise.all([
      pool.query<UsageMonthlyRow>(
        `SELECT total_calls, total_duration_seconds, total_transcript_turns, month_start
         FROM usage_monthly
         WHERE client_id = $1 AND month_start = date_trunc('month', now())::date
         LIMIT 1`,
        [tenantId]
      ),
      pool.query<PlanRow>("SELECT plan FROM clients WHERE id = $1 LIMIT 1", [tenantId])
    ]);

    const planRow = planResult.rows[0];
    if (!planRow) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const usageRow = usageResult.rows[0] || null;
    const planName = (planRow.plan || "trial").toLowerCase();
    const planLimits = PLAN_LIMITS[planName] || PLAN_LIMITS.trial;

    const now = new Date();
    const monthStartFallback = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

    res.status(200).json({
      usage: {
        totalCalls: usageRow?.total_calls ?? 0,
        totalDurationSeconds: usageRow?.total_duration_seconds ?? 0,
        totalTranscriptTurns: usageRow?.total_transcript_turns ?? 0,
        monthStart: usageRow ? parseDateOnly(usageRow.month_start) : monthStartFallback
      },
      plan: {
        name: planName,
        callLimit: planLimits.callLimit,
        minuteLimit: planLimits.minuteLimit
      }
    });
  } catch (err) {
    console.error("[PORTAL_API] failed to fetch usage", err);
    res.status(500).json({ error: "Failed to fetch usage" });
  }
});

router.post("/tenant/:tenantId/test-call", async (req, res) => {
  try {
    const tenantId = req.params.tenantId.trim();
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    const body = (asPlainObject(req.body) || {}) as RawBody;
    const toPhone = asOptionalString(body.toPhone);

    if (!toPhone || !TEST_CALL_PHONE_REGEX.test(toPhone)) {
      res.status(400).json({ error: "toPhone must be a valid E.164 phone number" });
      return;
    }

    const now = Date.now();
    const tenantEntries = (testCallRateLimitByTenant.get(tenantId) || []).filter(
      (timestamp) => now - timestamp < TEST_CALL_WINDOW_MS
    );

    if (tenantEntries.length >= TEST_CALL_MAX_PER_WINDOW) {
      testCallRateLimitByTenant.set(tenantId, tenantEntries);
      res.status(429).json({ error: "Rate limit: max 3 test calls per hour" });
      return;
    }

    const clientResult = await pool.query<{ phone_number: string | null }>(
      "SELECT phone_number FROM clients WHERE id = $1 LIMIT 1",
      [tenantId]
    );

    const tenantPhoneNumber = clientResult.rows[0]?.phone_number;
    if (!tenantPhoneNumber) {
      res.status(404).json({ error: "Tenant phone number not found" });
      return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

    if (!accountSid || !authToken) {
      res.status(500).json({ error: "Twilio credentials are not configured" });
      return;
    }

    const baseUrl = process.env.BASE_URL || "https://cadence-v2-production.up.railway.app";
    const twilio = Twilio(accountSid, authToken);

    const call = await twilio.calls.create({
      to: toPhone,
      from: tenantPhoneNumber,
      url: `${baseUrl}/incoming-call`,
      method: "POST"
    });

    tenantEntries.push(now);
    testCallRateLimitByTenant.set(tenantId, tenantEntries);

    res.status(200).json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error("[PORTAL_API] failed to create test call", err);
    res.status(500).json({ error: "Failed to create test call" });
  }
});

export default router;
