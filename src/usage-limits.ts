import Stripe from "stripe";
import { pool } from "./db";

// Plan limits in minutes (null = unlimited)
const PLAN_MINUTE_LIMITS: Record<string, number | null> = {
  trial: 120,
  starter: 200,
  growth: 500
  // "pro" or any unknown plan = unlimited (null)
};

interface UsageCheckResult {
  overLimit: boolean;
  minutesUsed: number;
  minuteLimit: number | null;
  overageMinutes: number;
  overageCents: number;
}

interface ClientLimits {
  plan: string;
  monthly_minutes_limit: number | null;
  overage_rate_cents: number;
  overage_cap_cents: number;
  stripe_customer_id: string | null;
  business_name: string;
  owner_email: string | null;
  owner_phone: string | null;
  phone_number: string | null;
}

interface UsageRow {
  total_duration_seconds: number;
  overage_preauth_intent_id: string | null;
  overage_notified_at: Date | null;
  overage_disabled: boolean;
  overage_billed_cents: number;
}

function getMinuteLimit(client: ClientLimits): number | null {
  // Per-client override takes precedence
  if (client.monthly_minutes_limit !== null && client.monthly_minutes_limit !== undefined) {
    return client.monthly_minutes_limit;
  }
  // Fall back to plan default
  const planLimit = PLAN_MINUTE_LIMITS[client.plan];
  return planLimit === undefined ? null : planLimit;
}

export async function checkAndHandleUsage(clientId: string): Promise<void> {
  // 1. Load client limits
  const clientResult = await pool.query<ClientLimits>(
    `SELECT plan, monthly_minutes_limit, overage_rate_cents, overage_cap_cents,
            stripe_customer_id, business_name, owner_email, owner_phone, phone_number
     FROM clients WHERE id = $1`,
    [clientId]
  );
  const client = clientResult.rows[0];
  if (!client) return;

  const minuteLimit = getMinuteLimit(client);
  if (minuteLimit === null) return; // unlimited plan

  // 2. Load current month usage
  const usageResult = await pool.query<UsageRow>(
    `SELECT total_duration_seconds, overage_preauth_intent_id, overage_notified_at,
            overage_disabled, overage_billed_cents
     FROM usage_monthly
     WHERE client_id = $1 AND month_start = date_trunc('month', now())::date`,
    [clientId]
  );
  const usage = usageResult.rows[0];
  if (!usage) return;

  const minutesUsed = Math.ceil(usage.total_duration_seconds / 60);
  if (minutesUsed <= minuteLimit) return; // still under limit

  const overageMinutes = minutesUsed - minuteLimit;
  const rawOverageCents = overageMinutes * client.overage_rate_cents;
  const overageCents = Math.min(rawOverageCents, client.overage_cap_cents);

  // 3. Send Telegram alert (once per month per client)
  if (!usage.overage_notified_at) {
    await sendTelegramAlert(client, minutesUsed, minuteLimit, overageMinutes);
    await pool.query(
      `UPDATE usage_monthly SET overage_notified_at = now()
       WHERE client_id = $1 AND month_start = date_trunc('month', now())::date`,
      [clientId]
    );
  }

  // 4. Create Stripe pre-auth if not already done
  if (!usage.overage_preauth_intent_id && client.stripe_customer_id) {
    await createOveragePreauth(clientId, client);
  }
}

async function sendTelegramAlert(
  client: ClientLimits,
  minutesUsed: number,
  minuteLimit: number,
  overageMinutes: number
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID || "7077676180";
  if (!botToken) {
    console.warn("[USAGE] TELEGRAM_BOT_TOKEN not set, skipping alert");
    return;
  }

  const message = [
    `?? Cadence Usage Alert`,
    ``,
    `Client: ${client.business_name}`,
    `Plan: ${client.plan}`,
    `Used: ${minutesUsed} min / ${minuteLimit} min limit`,
    `Overage: ${overageMinutes} min ($${(overageMinutes * client.overage_rate_cents / 100).toFixed(2)})`,
    ``,
    `Cadence is still answering calls (soft cap).`
  ].join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  } catch (err) {
    console.error("[USAGE] Telegram alert failed", err);
  }
}

async function createOveragePreauth(clientId: string, client: ClientLimits): Promise<void> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey || !client.stripe_customer_id) return;

  try {
    const stripe = new Stripe(stripeKey);

    // Get the customer's default payment method
    const customer = (await stripe.customers.retrieve(client.stripe_customer_id)) as Stripe.Customer;
    const paymentMethod = customer.invoice_settings?.default_payment_method;

    if (!paymentMethod) {
      console.warn(`[USAGE] No default payment method for ${client.business_name}, skipping pre-auth`);
      return;
    }

    const intent = await stripe.paymentIntents.create({
      amount: 3000, // $30.00 pre-auth
      currency: "usd",
      customer: client.stripe_customer_id,
      payment_method: typeof paymentMethod === "string" ? paymentMethod : paymentMethod.id,
      capture_method: "manual",
      confirm: true,
      description: `Cadence overage pre-authorization - ${client.business_name}`,
      metadata: {
        client_id: clientId,
        type: "overage_preauth"
      },
      automatic_payment_methods: { enabled: true, allow_redirects: "never" }
    });

    if (intent.status === "requires_capture") {
      // Pre-auth succeeded
      await pool.query(
        `UPDATE usage_monthly SET overage_preauth_intent_id = $2
         WHERE client_id = $1 AND month_start = date_trunc('month', now())::date`,
        [clientId, intent.id]
      );
    } else {
      // Pre-auth did not succeed — soft-disable
      console.warn(`[USAGE] Pre-auth status ${intent.status} for ${client.business_name}`);
      await softDisableClient(clientId, client);
    }
  } catch (err) {
    console.error(`[USAGE] Pre-auth failed for ${client.business_name}`, err);
    await softDisableClient(clientId, client);
  }
}

async function softDisableClient(clientId: string, client: ClientLimits): Promise<void> {
  // Mark as overage-disabled in usage_monthly
  await pool.query(
    `UPDATE usage_monthly SET overage_disabled = true
     WHERE client_id = $1 AND month_start = date_trunc('month', now())::date`,
    [clientId]
  );

  // Send warning SMS to client owner
  if (client.owner_phone && client.phone_number) {
    const { sendSms } = await import("./sms");
    try {
      await sendSms(
        client.owner_phone,
        client.phone_number,
        `${client.business_name}: Your Cadence line has been paused because we couldn't authorize your payment method for overage charges. Please update your payment method in the portal to resume. - Autom8`
      );
    } catch (err) {
      console.error(`[USAGE] Warning SMS failed for ${client.business_name}`, err);
    }
  }

  // Send Telegram alert to Austen
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID || "7077676180";
  if (botToken) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `?? Cadence DISABLED: ${client.business_name}\nPre-auth failed. Calls routing to voicemail.\nClient: ${client.owner_email || "no email"}`
        })
      });
    } catch (err) {
      console.error("[USAGE] Telegram disable alert failed", err);
    }
  }
}
