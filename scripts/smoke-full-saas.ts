import fs from "fs/promises";
import path from "path";
import Stripe from "stripe";
import pg from "pg";
import { ONBOARDING_TENANT_PHONE_NUMBER } from "../src/onboarding-prompt";

type CheckResult = {
  name: string;
  ok: boolean;
  details: string;
};

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing env var: ${key}`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertValidStreamTwiml(twiml: string): { websocketUrl: string } {
  const normalized = twiml.replace(/\s+/g, " ");

  if (!twiml.trim().startsWith("<?xml")) {
    throw new Error("TwiML is missing XML declaration");
  }

  if (!normalized.includes("<Response>") || !normalized.includes("</Response>")) {
    throw new Error("TwiML is missing <Response> root");
  }

  if (!normalized.includes("<Connect>") || !normalized.includes("<Stream")) {
    throw new Error("TwiML is missing <Connect>/<Stream>");
  }

  if (!normalized.includes('Parameter name="clientId"')) {
    throw new Error("TwiML is missing clientId stream parameter");
  }

  const streamMatch = twiml.match(/<Stream\s+url="([^"]+)"/i);
  if (!streamMatch?.[1]) {
    throw new Error("TwiML stream URL is missing");
  }

  const websocketUrl = streamMatch[1];
  if (!websocketUrl.startsWith("wss://")) {
    throw new Error(`Unexpected stream URL: ${websocketUrl}`);
  }

  return { websocketUrl };
}

async function postIncomingCall(baseUrl: string, to: string): Promise<string> {
  const from = process.env.SMOKE_CALLER_NUMBER || "+15555550123";

  const response = await fetch(`${baseUrl}/incoming-call`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from }).toString()
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  return body;
}

async function postStripeWebhook(baseUrl: string, webhookSecret: string): Promise<string> {
  const event = {
    id: `evt_smoke_full_saas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `ch_smoke_${Date.now()}`,
        object: "charge"
      }
    },
    livemode: false,
    pending_webhooks: 1,
    request: {
      id: null,
      idempotency_key: null
    },
    type: "charge.succeeded"
  };

  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    timestamp: Math.floor(Date.now() / 1000)
  });

  const response = await fetch(`${baseUrl}/stripe-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature
    },
    body: payload
  });

  const body = await response.text();
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  return body;
}

async function get200(baseUrl: string, route: string): Promise<string> {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.text();
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return body;
}

async function runCheck(name: string, check: () => Promise<string>): Promise<CheckResult> {
  try {
    const details = await check();
    console.log(`✅ ${name} — ${details}`);
    return { name, ok: true, details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${name} — ${message}`);
    return { name, ok: false, details: message };
  }
}

function hasAll(required: string[], available: Set<string>): string[] {
  return required.filter((item) => !available.has(item));
}

