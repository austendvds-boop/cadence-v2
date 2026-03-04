import Stripe from "stripe";
import {
  getClientById,
  getClientByStripeCustomer,
  getClientByStripeSubscription,
  pool,
  setClientActive,
  type Client
} from "./db";

const TRIAL_DAYS = 7;

type BillingPaymentStatus = "paid" | "failed";

export interface CheckoutSessionResult {
  checkoutSessionId: string;
  checkoutUrl: string;
  stripeCustomerId: string | null;
}

export interface BillingWebhookResult {
  processed: boolean;
  duplicate: boolean;
  clientId: string | null;
  reactivatedAfterFailure?: boolean;
}

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key);
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function toIsoFromUnix(unixSeconds: number | null | undefined): string | null {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function getTrialEndIso(now = new Date()): string {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeOptionalEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function withCheckoutSessionId(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("session_id")) {
      parsed.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function getBillingRedirectUrls(): { successUrl: string; cancelUrl: string } {
  const successUrl = process.env.BILLING_SUCCESS_URL || process.env.ONBOARDING_SUCCESS_URL;
  const cancelUrl = process.env.BILLING_CANCEL_URL || process.env.ONBOARDING_CANCEL_URL;

  if (!successUrl) throw new Error("Missing BILLING_SUCCESS_URL or ONBOARDING_SUCCESS_URL");
  if (!cancelUrl) throw new Error("Missing BILLING_CANCEL_URL or ONBOARDING_CANCEL_URL");

  return {
    successUrl: withCheckoutSessionId(successUrl),
    cancelUrl
  };
}

function getMetadataClientId(metadata: Stripe.Metadata | null | undefined): string | null {
  const raw = metadata?.client_id;
  if (!raw) return null;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === "string") return fromParent;
  if (fromParent && typeof fromParent === "object") return fromParent.id;
  return null;
}

function isSubscriptionActive(status: Stripe.Subscription.Status): boolean {
  return status === "active" || status === "trialing";
}

async function recordBillingEvent(event: Stripe.Event): Promise<boolean> {
  const insert = await pool.query(
    `INSERT INTO billing_events (stripe_event_id, stripe_event_type, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [event.id, event.type, JSON.stringify(event)]
  );

  return (insert.rowCount ?? 0) > 0;
}

async function attachBillingEventClient(eventId: string, clientId: string | null): Promise<void> {
  if (!clientId) return;

  await pool.query(
    "UPDATE billing_events SET client_id = $2 WHERE stripe_event_id = $1",
    [eventId, clientId]
  );
}

async function syncClientStripeRefs(
  clientId: string,
  stripeCustomerId: string | null,
  stripeSubscriptionId: string | null
): Promise<void> {
  await pool.query(
    `UPDATE clients
     SET stripe_customer_id = COALESCE($2, stripe_customer_id),
         stripe_subscription_id = COALESCE($3, stripe_subscription_id),
         updated_at = now()
     WHERE id = $1`,
    [clientId, stripeCustomerId, stripeSubscriptionId]
  );
}

async function resolveClient(
  clientId: string | null,
  stripeCustomerId: string | null,
  stripeSubscriptionId: string | null
): Promise<Client | null> {
  if (clientId) {
    const byId = await getClientById(clientId);
    if (byId) return byId;
  }

  if (stripeSubscriptionId) {
    const bySubscription = await getClientByStripeSubscription(stripeSubscriptionId);
    if (bySubscription) return bySubscription;
  }

  if (stripeCustomerId) {
    const byCustomer = await getClientByStripeCustomer(stripeCustomerId);
    if (byCustomer) return byCustomer;
  }

  return null;
}

async function upsertBillingSubscriptionForCheckout(
  clientId: string,
  stripeCustomerId: string | null,
  stripePriceId: string,
  status: string
): Promise<void> {
  await pool.query(
    `INSERT INTO billing_subscriptions (
      client_id,
      stripe_customer_id,
      stripe_price_id,
      status,
      trial_end_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, now()
    )
    ON CONFLICT (client_id) DO UPDATE SET
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_subscriptions.stripe_customer_id),
      stripe_price_id = EXCLUDED.stripe_price_id,
      status = EXCLUDED.status,
      trial_end_at = EXCLUDED.trial_end_at,
      updated_at = now()`,
    [clientId, stripeCustomerId, stripePriceId, status, getTrialEndIso()]
  );
}

async function upsertBillingSubscriptionFromSubscription(clientId: string, subscription: Stripe.Subscription): Promise<void> {
  const stripeCustomerId = typeof subscription.customer === "string" ? subscription.customer : null;
  const stripePriceId = subscription.items.data[0]?.price?.id ?? null;
  const currentPeriodStart = toIsoFromUnix(subscription.items.data[0]?.current_period_start);
  const currentPeriodEnd = toIsoFromUnix(subscription.items.data[0]?.current_period_end);

  await pool.query(
    `INSERT INTO billing_subscriptions (
      client_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      status,
      trial_end_at,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      canceled_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      now()
    )
    ON CONFLICT (client_id) DO UPDATE SET
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_subscriptions.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, billing_subscriptions.stripe_subscription_id),
      stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, billing_subscriptions.stripe_price_id),
      status = EXCLUDED.status,
      trial_end_at = EXCLUDED.trial_end_at,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      canceled_at = EXCLUDED.canceled_at,
      updated_at = now()`,
    [
      clientId,
      stripeCustomerId,
      subscription.id,
      stripePriceId,
      subscription.status,
      toIsoFromUnix(subscription.trial_end),
      currentPeriodStart,
      currentPeriodEnd,
      subscription.cancel_at_period_end,
      toIsoFromUnix(subscription.canceled_at)
    ]
  );
}

async function upsertBillingSubscriptionFromInvoice(
  clientId: string,
  invoice: Stripe.Invoice,
  paymentStatus: BillingPaymentStatus
): Promise<void> {
  const stripeCustomerId = typeof invoice.customer === "string" ? invoice.customer : null;
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);

  const periodStart = toIsoFromUnix(invoice.lines.data[0]?.period?.start);
  const periodEnd = toIsoFromUnix(invoice.lines.data[0]?.period?.end);
  const paidAt = paymentStatus === "paid"
    ? toIsoFromUnix(invoice.status_transitions?.paid_at) || new Date().toISOString()
    : new Date().toISOString();

  await pool.query(
    `INSERT INTO billing_subscriptions (
      client_id,
      stripe_customer_id,
      stripe_subscription_id,
      status,
      current_period_start,
      current_period_end,
      last_payment_status,
      last_payment_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      now()
    )
    ON CONFLICT (client_id) DO UPDATE SET
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_subscriptions.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, billing_subscriptions.stripe_subscription_id),
      status = EXCLUDED.status,
      current_period_start = COALESCE(EXCLUDED.current_period_start, billing_subscriptions.current_period_start),
      current_period_end = COALESCE(EXCLUDED.current_period_end, billing_subscriptions.current_period_end),
      last_payment_status = EXCLUDED.last_payment_status,
      last_payment_at = EXCLUDED.last_payment_at,
      updated_at = now()`,
    [
      clientId,
      stripeCustomerId,
      stripeSubscriptionId,
      paymentStatus === "paid" ? "active" : "past_due",
      periodStart,
      periodEnd,
      paymentStatus,
      paidAt
    ]
  );
}

async function hadPreviousPaymentFailure(clientId: string): Promise<boolean> {
  const result = await pool.query<{ last_payment_status: string | null }>(
    "SELECT last_payment_status FROM billing_subscriptions WHERE client_id = $1 LIMIT 1",
    [clientId]
  );

  return result.rows[0]?.last_payment_status === "failed";
}

export async function createCheckoutSession(clientId: string, email: string): Promise<CheckoutSessionResult> {
  const client = await getClientById(clientId);
  if (!client) {
    throw new Error(`Client not found for checkout session: ${clientId}`);
  }

  const stripe = getStripe();
  const priceId = requireEnv("STRIPE_PRICE_ID");
  const { successUrl, cancelUrl } = getBillingRedirectUrls();

  const ownerEmail = normalizeOptionalEmail(email) || normalizeOptionalEmail(client.owner_email);
  if (!client.stripe_customer_id && !ownerEmail) {
    throw new Error("Checkout session requires an email when no Stripe customer exists");
  }

  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: {
        client_id: client.id
      }
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer: client.stripe_customer_id ?? undefined,
    customer_email: client.stripe_customer_id ? undefined : ownerEmail ?? undefined,
    metadata: {
      client_id: client.id,
      owner_email: ownerEmail ?? "",
      source: "post_onboarding"
    }
  });

  if (!checkout.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  const stripeCustomerId = typeof checkout.customer === "string" ? checkout.customer : client.stripe_customer_id;

  await syncClientStripeRefs(client.id, stripeCustomerId, null);
  await upsertBillingSubscriptionForCheckout(client.id, stripeCustomerId, priceId, "pending_checkout");

  return {
    checkoutSessionId: checkout.id,
    checkoutUrl: checkout.url,
    stripeCustomerId
  };
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<BillingWebhookResult> {
  const firstSeen = await recordBillingEvent(event);
  if (!firstSeen) {
    return {
      processed: false,
      duplicate: true,
      clientId: null
    };
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const checkout = event.data.object as Stripe.Checkout.Session;
      const metadataClientId = getMetadataClientId(checkout.metadata);
      const stripeCustomerId = typeof checkout.customer === "string" ? checkout.customer : null;
      const stripeSubscriptionId = typeof checkout.subscription === "string" ? checkout.subscription : null;

      const client = await resolveClient(metadataClientId, stripeCustomerId, stripeSubscriptionId);
      const clientId = client?.id ?? null;

      if (!clientId) {
        return {
          processed: true,
          duplicate: false,
          clientId: null
        };
      }

      const priceId = process.env.STRIPE_PRICE_ID || null;

      await syncClientStripeRefs(clientId, stripeCustomerId, stripeSubscriptionId);
      await pool.query(
        `INSERT INTO billing_subscriptions (
          client_id,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_price_id,
          status,
          trial_end_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, now()
        )
        ON CONFLICT (client_id) DO UPDATE SET
          stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_subscriptions.stripe_customer_id),
          stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, billing_subscriptions.stripe_subscription_id),
          stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, billing_subscriptions.stripe_price_id),
          status = EXCLUDED.status,
          trial_end_at = EXCLUDED.trial_end_at,
          updated_at = now()`,
        [clientId, stripeCustomerId, stripeSubscriptionId, priceId, "trialing", getTrialEndIso()]
      );
      await setClientActive(clientId, true);
      await attachBillingEventClient(event.id, clientId);

      return {
        processed: true,
        duplicate: false,
        clientId
      };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const metadataClientId = getMetadataClientId(subscription.metadata);
      const stripeCustomerId = typeof subscription.customer === "string" ? subscription.customer : null;

      const client = await resolveClient(metadataClientId, stripeCustomerId, subscription.id);
      const clientId = client?.id ?? null;

      if (!clientId) {
        return {
          processed: true,
          duplicate: false,
          clientId: null
        };
      }

      await syncClientStripeRefs(clientId, stripeCustomerId, subscription.id);
      await upsertBillingSubscriptionFromSubscription(clientId, subscription);
      await setClientActive(clientId, isSubscriptionActive(subscription.status));
      await attachBillingEventClient(event.id, clientId);

      return {
        processed: true,
        duplicate: false,
        clientId
      };
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeCustomerId = typeof invoice.customer === "string" ? invoice.customer : null;
      const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
      const isInvoicePaid = event.type === "invoice.paid";

      const client = await resolveClient(null, stripeCustomerId, stripeSubscriptionId);
      const clientId = client?.id ?? null;

      if (!clientId || !client) {
        return {
          processed: true,
          duplicate: false,
          clientId: null
        };
      }

      const reactivatedAfterFailure = isInvoicePaid
        ? !client.active && (await hadPreviousPaymentFailure(clientId))
        : false;

      await syncClientStripeRefs(clientId, stripeCustomerId, stripeSubscriptionId);
      await upsertBillingSubscriptionFromInvoice(
        clientId,
        invoice,
        isInvoicePaid ? "paid" : "failed"
      );
      await setClientActive(clientId, isInvoicePaid);
      await attachBillingEventClient(event.id, clientId);

      return {
        processed: true,
        duplicate: false,
        clientId,
        reactivatedAfterFailure
      };
    }

    default:
      return {
        processed: true,
        duplicate: false,
        clientId: null
      };
  }
}
