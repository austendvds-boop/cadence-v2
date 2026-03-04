import pg from "pg";
import {
  ONBOARDING_CONFIRMATION_LINE,
  ONBOARDING_GREETING,
  ONBOARDING_SIGN_OFF,
  ONBOARDING_SYSTEM_PROMPT,
  ONBOARDING_TENANT_PHONE_NUMBER
} from "../src/onboarding-prompt";
import { provisionClient } from "../src/provision-client";

type CheckResult = {
  name: string;
  ok: boolean;
  details: string;
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function assertValidStreamTwiml(twiml: string): void {
  const normalized = twiml.replace(/\s+/g, " ");

  if (!twiml.trim().startsWith("<?xml")) {
    throw new Error("TwiML missing XML declaration");
  }

  if (!normalized.includes("<Response>") || !normalized.includes("</Response>")) {
    throw new Error("TwiML missing <Response> root");
  }

  if (!normalized.includes("<Connect>") || !normalized.includes("<Stream")) {
    throw new Error("TwiML missing <Connect>/<Stream>");
  }

  if (!normalized.includes('Parameter name="clientId"')) {
    throw new Error("TwiML missing clientId stream parameter");
  }
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
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  return body;
}

async function listAvailableTwilioNumbers(accountSid: string, authToken: string): Promise<string[]> {
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&SmsEnabled=true&Limit=3`;

  const response = await fetch(url, {
    headers: { Authorization: authHeader }
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Twilio API error ${response.status}: ${raw.slice(0, 240)}`);
  }

  const parsed = JSON.parse(raw) as {
    available_phone_numbers?: Array<{ phone_number?: string }>;
  };

  return (parsed.available_phone_numbers || [])
    .map((entry) => entry.phone_number)
    .filter((phone): phone is string => typeof phone === "string" && phone.length > 0);
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

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const cadenceBaseUrl = requireEnv("CADENCE_BASE_URL").replace(/\/$/, "");
  const twilioAccountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const twilioAuthToken = requireEnv("TWILIO_AUTH_TOKEN");

  const onboardingNumber = process.env.ONBOARDING_TENANT_NUMBER || ONBOARDING_TENANT_PHONE_NUMBER;
  const dvdsNumber = process.env.DVDS_TENANT_NUMBER || "+19284477047";

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const results: CheckResult[] = [];
  let onboardingTenantId: string | null = null;

  try {
    results.push(
      await runCheck("Onboarding tenant exists in DB", async () => {
        const lookup = await pool.query<{
          id: string;
          business_name: string;
        }>(
          "SELECT id, business_name FROM clients WHERE phone_number = $1 LIMIT 1",
          [onboardingNumber]
        );

        const tenant = lookup.rows[0];
        if (!tenant) {
          throw new Error(`No client row found for onboarding number ${onboardingNumber}`);
        }

        onboardingTenantId = tenant.id;
        return `${tenant.business_name} (${tenant.id})`;
      })
    );

    results.push(
      await runCheck("Onboarding system prompt polished", async () => {
        if (!onboardingTenantId) {
          throw new Error("Cannot update onboarding prompt; tenant id is unavailable");
        }

        await pool.query(
          "UPDATE clients SET greeting = $2, system_prompt = $3, updated_at = now() WHERE id = $1",
          [onboardingTenantId, ONBOARDING_GREETING, ONBOARDING_SYSTEM_PROMPT]
        );

        const verify = await pool.query<{
          greeting: string;
          system_prompt: string;
        }>("SELECT greeting, system_prompt FROM clients WHERE id = $1", [onboardingTenantId]);

        const row = verify.rows[0];
        if (!row) throw new Error("Updated onboarding tenant row not found");
        if (row.greeting !== ONBOARDING_GREETING) throw new Error("Greeting update did not persist");
        if (!row.system_prompt.includes(ONBOARDING_CONFIRMATION_LINE)) {
          throw new Error("Confirmation phrase missing after prompt update");
        }
        if (!row.system_prompt.includes(ONBOARDING_SIGN_OFF)) {
          throw new Error("Sign-off phrase missing after prompt update");
        }

        return "greeting + confirmation + sign-off validated";
      })
    );

    results.push(
      await runCheck("POST /incoming-call returns valid onboarding TwiML", async () => {
        const twiml = await postIncomingCall(cadenceBaseUrl, onboardingNumber);
        assertValidStreamTwiml(twiml);
        return `stream TwiML OK (${twiml.length} chars)`;
      })
    );

    results.push(
      await runCheck("POST /incoming-call returns valid DVDS TwiML", async () => {
        const twiml = await postIncomingCall(cadenceBaseUrl, dvdsNumber);
        assertValidStreamTwiml(twiml);
        return `stream TwiML OK (${twiml.length} chars)`;
      })
    );

    results.push(
      await runCheck("provision-client.ts accepts mock data", async () => {
        const mockProvision = await provisionClient(
          {
            businessName: "Onboarding Smoke Test Business",
            businessDescription: "A local service business validating onboarding provisioning.",
            businessPhone: "+15555550100",
            website: "https://example.com",
            hours: "Mon-Fri 8am-5pm",
            services: "Consultation ($99), install ($299)",
            faqs: "Do you offer weekend service? Yes by appointment.",
            bookingInstructions: "Collect name and callback number; we call back same day.",
            preferredAreaCode: "480",
            transferNumber: "+15555550101",
            bookingUrl: "https://example.com/book",
            ownerName: "Smoke Tester",
            ownerEmail: "smoke@example.com",
            ownerPhone: "+15555550102"
          },
          { dryRun: true }
        );

        if (!mockProvision.dryRun) throw new Error("Expected dryRun=true result");
        if (!mockProvision.systemPrompt.includes("Onboarding Smoke Test Business")) {
          throw new Error("Mock provision did not generate expected system prompt");
        }

        return `dry-run result produced (${mockProvision.phoneNumber})`;
      })
    );

    results.push(
      await runCheck("Twilio API access (list available numbers)", async () => {
        const numbers = await listAvailableTwilioNumbers(twilioAccountSid, twilioAuthToken);
        return `API reachable, returned ${numbers.length} available number(s)`;
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
