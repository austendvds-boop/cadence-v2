import express from "express";
import { provisionClient } from "../provision-client";
import { sendSms } from "../sms";

const router = express.Router();

const MAX_SUBMISSIONS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const submissionTimestampsByIp = new Map<string, number[]>();

const ALLOWED_CORS_ORIGINS = new Set<string>([
  "https://autom8everything.com",
  "https://www.autom8everything.com"
]);

const AUSTEN_PHONE = "+16026633503";

type OnboardRequestBody = {
  businessName?: unknown;
  businessType?: unknown;
  phone?: unknown;
  email?: unknown;
  website?: unknown;
  hours?: unknown;
  services?: unknown;
  greeting?: unknown;
  transferNumber?: unknown;
  faqs?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (Array.isArray(value)) {
    const flattened = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .join(", ");

    return flattened || fallback;
  }

  return fallback;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePhone(phone: string): string | null {
  if (/^\+[1-9]\d{7,14}$/.test(phone)) {
    return phone;
  }

  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return null;
}

function deriveAreaCode(...phoneCandidates: Array<string | null>): string {
  for (const candidate of phoneCandidates) {
    if (!candidate) continue;

    const digits = candidate.replace(/\D/g, "");
    const tenDigit = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

    if (tenDigit.length === 10) {
      return tenDigit.slice(0, 3);
    }
  }

  return "602";
}

function getClientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || req.ip || "unknown";
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0] ?? "";
    if (first.trim()) {
      return first.split(",")[0]?.trim() || req.ip || "unknown";
    }
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

function takeRateLimitSlot(ip: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = submissionTimestampsByIp.get(ip) ?? [];
  const activeWindow = existing.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (activeWindow.length >= MAX_SUBMISSIONS_PER_HOUR) {
    submissionTimestampsByIp.set(ip, activeWindow);
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - activeWindow[0]);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  activeWindow.push(now);
  submissionTimestampsByIp.set(ip, activeWindow);

  return { allowed: true };
}

function applyCors(req: express.Request, res: express.Response): boolean {
  const origin = req.headers.origin;

  if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  return false;
}

function buildAustenSummarySms(input: {
  businessName: string;
  businessType: string;
  ownerPhone: string;
  ownerEmail: string;
  transferNumber: string;
  website: string;
  trialEndsAt: string | null;
  provisionedNumber: string;
}): string {
  return [
    `Cadence onboarded: ${input.businessName}`,
    `Type: ${input.businessType}`,
    `Client: ${input.ownerPhone} • ${input.ownerEmail}`,
    `Cadence #: ${input.provisionedNumber}`,
    `Transfer #: ${input.transferNumber}`,
    `Website: ${input.website || "n/a"}`,
    `Trial ends: ${input.trialEndsAt || "n/a"}`
  ].join("\n");
}

router.use((req, res, next) => {
  if (applyCors(req, res)) return;
  next();
});

router.post("/", async (req, res) => {
  const ip = getClientIp(req);
  const slot = takeRateLimitSlot(ip);

  if (!slot.allowed) {
    res.setHeader("Retry-After", slot.retryAfterSeconds.toString());
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded. Please try again later."
    });
    return;
  }

  const body = (req.body ?? {}) as OnboardRequestBody;

  const businessName = asTrimmedString(body.businessName);
  const businessType = asTrimmedString(body.businessType);
  const phoneRaw = asTrimmedString(body.phone);
  const email = asTrimmedString(body.email).toLowerCase();
  const greeting = asTrimmedString(body.greeting);
  const transferNumberRaw = asTrimmedString(body.transferNumber);

  const missingRequired = [
    ["businessName", businessName],
    ["businessType", businessType],
    ["phone", phoneRaw],
    ["email", email],
    ["greeting", greeting],
    ["transferNumber", transferNumberRaw]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingRequired.length > 0) {
    res.status(400).json({
      success: false,
      error: `Missing required field(s): ${missingRequired.join(", ")}`
    });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ success: false, error: "Invalid email format" });
    return;
  }

  const ownerPhone = normalizePhone(phoneRaw);
  if (!ownerPhone) {
    res.status(400).json({ success: false, error: "Invalid phone format" });
    return;
  }

  const transferNumber = normalizePhone(transferNumberRaw);
  if (!transferNumber) {
    res.status(400).json({ success: false, error: "Invalid transferNumber format" });
    return;
  }

  const website = asOptionalString(body.website, "Not provided");
  const hours = asOptionalString(body.hours, "Not provided");
  const services = asOptionalString(body.services, "Not provided");
  const faqs = asOptionalString(body.faqs, "Not provided");

  try {
    const provisioned = await provisionClient({
      businessName,
      businessDescription: businessType,
      businessPhone: ownerPhone,
      website,
      hours,
      services,
      faqs,
      bookingInstructions: "Answer calls professionally, gather lead details, and route urgent requests.",
      preferredAreaCode: deriveAreaCode(transferNumber, ownerPhone),
      transferNumber,
      greeting,
      ownerName: businessName,
      ownerEmail: email,
      ownerPhone,
      plan: "trial",
      trialDays: 7
    });

    const summary = buildAustenSummarySms({
      businessName,
      businessType,
      ownerPhone,
      ownerEmail: email,
      transferNumber,
      website,
      trialEndsAt: provisioned.trialEndsAt,
      provisionedNumber: provisioned.phoneNumber
    });

    await sendSms(AUSTEN_PHONE, provisioned.phoneNumber, summary);

    res.status(200).json({
      success: true,
      message: "Your Cadence agent is being set up!"
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to process onboarding";
    console.error("[ONBOARD_API] onboarding failed", err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
