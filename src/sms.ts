function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

async function sendSms(to: string, body: string): Promise<void> {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const token = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_SMS_NUMBER");

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

export async function sendBookingLink(to: string): Promise<void> {
  await sendSms(to, "Here is the DVDS booking link: https://www.deervalleydrivingschool.com");
}

export async function sendCallSummary(callerPhone: string, summary: string[]): Promise<void> {
  const austen = requireEnv("AUSTEN_CELL_NUMBER");
  const bullets = summary.length > 0 ? summary.map((s) => `• ${s}`).join("\n") : "• No key points captured";
  await sendSms(austen, `Cadence call summary\nCaller: ${callerPhone}\n${bullets}`);
}
