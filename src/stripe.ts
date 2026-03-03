import { Request, Response } from "express";
import Stripe from "stripe";
import { getClientByStripeCustomer, getClientByStripeSubscription, setClientActive } from "./db";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key);
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
    switch (event.type) {
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        if (customerId) {
          const client = await getClientByStripeCustomer(customerId);
          if (client) await setClientActive(client.id, true);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        if (customerId) {
          const client = await getClientByStripeCustomer(customerId);
          if (client) await setClientActive(client.id, false);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const client = await getClientByStripeSubscription(subscription.id);
        if (client) await setClientActive(client.id, false);
        break;
      }
      default:
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[STRIPE] webhook processing failed", err);
    res.status(500).send("Webhook processing failed");
  }
}
