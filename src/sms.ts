function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

export async function sendSms(to: string, from: string, body: string): Promise<void> {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const token = requireEnv("TWILIO_AUTH_TOKEN");

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: from, Body: body });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio SMS failed ${response.status}: ${text}`);
  }
}

export async function sendBookingLink(to: string, from: string, bookingUrl: string): Promise<void> {
  await sendSms(to, from, `Here's the link to book: ${bookingUrl}`);
}

export async function sendCallSummary(
  callerPhone: string,
  summary: string[],
  ownerPhone: string,
  from: string,
  businessName: string
): Promise<void> {
  const bullets = summary.length > 0 ? summary.map((s) => `• ${s}`).join("\n") : "• No key points captured";
  await sendSms(ownerPhone, from, `${businessName} — call summary\nCaller: ${callerPhone}\n${bullets}`);
}
