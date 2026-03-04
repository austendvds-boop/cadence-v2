import { pool } from "./db";

const TENANT_CONFIG_CACHE_TTL_MS = 30_000;

export interface TenantBusinessHour {
  dayOfWeek: number;
  isOpen: boolean;
  openTime: string | null;
  closeTime: string | null;
}

export interface TenantService {
  id: number;
  name: string;
  description: string | null;
  priceText: string | null;
  active: boolean;
  sortOrder: number;
}

export interface TenantFaq {
  id: number;
  question: string;
  answer: string;
  active: boolean;
  sortOrder: number;
}

export interface TenantRuntimeConfig {
  clientId: string;
  businessName: string;
  businessType: string;
  timezone: string;
  twilioNumber: string;
  smsNumber: string | null;
  intakeMode: string;
  fallbackMode: string;
  greeting: string;
  systemPrompt: string;
  transferNumber: string | null;
  smsEnabled: boolean;
  bookingUrl: string | null;
  ownerPhone: string | null;
  toolsConfig: Record<string, unknown>;
  businessProfile: Record<string, unknown>;
  hours: TenantBusinessHour[];
  services: TenantService[];
  faqs: TenantFaq[];
}

type TenantRuntimeConfigRow = {
  id: string;
  business_name: string;
  business_type: string | null;
  timezone: string | null;
  phone_number: string | null;
  sms_number: string | null;
  intake_mode: string | null;
  fallback_mode: string | null;
  greeting: string | null;
  system_prompt: string | null;
  transfer_number: string | null;
  sms_enabled: boolean;
  booking_url: string | null;
  owner_phone: string | null;
  tools_config: unknown;
  business_profile: unknown;
  hours: unknown;
  services: unknown;
  faqs: unknown;
};

type TenantRuntimeCacheEntry = {
  value: TenantRuntimeConfig;
  expiresAt: number;
};

const tenantRuntimeConfigCache = new Map<string, TenantRuntimeCacheEntry>();

const TENANT_RUNTIME_CONFIG_QUERY = `
  SELECT
    c.id,
    c.business_name,
    c.business_type,
    c.timezone,
    c.phone_number,
    c.sms_number,
    c.intake_mode,
    c.fallback_mode,
    c.greeting,
    c.system_prompt,
    c.transfer_number,
    c.sms_enabled,
    c.booking_url,
    c.owner_phone,
    COALESCE(c.tools_config, '{}'::jsonb) AS tools_config,
    COALESCE(c.business_profile, '{}'::jsonb) AS business_profile,
    COALESCE(h.hours, '[]'::jsonb) AS hours,
    COALESCE(s.services, '[]'::jsonb) AS services,
    COALESCE(f.faqs, '[]'::jsonb) AS faqs
  FROM clients c
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'day_of_week', day_of_week,
        'is_open', is_open,
        'open_time', to_char(open_time, 'HH24:MI:SS'),
        'close_time', to_char(close_time, 'HH24:MI:SS')
      )
      ORDER BY day_of_week
    ) AS hours
    FROM client_hours
    WHERE client_id = c.id
  ) h ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', id,
        'name', name,
        'description', description,
        'price_text', price_text,
        'active', active,
        'sort_order', sort_order
      )
      ORDER BY sort_order, id
    ) AS services
    FROM client_services
    WHERE client_id = c.id
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', id,
        'question', question,
        'answer', answer,
        'active', active,
        'sort_order', sort_order
      )
      ORDER BY sort_order, id
    ) AS faqs
    FROM client_faqs
    WHERE client_id = c.id
  ) f ON true
  WHERE c.id = $1
  LIMIT 1
`;

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function toInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeHours(value: unknown): TenantBusinessHour[] {
  return asArray(value)
    .map((raw): TenantBusinessHour | null => {
      const row = asObject(raw);
      const dayOfWeek = toInteger(row.day_of_week, -1);
      if (dayOfWeek < 0 || dayOfWeek > 6) return null;

      return {
        dayOfWeek,
        isOpen: toBoolean(row.is_open, false),
        openTime: toOptionalString(row.open_time),
        closeTime: toOptionalString(row.close_time)
      };
    })
    .filter((row): row is TenantBusinessHour => row !== null)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

function normalizeServices(value: unknown): TenantService[] {
  return asArray(value)
    .map((raw): TenantService | null => {
      const row = asObject(raw);
      const name = toOptionalString(row.name);
      if (!name) return null;

      return {
        id: toInteger(row.id, 0),
        name,
        description: toOptionalString(row.description),
        priceText: toOptionalString(row.price_text),
        active: toBoolean(row.active, true),
        sortOrder: toInteger(row.sort_order, 0)
      };
    })
    .filter((row): row is TenantService => row !== null)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.id !== b.id) return a.id - b.id;
      return a.name.localeCompare(b.name);
    });
}

