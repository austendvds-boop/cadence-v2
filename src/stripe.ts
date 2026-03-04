import { Request, Response } from "express";
import Stripe from "stripe";
import { pool } from "./db";
import { runProvisioningForOnboarding } from "./provisioning";
import { writeAuditLog } from "./audit";
import { handleWebhookEvent } from "./billing-service";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key);
}

async function markProcessed(eventId: string, eventType: string): Promise<boolean> {
  const insert = await pool.query(
    "INSERT INTO processed_stripe_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
    [eventId, eventType]
  );
  return (insert.rowCount ?? 0) > 0;
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"] as string | undefined;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    res.status(400).send("Missing signature or webhook secret");
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch (err) {
    console.error("[STRIPE] signature verification failed", err);
    res.status(400).send("Invalid signature");
    return;
  }

  try {
    const firstProcess = await markProcessed(event.id, event.type);
    if (!firstProcess) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    const billingResult = await handleWebhookEvent(event);

    switch (event.type) {
      case "checkout.session.completed": {
        const checkout = event.data.object as Stripe.Checkout.Session;
        const onboardingSessionId = checkout.metadata?.onboarding_session_id;

        if (onboardingSessionId) {
          await pool.query(
            `UPDATE onboarding_sessions
             SET status = 'checkout_complete',
                 stripe_customer_id = $2,
                 stripe_subscription_id = $3,
                 updated_at = now()
             WHERE id = $1 AND status IN ('pending_checkout', 'checkout_complete')`,
            [
              onboardingSessionId,
              typeof checkout.customer === "string" ? checkout.customer : null,
              typeof checkout.subscription === "string" ? checkout.subscription : null
            ]
          );

          await writeAuditLog("onboarding_session", onboardingSessionId, "checkout_completed", {
            stripeEventId: event.id,
            checkoutSessionId: checkout.id
          });

          setImmediate(() => {
            runProvisioningForOnboarding(onboardingSessionId).catch((err) => {
              console.error("[PROVISIONING] async pipeline failed", err);
            });
          });
        }
        break;
      }

      case "invoice.paid": {
        if (billingResult.clientId) {
          const reactivatedAfterFailure = Boolean(billingResult.reactivatedAfterFailure);
          await writeAuditLog(
            "client",
            billingResult.clientId,
            reactivatedAfterFailure ? "invoice_paid_reactivated" : "invoice_paid",
            {
              stripeEventId: event.id,
              reactivatedAfterFailure
            }
          );
        }
        break;
      }

      case "invoice.payment_failed": {
        if (billingResult.clientId) {
          await writeAuditLog("client", billingResult.clientId, "payment_failed", {
            stripeEventId: event.id
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        if (billingResult.clientId) {
          await writeAuditLog("client", billingResult.clientId, "subscription_deleted", {
            stripeEventId: event.id
          });
        }
        break;
      }

      default:
        break;
    }

    res.status(200).json({
      received: true,
      billingProcessed: billingResult.processed,
      billingDuplicate: billingResult.duplicate
    });
  } catch (err) {
    console.error("[STRIPE] webhook processing failed", err);
    res.status(500).send("Webhook processing failed");
  }
}
