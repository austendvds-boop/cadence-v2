import readline from "readline";
import pg from "pg";
import { generateSystemPrompt, PromptParams } from "../src/prompt-template";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

async function purchaseTwilioNumber(areaCode: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const searchUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&SmsEnabled=true&Limit=1`;
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!searchRes.ok) throw new Error(`Twilio search failed: ${searchRes.status}`);
  const searchData = (await searchRes.json()) as { available_phone_numbers: Array<{ phone_number: string }> };
  if (!searchData.available_phone_numbers.length) throw new Error(`No numbers available in area code ${areaCode}`);

  const number = searchData.available_phone_numbers[0].phone_number;
  const buyUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`;
  const buyRes = await fetch(buyUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ PhoneNumber: number }).toString()
  });
  if (!buyRes.ok) throw new Error(`Twilio purchase failed: ${buyRes.status}`);

  const buyData = (await buyRes.json()) as { sid: string };
  const baseUrl = process.env.CADENCE_BASE_URL;
  if (baseUrl) {
    const configUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${buyData.sid}.json`;
    await fetch(configUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ VoiceUrl: `${baseUrl}/incoming-call`, VoiceMethod: "POST" }).toString()
    });
  }

  return number;
}

async function main(): Promise<void> {
  console.log("\nCadence — Add New Client\n");

  const businessName = await ask("Business name: ");
  const businessDescription = await ask("Business description (one line): ");
  const phoneNumber = await ask("Business phone number (for AI to reference): ");
  const website = await ask("Website URL: ");
  const hours = await ask("Hours of operation: ");
  const services = await ask("Services (paragraph): ");
  const faqs = await ask("FAQs (paragraph): ");
  const bookingInstructions = await ask("Booking instructions: ");
  const transferNumber = (await ask("Transfer number (E.164, or blank to skip): ")).trim() || null;
  const smsBookingUrl = (await ask("Booking URL for SMS (or blank): ")).trim() || null;
  const greeting = await ask("Greeting message: ");
  const ownerPhone = (await ask("Owner phone for summaries (E.164, or blank): ")).trim() || null;
  const areaCode = await ask("Area code for new Twilio number: ");
  const plan = (await ask("Plan (trial/starter/growth) [trial]: ")).trim() || "trial";
  const trialDays = plan === "trial" ? Number((await ask("Trial length in days [14]: ")).trim() || "14") : 0;

  rl.close();

  const promptParams: PromptParams = {
    businessName,
    businessDescription,
    phoneNumber,
    website,
    hours,
    services,
    faqs,
    bookingInstructions,
    transferNumber,
    smsBookingUrl
  };
  const systemPrompt = generateSystemPrompt(promptParams);

  const twilioNumber = await purchaseTwilioNumber(areaCode);

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const result = await pool.query(
    `INSERT INTO clients (
      business_name, phone_number, system_prompt, transfer_number,
      greeting, sms_enabled, booking_url, owner_phone,
      plan, trial_ends_at, active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`,
    [
      businessName,
      twilioNumber,
      systemPrompt,
      transferNumber,
      greeting,
      Boolean(smsBookingUrl),
      smsBookingUrl,
      ownerPhone,
      plan,
      trialEndsAt,
      true
    ]
  );

  console.log("\nClient provisioned successfully");
  console.log(`Client ID: ${result.rows[0].id}`);
  console.log(`Phone Number: ${twilioNumber}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
