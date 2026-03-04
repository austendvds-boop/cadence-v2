import { pool } from "../src/db";
import { SYSTEM_PROMPT } from "../src/system-prompt";

type DvdsClientRow = {
  id: string;
  business_name: string;
  phone_number: string;
  system_prompt: string | null;
  transfer_number: string | null;
  greeting: string | null;
  sms_enabled: boolean;
  booking_url: string | null;
  owner_phone: string | null;
  business_type: string | null;
  timezone: string | null;
  sms_number: string | null;
  intake_mode: string | null;
  fallback_mode: string | null;
  tools_config: unknown;
  business_profile: unknown;
};

type HourSeed = {
  dayOfWeek: number;
  isOpen: boolean;
  openTime: string | null;
  closeTime: string | null;
};

type ServiceSeed = {
  name: string;
  description: string;
  priceText: string | null;
  sortOrder: number;
};

type FaqSeed = {
  question: string;
  answer: string;
  sortOrder: number;
};

const DVDS_PHONE_NUMBER = "+19284477047";

// Source: existing DVDS voice script + existing client row in `clients`.
const DVDS_HOURS: HourSeed[] = [
  { dayOfWeek: 0, isOpen: false, openTime: null, closeTime: null },
  { dayOfWeek: 1, isOpen: true, openTime: "08:00:00", closeTime: "18:00:00" },
  { dayOfWeek: 2, isOpen: true, openTime: "08:00:00", closeTime: "18:00:00" },
  { dayOfWeek: 3, isOpen: true, openTime: "08:00:00", closeTime: "18:00:00" },
  { dayOfWeek: 4, isOpen: true, openTime: "08:00:00", closeTime: "18:00:00" },
  { dayOfWeek: 5, isOpen: true, openTime: "08:00:00", closeTime: "18:00:00" },
  { dayOfWeek: 6, isOpen: true, openTime: "09:00:00", closeTime: "15:00:00" }
];

const DVDS_SERVICES: ServiceSeed[] = [
  {
    name: "License-Ready Package",
    description: "Most popular. Four lessons (10 total hours) with road test waiver eligibility.",
    priceText: "$680",
    sortOrder: 10
  },
  {
    name: "Ultimate Package",
    description: "Eight lessons (20 total hours). Can be shared by two siblings (10 hours each).",
    priceText: "$1,299",
    sortOrder: 20
  },
  {
    name: "Intro Package",
    description: "Two lessons (5 total hours).",
    priceText: "$350",
    sortOrder: 30
  },
  {
    name: "Express Package",
    description: "Early-bird option in limited regions. Two lessons (5 total hours).",
    priceText: "$200",
    sortOrder: 40
  }
];

const DVDS_FAQS: FaqSeed[] = [
  {
    question: "How old does a student need to be?",
    answer:
      "Students can book before they have a permit, but they must have the permit by lesson one. They must be at least 15.5 years old to start lessons.",
    sortOrder: 10
  },
  {
    question: "How do students book lessons?",
    answer:
      "Booking is done online at deervalleydrivingschool.com with live instructor availability, date selection, and payment at checkout.",
    sortOrder: 20
  },
  {
    question: "What payment methods are accepted?",
    answer:
      "Checkout supports card, Klarna, Afterpay, CashApp Pay, Amazon Pay, and Link. Klarna/Afterpay options appear automatically when eligible.",
    sortOrder: 30
  },
  {
    question: "What is the reschedule policy?",
    answer:
      "Rescheduling requires at least 48 hours notice. Changes under 48 hours have a $75 fee.",
    sortOrder: 40
  },
  {
    question: "Do lessons qualify for a road test waiver?",
    answer:
      "Completing an eligible package qualifies students for the Arizona road test waiver, which can skip the MVD driving test.",
    sortOrder: 50
  },
  {
    question: "Are Spanish-speaking instructors available?",
    answer: "Yes. Callers should call in to arrange a Spanish-speaking instructor.",
    sortOrder: 60
  }
];

