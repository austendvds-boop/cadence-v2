import { writeAuditLog } from "./audit";
import { pool } from "./db";
import { generateSystemPrompt } from "./prompt-template";
import { sendSms } from "./sms";
import { purchaseAndConfigureTwilioNumber } from "./twilio-numbers";

export type ProvisionPlan = "trial" | "starter" | "growth";

export interface ProvisionClientInput {
  businessName: string;
  businessDescription: string;
  businessPhone: string;
  website: string;
  hours: string;
  services: string;
  faqs: string;
  bookingInstructions: string;
  preferredAreaCode: string;
  transferNumber?: string | null;
  bookingUrl?: string | null;
  greeting?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  plan?: ProvisionPlan;
  trialDays?: number;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  onboardingSessionId?: string | null;
}

export interface ProvisionClientOptions {
  dryRun?: boolean;
  now?: Date;
  skipWelcomeSms?: boolean;
}

export interface ProvisionClientResult {
  dryRun: boolean;
  clientId: string | null;
  phoneNumber: string;
  twilioNumberSid: string | null;
  usedAreaCode: string | null;
  greeting: string;
  systemPrompt: string;
  plan: ProvisionPlan;
  trialEndsAt: string | null;
}

function defaultGreeting(businessName: string): string {
  return `Hi, thanks for calling ${businessName}! This is Cadence, how can I help you today?`;
}

function normalizeTrialDays(plan: ProvisionPlan, trialDays?: number): number {
  if (plan !== "trial") return 0;
  if (typeof trialDays !== "number" || !Number.isFinite(trialDays)) return 7;
  return Math.max(0, Math.floor(trialDays));
}

function getTrialEndsAt(now: Date, trialDays: number): string | null {
  if (trialDays <= 0) return null;
  return new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();
}

function validateRequired(input: ProvisionClientInput): void {
  const required: Array<keyof ProvisionClientInput> = [
    "businessName",
    "businessDescription",
    "businessPhone",
    "website",
    "hours",
    "services",
    "faqs",
    "bookingInstructions",
    "preferredAreaCode"
  ];

  for (const key of required) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Missing required provision-client field: ${key}`);
    }
  }
}

async function sendWelcomeSms(ownerPhone: string, twilioNumber: string): Promise<void> {
  await sendSms(
    ownerPhone,
    twilioNumber,
    `Your Cadence line is live at ${twilioNumber}. Forward your business calls to this number to go live. Reply if you need setup help.`
  );
}

export async function provisionClient(
  input: ProvisionClientInput,
  options: ProvisionClientOptions = {}
): Promise<ProvisionClientResult> {
  validateRequired(input);

  const now = options.now ?? new Date();
  const plan: ProvisionPlan = input.plan ?? "trial";
  const trialDays = normalizeTrialDays(plan, input.trialDays);
  const trialEndsAt = getTrialEndsAt(now, trialDays);

  const greeting = (input.greeting || defaultGreeting(input.businessName)).trim();

  const systemPrompt = generateSystemPrompt({
    businessName: input.businessName,
    businessDescription: input.businessDescription,
    phoneNumber: input.businessPhone,
    website: input.website,
    hours: input.hours,
    services: input.services,
    faqs: input.faqs,
    bookingInstructions: input.bookingInstructions,
    transferNumber: input.transferNumber ?? null,
    smsBookingUrl: input.bookingUrl ?? null
  });

  if (options.dryRun) {
    return {
      dryRun: true,
      clientId: null,
      phoneNumber: "+15555550199",
      twilioNumberSid: "PN_DRY_RUN",
      usedAreaCode: input.preferredAreaCode,
      greeting,
      systemPrompt,
      plan,
      trialEndsAt
    };
  }

  const number = await purchaseAndConfigureTwilioNumber(input.preferredAreaCode, input.businessName);

  const insert = await pool.query<{ id: string }>(
    `INSERT INTO clients (
      business_name,
      phone_number,
      system_prompt,
      transfer_number,
      greeting,
      sms_enabled,
      booking_url,
      owner_phone,
      owner_name,
      owner_email,
      plan,
      trial_ends_at,
      active,
      stripe_customer_id,
      stripe_subscription_id,
      onboarding_session_id,
      twilio_number_sid
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, true, $13, $14,
      $15, $16
    )
    RETURNING id`,
    [
      input.businessName,
      number.phoneNumber,
      systemPrompt,
      input.transferNumber ?? null,
      greeting,
      !!input.bookingUrl,
      input.bookingUrl ?? null,
      input.ownerPhone ?? null,
      input.ownerName ?? null,
      input.ownerEmail ?? null,
      plan,
      trialEndsAt,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.onboardingSessionId ?? null,
      number.sid
    ]
  );

  const clientId = insert.rows[0].id;

  await writeAuditLog("client", clientId, "provisioned", {
    phoneNumber: number.phoneNumber,
    twilioNumberSid: number.sid,
    usedAreaCode: number.usedAreaCode,
    source: "provision-client"
  });

  if (input.ownerPhone && !options.skipWelcomeSms) {
    await sendWelcomeSms(input.ownerPhone, number.phoneNumber);
  }

  return {
    dryRun: false,
    clientId,
    phoneNumber: number.phoneNumber,
    twilioNumberSid: number.sid,
    usedAreaCode: number.usedAreaCode,
    greeting,
    systemPrompt,
    plan,
    trialEndsAt
  };
}
