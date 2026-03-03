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
  plan: "trial" | "starter" | "growth";
  trial_ends_at: Date | null;
  active: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
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
  await pool.query("UPDATE clients SET active = $1, updated_at = now() WHERE id = $2", [active, clientId]);
}

export async function getClientByStripeCustomer(stripeCustomerId: string): Promise<Client | null> {
  const result = await pool.query<Client>("SELECT * FROM clients WHERE stripe_customer_id = $1 LIMIT 1", [stripeCustomerId]);
  return result.rows[0] || null;
}

export async function getClientByStripeSubscription(subscriptionId: string): Promise<Client | null> {
  const result = await pool.query<Client>("SELECT * FROM clients WHERE stripe_subscription_id = $1 LIMIT 1", [subscriptionId]);
  return result.rows[0] || null;
}

export { pool };