const DVDS_DEFAULT_BUSINESS_PROFILE = {
  founded_year: 2011,
  service_area: "Greater Phoenix area",
  rating_summary: "5-star with 1,200+ reviews",
  website: "https://www.deervalleydrivingschool.com"
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

async function main(): Promise<void> {
  console.log("[migrate-dvds-config] starting");

  const clientResult = await pool.query<DvdsClientRow>(
    `
      SELECT
        id,
        business_name,
        phone_number,
        system_prompt,
        transfer_number,
        greeting,
        sms_enabled,
        booking_url,
        owner_phone,
        business_type,
        timezone,
        sms_number,
        intake_mode,
        fallback_mode,
        tools_config,
        business_profile
      FROM clients
      WHERE phone_number = $1
      LIMIT 1
    `,
    [DVDS_PHONE_NUMBER]
  );

  const client = clientResult.rows[0];
  if (!client) {
    throw new Error(`DVDS client not found for phone ${DVDS_PHONE_NUMBER}`);
  }

  const runtimePrompt = client.system_prompt?.trim() ? client.system_prompt : SYSTEM_PROMPT;
  const currentTools = asObject(client.tools_config);
  const currentBusinessProfile = asObject(client.business_profile);

  const mergedTools = {
    ...currentTools,
    send_sms_booking_link: true,
    transfer_to_human: Boolean(client.transfer_number)
  };

  const mergedBusinessProfile = {
    ...DVDS_DEFAULT_BUSINESS_PROFILE,
    ...currentBusinessProfile
  };

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    await dbClient.query(
      `
        UPDATE clients
        SET
          business_type = COALESCE(NULLIF(TRIM(business_type), ''), 'driving_school'),
          timezone = COALESCE(NULLIF(TRIM(timezone), ''), 'America/Phoenix'),
          sms_number = COALESCE(NULLIF(TRIM(sms_number), ''), phone_number),
          intake_mode = COALESCE(NULLIF(TRIM(intake_mode), ''), 'phone'),
          fallback_mode = COALESCE(NULLIF(TRIM(fallback_mode), ''), 'take_message'),
          greeting = COALESCE(NULLIF(TRIM(greeting), ''), 'Thanks for calling Deer Valley Driving School. How can I help you today?'),
          system_prompt = COALESCE(NULLIF(TRIM(system_prompt), ''), $2),
          tools_config = $3::jsonb,
          business_profile = $4::jsonb,
          updated_at = now()
        WHERE id = $1
      `,
      [client.id, runtimePrompt, JSON.stringify(mergedTools), JSON.stringify(mergedBusinessProfile)]
    );

    for (const hour of DVDS_HOURS) {
      await dbClient.query(
        `
          INSERT INTO client_hours (client_id, day_of_week, is_open, open_time, close_time)
          VALUES ($1, $2, $3, $4::time, $5::time)
          ON CONFLICT (client_id, day_of_week)
          DO UPDATE SET
            is_open = EXCLUDED.is_open,
            open_time = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time,
            updated_at = now()
        `,
        [client.id, hour.dayOfWeek, hour.isOpen, hour.openTime, hour.closeTime]
      );
    }

    await dbClient.query("DELETE FROM client_services WHERE client_id = $1", [client.id]);
    for (const service of DVDS_SERVICES) {
      await dbClient.query(
        `
          INSERT INTO client_services (client_id, name, description, price_text, active, sort_order)
          VALUES ($1, $2, $3, $4, true, $5)
        `,
        [client.id, service.name, service.description, service.priceText, service.sortOrder]
      );
    }

    await dbClient.query("DELETE FROM client_faqs WHERE client_id = $1", [client.id]);
    for (const faq of DVDS_FAQS) {
      await dbClient.query(
        `
          INSERT INTO client_faqs (client_id, question, answer, active, sort_order)
          VALUES ($1, $2, $3, true, $4)
        `,
        [client.id, faq.question, faq.answer, faq.sortOrder]
      );
    }

    const counts = await Promise.all([
      dbClient.query("SELECT count(*)::int AS count FROM client_hours WHERE client_id = $1", [client.id]),
      dbClient.query("SELECT count(*)::int AS count FROM client_services WHERE client_id = $1", [client.id]),
      dbClient.query("SELECT count(*)::int AS count FROM client_faqs WHERE client_id = $1", [client.id])
    ]);

    await dbClient.query("COMMIT");

    console.log("[migrate-dvds-config] success");
    console.log(`  clientId: ${client.id}`);
    console.log(`  businessName: ${client.business_name}`);
    console.log(`  phoneNumber: ${client.phone_number}`);
    console.log(`  hoursRows: ${counts[0].rows[0].count}`);
    console.log(`  serviceRows: ${counts[1].rows[0].count}`);
    console.log(`  faqRows: ${counts[2].rows[0].count}`);
  } catch (error) {
    await dbClient.query("ROLLBACK");
    throw error;
  } finally {
    dbClient.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[migrate-dvds-config] failed", error);
  process.exit(1);
});
