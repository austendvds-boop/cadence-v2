type PurchasedTwilioNumber = {
  phoneNumber: string;
  sid: string;
  usedAreaCode: string | null;
};

const AREA_CODE_FALLBACKS: Record<string, string[]> = {
  "602": ["480", "623", "520"],
  "480": ["602", "623", "520"],
  "623": ["602", "480", "520"],
  "520": ["602", "480", "623"],
  "818": ["213", "310", "323"]
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function twilioAuthHeader(): string {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const token = requireEnv("TWILIO_AUTH_TOKEN");
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

async function findNumberForAreaCode(areaCode: string): Promise<string | null> {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&SmsEnabled=true&Limit=1`;

  const response = await fetch(url, { headers: { Authorization: twilioAuthHeader() } });
  if (!response.ok) throw new Error(`Twilio number search failed ${response.status}`);

  const data = (await response.json()) as { available_phone_numbers?: Array<{ phone_number: string }> };
  return data.available_phone_numbers?.[0]?.phone_number || null;
}

async function findAnyUsNumber(): Promise<string | null> {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&SmsEnabled=true&Limit=1`;
  const response = await fetch(url, { headers: { Authorization: twilioAuthHeader() } });
  if (!response.ok) throw new Error(`Twilio fallback search failed ${response.status}`);

  const data = (await response.json()) as { available_phone_numbers?: Array<{ phone_number: string }> };
  return data.available_phone_numbers?.[0]?.phone_number || null;
}

export async function purchaseAndConfigureTwilioNumber(
  preferredAreaCode: string,
  businessName: string
): Promise<PurchasedTwilioNumber> {
  const areaCodes = [preferredAreaCode, ...(AREA_CODE_FALLBACKS[preferredAreaCode] || [])];

  let selectedNumber: string | null = null;
  let usedAreaCode: string | null = null;

  for (const areaCode of areaCodes) {
    const found = await findNumberForAreaCode(areaCode);
    if (found) {
      selectedNumber = found;
      usedAreaCode = areaCode;
      break;
    }
  }

  if (!selectedNumber) {
    selectedNumber = await findAnyUsNumber();
  }

  if (!selectedNumber) {
    throw new Error("no_numbers_available");
  }

  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const buyUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`;

  const buyResponse = await fetch(buyUrl, {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ PhoneNumber: selectedNumber }).toString()
  });

  if (!buyResponse.ok) {
    const text = await buyResponse.text();
    throw new Error(`Twilio purchase failed ${buyResponse.status}: ${text}`);
  }

  const buyData = (await buyResponse.json()) as { sid: string; phone_number: string };
  const cadenceBaseUrl = requireEnv("CADENCE_BASE_URL").replace(/\/$/, "");

  const configResponse = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${buyData.sid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        VoiceUrl: `${cadenceBaseUrl}/incoming-call`,
        VoiceMethod: "POST",
        FriendlyName: `Cadence - ${businessName}`
      }).toString()
    }
  );

  if (!configResponse.ok) {
    const text = await configResponse.text();
    throw new Error(`Twilio number configure failed ${configResponse.status}: ${text}`);
  }

  return {
    phoneNumber: buyData.phone_number || selectedNumber,
    sid: buyData.sid,
    usedAreaCode
  };
}
