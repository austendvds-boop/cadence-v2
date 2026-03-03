import { pool, type OnboardingSession, type Client } from "./db";
import { generateSystemPrompt } from "./prompt-template";
import { purchaseAndConfigureTwilioNumber } from "./twilio-numbers";
import { sendSms } from "./sms";
import { writeAuditLog } from "./audit";

async function sendWelcomeSms(session: OnboardingSession, twilioNumber: string): Promise<void> {
  await sendSms(
    session.owner_phone,
    twilioNumber,
    `Your Cadence line is live at ${twilioNumber}. Forward your business calls to this number to go live. Reply if you need setup help.`
  );
}

export async function runProvisioningForOnboarding(sessionId: string): Promise<void> {
  const claim = await pool.query<{ id: string }>(
    "UPDATE onboarding_sessions SET status = 'provisioning', updated_at = now() WHERE id = $1 AND status = 'checkout_complete' RETURNING id",
    [sessionId]
  );

  if (claim.rowCount === 0) return;

  const sessionResult = await pool.query<OnboardingSession>("SELECT * FROM onboarding_sessions WHERE id = $1 LIMIT 1", [sessionId]);
  const session = sessionResult.rows[0];
  if (!session) return;

  try {
    const number = await purchaseAndConfigureTwilioNumber(session.preferred_area_code, session.business_name);

    const systemPrompt = generateSystemPrompt({
      businessName: session.business_name,
      businessDescription: session.business_description,
      phoneNumber: session.phone_number,
      website: session.website,
      hours: session.hours,
      services: session.services,
      faqs: session.faqs,
      bookingInstructions: session.booking_instructions,
      transferNumber: session.transfer_number,
      smsBookingUrl: session.booking_url
    });

    const clientTx = await pool.connect();
    try {
      await clientTx.query("BEGIN");

      const existingClient = await clientTx.query<Client>(
        "SELECT * FROM clients WHERE onboarding_session_id = $1 OR stripe_customer_id = $2 LIMIT 1",
        [session.id, session.stripe_customer_id]
      );

      let clientId = existingClient.rows[0]?.id;

      if (!clientId) {
        const insertedClient = await clientTx.query<{ id: string }>(
          `INSERT INTO clients (
            business_name, phone_number, system_prompt, transfer_number, greeting,
            sms_enabled, booking_url, owner_phone, owner_name, owner_email,
            plan, trial_ends_at, active, stripe_customer_id, stripe_subscription_id,
            onboarding_session_id, twilio_number_sid
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, true, $13, $14,
            $15, $16
          ) RETURNING id`,
          [
            session.business_name,
            number.phoneNumber,
            systemPrompt,
            session.transfer_number,
            session.greeting,
            !!session.booking_url,
            session.booking_url,
            session.owner_phone,
            session.owner_name,
            session.owner_email,
            "trial",
            new Date(Date.now() + 7 * 86400000).toISOString(),
            session.stripe_customer_id,
            session.stripe_subscription_id,
            session.id,
            number.sid
          ]
        );
        clientId = insertedClient.rows[0].id;
      }

      await clientTx.query(
        `UPDATE onboarding_sessions
         SET status = 'provisioned',
             provisioned_client_id = $2,
             provisioned_phone_number = $3,
             provisioned_at = now(),
             updated_at = now(),
             provision_error = NULL
         WHERE id = $1`,
        [session.id, clientId, number.phoneNumber]
      );

      await clientTx.query(
        "INSERT INTO audit_log (entity_type, entity_id, action, details) VALUES ('onboarding_session', $1, 'provisioned', $2)",
        [session.id, JSON.stringify({ clientId, phoneNumber: number.phoneNumber, usedAreaCode: number.usedAreaCode })]
      );

      await clientTx.query("COMMIT");
    } catch (error) {
      await clientTx.query("ROLLBACK");
      throw error;
    } finally {
      clientTx.release();
    }

    await sendWelcomeSms(session, number.phoneNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown provisioning error";
    await pool.query(
      "UPDATE onboarding_sessions SET status = 'failed', provision_error = $2, updated_at = now() WHERE id = $1",
      [session.id, message]
    );
    await writeAuditLog("onboarding_session", session.id, "provision_failed", { error: message });
  }
}
