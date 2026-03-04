import { pool } from "./db";
import { runProvisioningForOnboarding } from "./provisioning";
import {
  onboardingSessionStore,
  type OnboardingCallSessionState,
  type OnboardingFieldName,
  type OnboardingSessionStore,
  REQUIRED_ONBOARDING_FIELDS
} from "./onboarding-session-store";

type SaveOnboardingFieldInput = {
  callSid: string;
  field: OnboardingFieldName;
  value: string;
  store?: OnboardingSessionStore;
};

type SaveOnboardingFieldResult = {
  ok: boolean;
  field: OnboardingFieldName;
  value: string;
  message?: string;
};

export type CompleteOnboardingResult = {
  ok: boolean;
  status: "session_not_found" | "missing_fields" | "provisioning_started" | "failed_to_start";
  missingFields?: OnboardingFieldName[];
  onboardingSessionId?: string;
  message: string;
};

function toOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /^unknown$/i.test(trimmed)) return null;
  return trimmed;
}

function extractAreaCode(value: string | null | undefined): string {
  if (!value) return "602";
  const digits = value.replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1, 4);
  }

  if (digits.length >= 10) {
    return digits.slice(0, 3);
  }

  return "602";
}

function inferWebsiteFromBusinessName(businessName: string): string {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  if (!slug) return "https://example.com";
  return `https://${slug}.com`;
}

async function createProvisioningSession(callSession: OnboardingCallSessionState): Promise<string> {
  const fields = callSession.fields;
  const businessName = (fields.business_name || "New business").trim();
  const businessType = (fields.type || "service").trim();
  const hours = (fields.hours || "Hours not provided yet").trim();
  const services = (fields.services || "Services will be finalized after setup call").trim();
  const faqs = (fields.faqs || "FAQs will be finalized after setup call").trim();
  const callHandling = (fields.call_handling || "Take a message and return the call").trim();

  const transferNumber = toOptional(fields.transfer_number);
  const ownerEmail = (fields.email || "owner@example.com").trim().toLowerCase();
  const ownerPhone =
    toOptional(callSession.callerPhone) ||
    transferNumber ||
    "+16026633503";

  const preferredAreaCode = extractAreaCode(transferNumber || ownerPhone);
  const greeting = `Thanks for calling ${businessName}. How can I help you today?`;

  const insert = await pool.query<{ id: string }>(
    `INSERT INTO onboarding_sessions (
      status,
      business_name,
      business_description,
      phone_number,
      website,
      hours,
      services,
      faqs,
      booking_instructions,
      transfer_number,
      booking_url,
      greeting,
      owner_name,
      owner_email,
      owner_phone,
      preferred_area_code
    ) VALUES (
      'checkout_complete',
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14, $15
    )
    RETURNING id`,
    [
      businessName,
      `${businessType} business`,
      ownerPhone,
      inferWebsiteFromBusinessName(businessName),
      hours,
      services,
      faqs,
      callHandling,
      transferNumber,
      null,
      greeting,
      businessName,
      ownerEmail,
      ownerPhone,
      preferredAreaCode
    ]
  );

  return insert.rows[0].id;
}

export async function save_onboarding_field(input: SaveOnboardingFieldInput): Promise<SaveOnboardingFieldResult> {
  const store = input.store ?? onboardingSessionStore;
  const value = input.value.trim();

  if (!value) {
    return {
      ok: false,
      field: input.field,
      value,
      message: "Field value cannot be empty"
    };
  }

  const updated = await store.saveField(input.callSid, input.field, value);
  if (!updated) {
    return {
      ok: false,
      field: input.field,
      value,
      message: "Onboarding session not found"
    };
  }

  return {
    ok: true,
    field: input.field,
    value
  };
}

export async function complete_onboarding(input: {
  callSid: string;
  store?: OnboardingSessionStore;
}): Promise<CompleteOnboardingResult> {
  const store = input.store ?? onboardingSessionStore;
  const callSession = await store.getSession(input.callSid);

  if (!callSession) {
    return {
      ok: false,
      status: "session_not_found",
      message: "Onboarding call session was not found"
    };
  }

  const missingFields = REQUIRED_ONBOARDING_FIELDS.filter((field) => {
    const value = callSession.fields[field];
    return !value || value.trim().length === 0;
  });

  if (missingFields.length > 0) {
    return {
      ok: false,
      status: "missing_fields",
      missingFields,
      message: `Missing required fields: ${missingFields.join(", ")}`
    };
  }

  try {
    await store.setStatus(callSession.callSid, "provisioning");

    const onboardingSessionId = callSession.onboardingSessionId || (await createProvisioningSession(callSession));

    await store.setStatus(callSession.callSid, "provisioning", { onboardingSessionId, provisionError: null });

    setImmediate(() => {
      runProvisioningForOnboarding(onboardingSessionId)
        .then(async () => {
          await store.setStatus(callSession.callSid, "provisioned", { onboardingSessionId, provisionError: null });
        })
        .catch(async (err) => {
          const message = err instanceof Error ? err.message : "unknown provisioning error";
          console.error(`[ONBOARDING:${callSession.callSid}] provisioning failed`, err);
          await store.setStatus(callSession.callSid, "failed", {
            onboardingSessionId,
            provisionError: message
          });
        });
    });

    return {
      ok: true,
      status: "provisioning_started",
      onboardingSessionId,
      message: "Provisioning started"
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start provisioning";

    await store.setStatus(callSession.callSid, "failed", {
      onboardingSessionId: callSession.onboardingSessionId,
      provisionError: message
    });

    return {
      ok: false,
      status: "failed_to_start",
      message
    };
  }
}
