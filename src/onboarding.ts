import express from "express";
import Stripe from "stripe";
import { getOnboardingSessionById, pool } from "./db";

const router = express.Router();

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(key);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function getAllowedOnboardingOrigins(): Set<string> {
  const allowed = new Set<string>([
    "https://autom8everything.com",
    "https://www.autom8everything.com"
  ]);

  const maybeAddOriginFromUrl = (value?: string) => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "https:") {
        allowed.add(parsed.origin);
      }
    } catch {
      // ignore invalid URL envs
    }
  };

  maybeAddOriginFromUrl(process.env.ONBOARDING_SUCCESS_URL);
  maybeAddOriginFromUrl(process.env.ONBOARDING_CANCEL_URL);

  return allowed;
}

function applyOnboardingCors(req: express.Request, res: express.Response): boolean {
  const origin = req.headers.origin;
  const allowedOrigins = getAllowedOnboardingOrigins();

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  return false;
}

router.use((req, res, next) => {
  if (applyOnboardingCors(req, res)) return;
  next();
});

router.post("/start", async (req, res) => {
  const body = req.body as Record<string, string | undefined>;

  const requiredFields = [
    "business_name",
    "business_description",
    "phone_number",
    "website",
    "hours",
    "services",
    "faqs",
    "booking_instructions",
    "greeting",
    "owner_name",
    "owner_email",
    "owner_phone",
    "preferred_area_code"
  ];

  for (const field of requiredFields) {
    const value = body[field]?.trim();
    if (!value || value.length < 1 || value.length > 5000) {
      res.status(400).json({ error: `Invalid field: ${field}` });
      return;
    }
  }

  if (!isValidEmail(body.owner_email!)) {
    res.status(400).json({ error: "Invalid owner_email" });
    return;
  }

  if (!isE164(body.owner_phone!)) {
    res.status(400).json({ error: "Invalid owner_phone" });
    return;
  }

  if (body.transfer_number && !isE164(body.transfer_number)) {
    res.status(400).json({ error: "Invalid transfer_number" });
    return;
  }

  if (!/^\d{3}$/.test(body.preferred_area_code!)) {
    res.status(400).json({ error: "Invalid preferred_area_code" });
    return;
  }

  try {
    const insert = await pool.query<{ id: string }>(
      `INSERT INTO onboarding_sessions (
        business_name, business_description, phone_number, website, hours,
        services, faqs, booking_instructions, transfer_number, booking_url,
        greeting, owner_name, owner_email, owner_phone, preferred_area_code
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15
      ) RETURNING id`,
      [
        body.business_name,
        body.business_description,
        body.phone_number,
        body.website,
        body.hours,
        body.services,
        body.faqs,
        body.booking_instructions,
        body.transfer_number || null,
        body.booking_url || null,
        body.greeting,
        body.owner_name,
        body.owner_email,
        body.owner_phone,
        body.preferred_area_code
      ]
    );

    res.status(201).json({ session_id: insert.rows[0].id, status: "pending_checkout" });
  } catch (err) {
    console.error("[ONBOARDING] start failed", err);
    res.status(500).json({ error: "Failed to create onboarding session" });
  }
});

router.post("/checkout", async (req, res) => {
  const sessionId = (req.body?.session_id || "").toString();
  if (!sessionId) {
    res.status(400).json({ error: "Missing session_id" });
    return;
  }

  const session = await getOnboardingSessionById(sessionId);
  if (!session || session.status === "provisioned") {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (session.stripe_checkout_session_id) {
    const stripe = getStripe();
    const existing = await stripe.checkout.sessions.retrieve(session.stripe_checkout_session_id);
    if (existing.url) {
      res.status(409).json({ checkout_url: existing.url });
      return;
    }
  }

  try {
    const stripe = getStripe();
    const priceId = process.env.STRIPE_PRICE_ID;
    const successUrl = process.env.ONBOARDING_SUCCESS_URL;
    const cancelUrl = process.env.ONBOARDING_CANCEL_URL;

    if (!priceId || !successUrl || !cancelUrl) {
      res.status(500).json({ error: "Stripe checkout not configured" });
      return;
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { onboarding_session_id: session.id }
    });

    await pool.query(
      "UPDATE onboarding_sessions SET stripe_checkout_session_id = $2, updated_at = now() WHERE id = $1",
      [session.id, checkout.id]
    );

    res.status(200).json({ checkout_url: checkout.url });
  } catch (err) {
    console.error("[ONBOARDING] checkout failed", err);
    res.status(500).json({ error: "Failed to create checkout" });
  }
});

router.get("/status/:sessionId", async (req, res) => {
  const session = await getOnboardingSessionById(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.status(200).json({
    session_id: session.id,
    status: session.status,
    phone_number: session.provisioned_phone_number,
    business_name: session.business_name,
    provision_error: session.provision_error
  });
});

export default router;
