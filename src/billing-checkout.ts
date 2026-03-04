import { createCheckoutSession } from "./billing-service";

export interface PostOnboardingCheckoutLink {
  checkoutSessionId: string;
  checkoutUrl: string;
  smsBody: string;
  emailSubject: string;
  emailBody: string;
}

function buildSmsBody(checkoutUrl: string): string {
  return `Your Cadence line is live. Start your 7-day free trial and activate billing here: ${checkoutUrl}`;
}

function buildEmailSubject(): string {
  return "Activate your Cadence billing";
}

function buildEmailBody(checkoutUrl: string): string {
  return [
    "Your Cadence line has been provisioned.",
    "",
    "Use this secure Stripe link to start your 7-day free trial and activate billing:",
    checkoutUrl,
    "",
    "If you need help with setup, reply and we'll assist right away."
  ].join("\n");
}

export async function generatePostOnboardingCheckoutLink(
  clientId: string,
  email: string
): Promise<PostOnboardingCheckoutLink> {
  const checkout = await createCheckoutSession(clientId, email);

  return {
    checkoutSessionId: checkout.checkoutSessionId,
    checkoutUrl: checkout.checkoutUrl,
    smsBody: buildSmsBody(checkout.checkoutUrl),
    emailSubject: buildEmailSubject(),
    emailBody: buildEmailBody(checkout.checkoutUrl)
  };
}
