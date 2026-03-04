import express from "express";
import { pool } from "../db";
import { requireDashboardAdmin } from "./auth";

const router = express.Router();

type AdminClientRow = {
  id: string;
  business_name: string;
  phone_number: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  active: boolean;
  plan: string;
  trial_ends_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  total_calls: number;
  last_call_at: Date | string | null;
  current_month_calls: number;
  current_month_duration_seconds: number;
  billing_status: string | null;
};

type AdminExportRow = {
  id: string;
  business_name: string;
  phone_number: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  active: boolean;
  plan: string;
  trial_ends_at: Date | string | null;
  billing_status: string | null;
  current_period_end: Date | string | null;
  total_calls: number;
  total_duration_seconds: number;
  created_at: Date | string;
};

function parseDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
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

function normalizeStatusFilter(raw: unknown): "all" | "active" | "inactive" {
  if (typeof raw !== "string") return "all";

  const normalized = raw.trim().toLowerCase();
  if (normalized === "active" || normalized === "inactive") {
    return normalized;
  }

  return "all";
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";

  const asString = String(value);
  if (/[,"\n\r]/.test(asString)) {
    return `"${asString.replace(/"/g, '""')}"`;
  }

  return asString;
}

function buildCsv(rows: AdminExportRow[]): string {
  const header = [
    "client_id",
    "business_name",
    "phone_number",
    "owner_name",
    "owner_email",
    "owner_phone",
    "active",
    "plan",
    "trial_ends_at",
    "billing_status",
    "current_period_end",
    "total_calls",
    "total_duration_seconds",
    "created_at"
  ];

  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.business_name,
        row.phone_number,
        row.owner_name,
        row.owner_email,
        row.owner_phone,
        row.active,
        row.plan,
        parseDate(row.trial_ends_at),
        row.billing_status,
        parseDate(row.current_period_end),
        row.total_calls,
        row.total_duration_seconds,
        parseDate(row.created_at)
      ]
        .map((value) => escapeCsv(value))
        .join(",")
    );
  }

  return lines.join("\n");
}

router.use(requireDashboardAdmin);

router.get("/clients", async (req, res) => {
  const statusFilter = normalizeStatusFilter(req.query.status);
  const limit = parseBoundedInt(req.query.limit, 100, 1, 500);
  const offset = parseBoundedInt(req.query.offset, 0, 0, 100_000);

  const result = await pool.query<AdminClientRow>(
    `SELECT
      c.id,
      c.business_name,
      c.phone_number,
      c.owner_name,
      c.owner_email,
      c.owner_phone,
      c.active,
      c.plan,
      c.trial_ends_at,
      c.created_at,
      c.updated_at,
      COALESCE(call_stats.total_calls, 0)::int AS total_calls,
      call_stats.last_call_at,
      COALESCE(month_stats.current_month_calls, 0)::int AS current_month_calls,
      COALESCE(month_stats.current_month_duration_seconds, 0)::int AS current_month_duration_seconds,
      billing.status AS billing_status
     FROM clients c
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS total_calls,
         MAX(started_at) AS last_call_at
       FROM call_sessions cs
       WHERE cs.client_id = c.id
     ) call_stats ON true
     LEFT JOIN LATERAL (
       SELECT
         um.total_calls AS current_month_calls,
         um.total_duration_seconds AS current_month_duration_seconds
       FROM usage_monthly um
       WHERE um.client_id = c.id
       ORDER BY um.month_start DESC
       LIMIT 1
     ) month_stats ON true
     LEFT JOIN billing_subscriptions billing ON billing.client_id = c.id
     WHERE
       ($1 = 'all')
       OR ($1 = 'active' AND c.active = true)
       OR ($1 = 'inactive' AND c.active = false)
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [statusFilter, limit, offset]
  );

  res.status(200).json({
    clients: result.rows.map((row) => ({
      id: row.id,
      businessName: row.business_name,
      phoneNumber: row.phone_number,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      ownerPhone: row.owner_phone,
      active: row.active,
      plan: row.plan,
      trialEndsAt: parseDate(row.trial_ends_at),
      billingStatus: row.billing_status,
      totalCalls: row.total_calls,
      currentMonthCalls: row.current_month_calls,
      currentMonthDurationSeconds: row.current_month_duration_seconds,
      lastCallAt: parseDate(row.last_call_at),
      createdAt: parseDate(row.created_at),
      updatedAt: parseDate(row.updated_at)
    })),
    pagination: { status: statusFilter, limit, offset }
  });
});

router.get("/export", async (_req, res) => {
  const result = await pool.query<AdminExportRow>(
    `SELECT
      c.id,
      c.business_name,
      c.phone_number,
      c.owner_name,
      c.owner_email,
      c.owner_phone,
      c.active,
      c.plan,
      c.trial_ends_at,
      c.created_at,
      billing.status AS billing_status,
      billing.current_period_end,
      COALESCE(call_totals.total_calls, 0)::int AS total_calls,
      COALESCE(call_totals.total_duration_seconds, 0)::int AS total_duration_seconds
     FROM clients c
     LEFT JOIN billing_subscriptions billing ON billing.client_id = c.id
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS total_calls,
         COALESCE(SUM(duration_seconds), 0) AS total_duration_seconds
       FROM call_sessions cs
       WHERE cs.client_id = c.id
     ) call_totals ON true
     ORDER BY c.created_at DESC`
  );

  const csv = buildCsv(result.rows);
  const filenameDate = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"cadence-admin-export-${filenameDate}.csv\"`);
  res.status(200).send(csv);
});

export default router;
