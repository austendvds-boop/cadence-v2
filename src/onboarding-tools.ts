import { sendSms } from "./sms";
import { onboardingSessionStore, type OnboardingSessionStore } from "./onboarding-session-store";

const SIGNUP_LINK_SMS = "Here's your link to get started with Automate: https://autom8everything.com/get-started";
const DEFAULT_LEAD_ALERT_PHONE = "+16026633503";

type SendSignupLinkInput = {
  callSid: string;
  callerPhone: string;
  fromPhone: string;
  leadAlertPhone?: string;
  store?: OnboardingSessionStore;
};

export type SendSignupLinkResult = {
  ok: boolean;
  status: "sent" | "missing_caller_phone" | "failed";
  callerPhone: string;
  message: string;
};

function normalizePhone(value: string | null | undefined): string {
  const normalized = (value || "").trim();
  return normalized || "unknown";
}

export async function send_signup_link(input: SendSignupLinkInput): Promise<SendSignupLinkResult> {
  const store = input.store ?? onboardingSessionStore;
  const callerPhone = normalizePhone(input.callerPhone);
  const fromPhone = normalizePhone(input.fromPhone);
  const leadAlertPhone = normalizePhone(input.leadAlertPhone || DEFAULT_LEAD_ALERT_PHONE);

  if (callerPhone === "unknown") {
    const message = "Caller phone number is unavailable from call metadata";

    try {
      await sendSms(leadAlertPhone, fromPhone, `New lead from demo call: ${callerPhone}`);
    } catch (err) {
      console.error(`[ONBOARDING:${input.callSid}] lead alert sms failed`, err);
    }

    await store.setStatus(input.callSid, "failed", { provisionError: message });

    return {
      ok: false,
      status: "missing_caller_phone",
      callerPhone,
      message
    };
  }

  try {
    await sendSms(callerPhone, fromPhone, SIGNUP_LINK_SMS);
    await sendSms(leadAlertPhone, fromPhone, `New lead from demo call: ${callerPhone}`);

    await store.setStatus(input.callSid, "provisioned", {
      onboardingSessionId: null,
      provisionError: null
    });

    return {
      ok: true,
      status: "sent",
      callerPhone,
      message: "Signup link sent"
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send signup link";

    await store.setStatus(input.callSid, "failed", { provisionError: message });

    return {
      ok: false,
      status: "failed",
      callerPhone,
      message
    };
  }
}
