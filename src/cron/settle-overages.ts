import { Request, Response } from "express";
import Stripe from "stripe";
import { pool } from "../db";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key);
}

export async function settleOverages(req: Request, res: Response): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers["x-cron-secret"] || req.headers.authorization?.replace("Bearer ", "");

  if (cronSecret && providedSecret !== cronSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const stripe = getStripe();

  const lastMonthStart = new Date();
  lastMonthStart.setUTCMonth(lastMonthStart.getUTCMonth() - 1);
  lastMonthStart.setUTCDate(1);
  lastMonthStart.setUTCHours(0, 0, 0, 0);
  const monthStartStr = lastMonthStart.toISOString().slice(0, 10);

  const rows = await pool.query<{
    client_id: string;
    total_duration_seconds: number;
    overage_preauth_intent_id: string | null;
    overage_billed_cents: number;
  }>(
    `SELECT um.client_id, um.total_duration_seconds, um.overage_preauth_intent_id, um.overage_billed_cents
     FROM usage_monthly um
     JOIN clients c ON c.id = um.client_id
     WHERE um.month_start = $1
       AND um.overage_billed_cents = 0
       AND c.monthly_minutes_limit IS NOT NULL
       AND um.total_duration_seconds > c.monthly_minutes_limit * 60`,
    [monthStartStr]
  );

  const results: Array<{ clientId: string; action: string; amount?: number }> = [];

  for (const row of rows.rows) {
    try {
      const clientResult = await pool.query<{
        monthly_minutes_limit: number;
        overage_rate_cents: number;
        overage_cap_cents: number;
        stripe_customer_id: string | null;
      }>(
        "SELECT monthly_minutes_limit, overage_rate_cents, overage_cap_cents, stripe_customer_id FROM clients WHERE id = $1",
        [row.client_id]
      );
      const client = clientResult.rows[0];
      if (!client || !client.stripe_customer_id) {
        results.push({ clientId: row.client_id, action: "skipped_no_stripe" });
        continue;
      }

      const minutesUsed = Math.ceil(row.total_duration_seconds / 60);
      const overageMinutes = Math.max(0, minutesUsed - client.monthly_minutes_limit);
      const rawOverageCents = overageMinutes * client.overage_rate_cents;
      const overageCents = Math.min(rawOverageCents, client.overage_cap_cents);

      if (overageCents <= 0) {
        results.push({ clientId: row.client_id, action: "no_overage" });
        continue;
      }

      if (row.overage_preauth_intent_id) {
        try {
          await stripe.paymentIntents.cancel(row.overage_preauth_intent_id);
        } catch (cancelErr) {
          console.warn(`[SETTLE] Could not cancel pre-auth ${row.overage_preauth_intent_id}`, cancelErr);
        }
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: overageCents,
        currency: "usd",
        customer: client.stripe_customer_id,
        description: `Cadence overage charges - ${monthStartStr}`,
        metadata: {
          client_id: row.client_id,
          type: "overage_settlement",
          month: monthStartStr,
          overage_minutes: String(overageMinutes)
        },
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        confirm: true
      });

      await pool.query(
        `UPDATE usage_monthly SET overage_billed_cents = $2
         WHERE client_id = $1 AND month_start = $3`,
        [row.client_id, overageCents, monthStartStr]
      );

      results.push({
        clientId: row.client_id,
        action: paymentIntent.status === "succeeded" ? "charged" : `charge_status_${paymentIntent.status}`,
        amount: overageCents
      });
    } catch (err) {
      console.error(`[SETTLE] Failed for ${row.client_id}`, err);
      results.push({ clientId: row.client_id, action: "error" });
    }
  }

  await pool.query(
    `UPDATE usage_monthly SET overage_disabled = false
     WHERE month_start = date_trunc('month', now())::date AND overage_disabled = true`
  );

  res.status(200).json({ settled: results.length, results });
}