async function verifyMigrations(pool: pg.Pool): Promise<string> {
  const sqlDir = path.resolve(__dirname, "..", "sql");
  const migrationFiles = (await fs.readdir(sqlDir))
    .filter((file) => /^\d+-.+\.sql$/.test(file))
    .sort();

  const tableRows = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'`
  );
  const tableSet = new Set(tableRows.rows.map((row) => row.table_name));

  const columnRows = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  const columnSet = new Set(columnRows.rows.map((row) => `${row.table_name}.${row.column_name}`));

  const hasSchemaMigrationsTable = tableSet.has("schema_migrations");
  let recordedSet = new Set<string>();

  if (hasSchemaMigrationsTable) {
    const migrationRows = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    recordedSet = new Set(migrationRows.rows.map((row) => row.filename));
  }

  const constraintRows = await pool.query<{ constraint_name: string; definition: string }>(
    `SELECT c.conname AS constraint_name,
            pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'onboarding_fields'`
  );
  const constraintMap = new Map(constraintRows.rows.map((row) => [row.constraint_name, row.definition]));

  const artifactChecks: Record<string, { ok: boolean; details: string }> = {
    "001-clients.sql": (() => {
      const requiredTables = ["clients"];
      const requiredColumns = [
        "clients.phone_number",
        "clients.system_prompt",
        "clients.transfer_number",
        "clients.greeting",
        "clients.plan",
        "clients.active",
        "clients.stripe_customer_id",
        "clients.stripe_subscription_id"
      ];
      const missingTables = hasAll(requiredTables, tableSet);
      const missingColumns = hasAll(requiredColumns, columnSet);
      const missing = [...missingTables, ...missingColumns];
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "core clients schema present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "002-onboarding.sql": (() => {
      const requiredTables = ["onboarding_sessions", "processed_stripe_events", "audit_log"];
      const requiredColumns = [
        "clients.owner_name",
        "clients.owner_email",
        "clients.onboarding_session_id",
        "clients.twilio_number_sid",
        "clients.deactivated_at",
        "clients.number_release_after"
      ];
      const missing = [...hasAll(requiredTables, tableSet), ...hasAll(requiredColumns, columnSet)];
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "onboarding tables + client extensions present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "003-tenant-config.sql": (() => {
      const requiredTables = ["client_hours", "client_services", "client_faqs"];
      const requiredColumns = [
        "clients.business_type",
        "clients.timezone",
        "clients.sms_number",
        "clients.intake_mode",
        "clients.fallback_mode",
        "clients.tools_config",
        "clients.business_profile"
      ];
      const missing = [...hasAll(requiredTables, tableSet), ...hasAll(requiredColumns, columnSet)];
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "tenant normalization schema present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "004-calls-transcripts.sql": (() => {
      const requiredTables = ["call_sessions", "call_transcripts", "usage_monthly"];
      const missing = hasAll(requiredTables, tableSet);
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "call logging schema present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "005-billing.sql": (() => {
      const requiredTables = ["billing_subscriptions", "billing_events"];
      const missing = hasAll(requiredTables, tableSet);
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "billing schema present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "006-dashboard-auth.sql": (() => {
      const requiredTables = ["dashboard_users", "magic_link_tokens"];
      const missing = hasAll(requiredTables, tableSet);
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "dashboard auth schema present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "007-onboarding-phone.sql": (() => {
      const requiredTables = ["onboarding_call_sessions", "onboarding_fields"];
      const missing = hasAll(requiredTables, tableSet);
      return {
        ok: missing.length === 0,
        details: missing.length === 0 ? "onboarding phone-call schema present" : `missing artifacts: ${missing.join(", ")}`
      };
    })(),
    "008-onboarding-call-handling-field.sql": (() => {
      const definition = constraintMap.get("onboarding_fields_field_name_check") || "";
      const hasCallHandling = definition.includes("call_handling");
      return {
        ok: hasCallHandling,
        details: hasCallHandling
          ? "onboarding_fields constraint includes call_handling"
          : "onboarding_fields_field_name_check missing call_handling"
      };
    })()
  };

  const missingMigrations: string[] = [];
  const recordedOnlyCount = migrationFiles.filter((file) => recordedSet.has(file)).length;
  const inferredApplied: string[] = [];

  for (const file of migrationFiles) {
    const artifact = artifactChecks[file];
    const recorded = recordedSet.has(file);

    if (recorded || artifact?.ok) {
      if (!recorded) {
        inferredApplied.push(file);
      }
      continue;
    }

    const reason = artifact ? artifact.details : "no artifact validator configured";
    missingMigrations.push(`${file} (${reason})`);
  }

  if (missingMigrations.length > 0) {
    throw new Error(`Missing migrations: ${missingMigrations.join("; ")}`);
  }

  const migrationSummaryParts = [
    `${migrationFiles.length} migration file(s) verified`,
    hasSchemaMigrationsTable
      ? `${recordedOnlyCount} recorded in schema_migrations`
      : "schema_migrations table not present; used artifact verification"
  ];

  if (inferredApplied.length > 0) {
    migrationSummaryParts.push(`${inferredApplied.length} inferred via schema artifacts`);
  }

  return migrationSummaryParts.join("; ");
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const cadenceBaseUrl = normalizeBaseUrl(requireEnv("CADENCE_BASE_URL"));
  const stripeWebhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");

  const dvdsNumber = process.env.DVDS_TENANT_NUMBER || "+19284477047";
  const onboardingNumber = process.env.ONBOARDING_TENANT_NUMBER || ONBOARDING_TENANT_PHONE_NUMBER;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const results: CheckResult[] = [];

  try {
    results.push(
      await runCheck("DVDS tenant exists and is active", async () => {
        const result = await pool.query<{
          id: string;
          business_name: string;
          active: boolean;
        }>(
          `SELECT id, business_name, active
           FROM clients
           WHERE phone_number = $1
           ORDER BY updated_at DESC
           LIMIT 1`,
          [dvdsNumber]
        );

        const tenant = result.rows[0];
        if (!tenant) {
          throw new Error(`No tenant found for DVDS number ${dvdsNumber}`);
        }

        if (!tenant.active) {
          throw new Error(`DVDS tenant ${tenant.id} is inactive`);
        }

        return `${tenant.business_name} (${tenant.id}) active=true`;
      })
    );

    results.push(
      await runCheck("Onboarding tenant exists with intake_mode=onboarding", async () => {
        const result = await pool.query<{
          id: string;
          business_name: string;
          active: boolean;
          intake_mode: string | null;
        }>(
          `SELECT id, business_name, active, intake_mode
           FROM clients
           WHERE phone_number = $1
           ORDER BY updated_at DESC
           LIMIT 1`,
          [onboardingNumber]
        );

        const tenant = result.rows[0];
        if (!tenant) {
          throw new Error(`No tenant found for onboarding number ${onboardingNumber}`);
        }

        if (tenant.intake_mode !== "onboarding") {
          throw new Error(`Expected intake_mode=onboarding, received ${tenant.intake_mode ?? "null"}`);
        }

        return `${tenant.business_name} (${tenant.id}) intake_mode=${tenant.intake_mode} active=${tenant.active}`;
      })
    );

    results.push(
      await runCheck("POST /incoming-call with DVDS number returns valid TwiML", async () => {
        const twiml = await postIncomingCall(cadenceBaseUrl, dvdsNumber);
        const parsed = assertValidStreamTwiml(twiml);
        return `stream TwiML valid (${parsed.websocketUrl})`;
      })
    );

    results.push(
      await runCheck("POST /incoming-call with onboarding number returns valid TwiML", async () => {
        const twiml = await postIncomingCall(cadenceBaseUrl, onboardingNumber);
        const parsed = assertValidStreamTwiml(twiml);
        return `stream TwiML valid (${parsed.websocketUrl})`;
      })
    );

    results.push(
      await runCheck("POST /stripe-webhook accepts signed test event", async () => {
        const responseBody = await postStripeWebhook(cadenceBaseUrl, stripeWebhookSecret);
        return `HTTP 200 (${responseBody.slice(0, 140)})`;
      })
    );

    results.push(
      await runCheck("GET /dashboard/ returns 200", async () => {
        const body = await get200(cadenceBaseUrl, "/dashboard/");
        const lower = body.toLowerCase();
        if (!lower.includes("<!doctype") && !lower.includes("<html")) {
          throw new Error("Dashboard route returned non-HTML content");
        }
        return `dashboard HTML returned (${body.length} chars)`;
      })
    );

    results.push(
      await runCheck("GET / (health) returns 200", async () => {
        const body = await get200(cadenceBaseUrl, "/");
        if (!body.includes("status") || !body.includes("ok")) {
          throw new Error(`Unexpected health payload: ${body.slice(0, 200)}`);
        }
        return body;
      })
    );

    results.push(
      await runCheck("All migrations are applied", async () => {
        return verifyMigrations(pool);
      })
    );

    results.push(
      await runCheck("Railway env vars baseline present", async () => {
        const requiredEnvNames = [
          "DATABASE_URL",
          "CADENCE_BASE_URL",
          "STRIPE_WEBHOOK_SECRET"
        ];

        const missing = requiredEnvNames.filter((name) => !process.env[name]);
        if (missing.length > 0) {
          throw new Error(`Missing runtime env vars: ${missing.join(", ")}`);
        }

        return `runtime env vars present (${requiredEnvNames.join(", ")})`;
      })
    );
  } finally {
    await pool.end();
  }

  const failed = results.filter((result) => !result.ok);
  const summary = {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    checks: results
  };

  console.log("\nSMOKE_RESULT_JSON=" + JSON.stringify(summary));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Smoke test failed unexpectedly", error);
  process.exitCode = 1;
});
