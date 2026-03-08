import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10
});

export interface Client {
  id: string;
  business_name: string;
  phone_number: string;
  system_prompt: string;
  transfer_number: string | null;
  greeting: string;
  sms_enabled: boolean;
  booking_url: string | null;
  owner_phone: string | null;
  owner_name: string | null;
  owner_email: string | null;
  onboarding_session_id: string | null;
  twilio_number_sid: string | null;
  deactivated_at: Date | null;
  number_release_after: Date | null;
  plan: "trial" | "starter" | "growth";
  trial_ends_at: Date | null;
  active: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  monthly_minutes_limit: number | null;
  overage_rate_cents: number;
  overage_cap_cents: number;
}

export interface OnboardingSession {
  id: string;
  status: "pending_checkout" | "checkout_complete" | "provisioning" | "provisioned" | "failed";
  business_name: string;
  business_description: string;
  phone_number: string;
  website: string;
  hours: string;
  services: string;
  faqs: string;
  booking_instructions: string;
  transfer_number: string | null;
  booking_url: string | null;
  greeting: string;
  owner_name: string;
  owner_email: string;
  owner_phone: string;
  preferred_area_code: string;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  provisioned_client_id: string | null;
  provisioned_phone_number: string | null;
  provision_error: string | null;
}

export async function getClientByPhone(phoneNumber: string): Promise<Client | null> {
  const result = await pool.query<Client>("SELECT * FROM clients WHERE phone_number = $1 LIMIT 1", [phoneNumber]);
  return result.rows[0] || null;
}

export async function getClientById(clientId: string): Promise<Client | null> {
  const result = await pool.query<Client>("SELECT * FROM clients WHERE id = $1 LIMIT 1", [clientId]);
  return result.rows[0] || null;
}

export function isTrialExpired(client: Client): boolean {
  if (client.plan !== "trial") return false;
  if (!client.trial_ends_at) return false;
  return client.trial_ends_at < new Date() && !client.stripe_subscription_id;
}

export async function setClientActive(clientId: string, active: boolean): Promise<void> {
  if (active) {
    await pool.query(
      "UPDATE clients SET active = true, deactivated_at = NULL, number_release_after = NULL, updated_at = now() WHERE id = $1",
      [clientId]
    );
    return;
  }

  await pool.query(
    "UPDATE clients SET active = false, deactivated_at = now(), number_release_after = now() + interval '30 days', updated_at = now() WHERE id = $1",
    [clientId]
  );
}

export async function getClientByStripeCustomer(stripeCustomerId: string): Promise<Client | null> {
  const result = await pool.query<Client>("SELECT * FROM clients WHERE stripe_customer_id = $1 LIMIT 1", [stripeCustomerId]);
  return result.rows[0] || null;
}

export async function getClientByStripeSubscription(subscriptionId: string): Promise<Client | null> {
  const result = await pool.query<Client>("SELECT * FROM clients WHERE stripe_subscription_id = $1 LIMIT 1", [subscriptionId]);
  return result.rows[0] || null;
}

export async function getOnboardingSessionById(sessionId: string): Promise<OnboardingSession | null> {
  const result = await pool.query<OnboardingSession>("SELECT * FROM onboarding_sessions WHERE id = $1 LIMIT 1", [sessionId]);
  return result.rows[0] || null;
}

export { pool, pg };