function normalizeFaqs(value: unknown): TenantFaq[] {
  return asArray(value)
    .map((raw): TenantFaq | null => {
      const row = asObject(raw);
      const question = toOptionalString(row.question);
      const answer = toOptionalString(row.answer);
      if (!question || !answer) return null;

      return {
        id: toInteger(row.id, 0),
        question,
        answer,
        active: toBoolean(row.active, true),
        sortOrder: toInteger(row.sort_order, 0)
      };
    })
    .filter((row): row is TenantFaq => row !== null)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.id !== b.id) return a.id - b.id;
      return a.question.localeCompare(b.question);
    });
}

function hydrateTenantRuntimeConfig(row: TenantRuntimeConfigRow): TenantRuntimeConfig {
  const twilioNumber = toOptionalString(row.phone_number) ?? "";
  const smsNumber = toOptionalString(row.sms_number) ?? (twilioNumber || null);

  return {
    clientId: row.id,
    businessName: row.business_name,
    businessType: toOptionalString(row.business_type) ?? "general",
    timezone: toOptionalString(row.timezone) ?? "America/Phoenix",
    twilioNumber,
    smsNumber,
    intakeMode: toOptionalString(row.intake_mode) ?? "phone",
    fallbackMode: toOptionalString(row.fallback_mode) ?? "take_message",
    greeting: toOptionalString(row.greeting) ?? "Thanks for calling. How can I help you today?",
    systemPrompt: toOptionalString(row.system_prompt) ?? "",
    transferNumber: toOptionalString(row.transfer_number),
    smsEnabled: row.sms_enabled,
    bookingUrl: toOptionalString(row.booking_url),
    ownerPhone: toOptionalString(row.owner_phone),
    toolsConfig: asObject(row.tools_config),
    businessProfile: asObject(row.business_profile),
    hours: normalizeHours(row.hours),
    services: normalizeServices(row.services),
    faqs: normalizeFaqs(row.faqs)
  };
}

export async function getTenantRuntimeConfig(clientId: string): Promise<TenantRuntimeConfig | null> {
  const normalizedClientId = clientId.trim();
  if (!normalizedClientId) return null;

  const now = Date.now();
  const cached = tenantRuntimeConfigCache.get(normalizedClientId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached) {
    tenantRuntimeConfigCache.delete(normalizedClientId);
  }

  const result = await pool.query<TenantRuntimeConfigRow>(TENANT_RUNTIME_CONFIG_QUERY, [normalizedClientId]);
  const row = result.rows[0];
  if (!row) return null;

  const config = hydrateTenantRuntimeConfig(row);
  tenantRuntimeConfigCache.set(normalizedClientId, {
    value: config,
    expiresAt: now + TENANT_CONFIG_CACHE_TTL_MS
  });

  return config;
}

export function clearTenantRuntimeConfigCache(clientId?: string): void {
  if (clientId) {
    tenantRuntimeConfigCache.delete(clientId.trim());
    return;
  }

  tenantRuntimeConfigCache.clear();
}
