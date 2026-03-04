import type { TenantBusinessHour, TenantFaq, TenantService } from "./tenant-config";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface TenantPromptInput {
  businessName: string;
  businessType: string;
  timezone: string;
  intakeMode: string;
  fallbackMode: string;
  businessProfile?: Record<string, unknown>;
  toolsConfig?: Record<string, unknown>;
  hours?: TenantBusinessHour[];
  services?: TenantService[];
  faqs?: TenantFaq[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",");
  return `{${body}}`;
}

function formatHours(hours: TenantBusinessHour[]): string[] {
  const sorted = [...hours].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  if (sorted.length === 0) return ["- No business hours configured."];

  return sorted.map((hour) => {
    const day = DAY_NAMES[hour.dayOfWeek] ?? `Day ${hour.dayOfWeek}`;
    if (!hour.isOpen) return `- ${day}: closed`;

    const open = hour.openTime ?? "unknown";
    const close = hour.closeTime ?? "unknown";
    return `- ${day}: ${open} to ${close}`;
  });
}

function formatServices(services: TenantService[]): string[] {
  const sorted = [...services].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.id !== b.id) return a.id - b.id;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) return ["- No services configured."];

  return sorted.map((service) => {
    const parts = [service.name];
    if (service.priceText) parts.push(`price: ${service.priceText}`);
    if (service.description) parts.push(service.description);
    if (!service.active) parts.push("status: inactive");
    return `- ${parts.join(" | ")}`;
  });
}

function formatFaqs(faqs: TenantFaq[]): string[] {
  const sorted = [...faqs].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.id !== b.id) return a.id - b.id;
    return a.question.localeCompare(b.question);
  });

  if (sorted.length === 0) return ["- No FAQs configured."];

  return sorted.map((faq) => {
    const status = faq.active ? "" : " (inactive)";
    return `- Q: ${faq.question}${status}\n  A: ${faq.answer}`;
  });
}

export function buildTenantSystemPrompt(input: TenantPromptInput): string {
  const businessProfile = stableStringify(input.businessProfile ?? {});
  const toolsConfig = stableStringify(input.toolsConfig ?? {});

  const lines = [
    `You are Cadence, the virtual receptionist for ${input.businessName}.`,
    "Use a professional, warm, concise phone voice. Keep responses short and actionable.",
    `Business type: ${input.businessType}.`,
    `Timezone: ${input.timezone}.`,
    `Intake mode: ${input.intakeMode}.`,
    `Fallback mode: ${input.fallbackMode}.`,
    "",
    "Business profile (JSON):",
    businessProfile,
    "",
    "Business hours:",
    ...formatHours(input.hours ?? []),
    "",
    "Services:",
    ...formatServices(input.services ?? []),
    "",
    "Frequently asked questions:",
    ...formatFaqs(input.faqs ?? []),
    "",
    "Tools configuration (JSON):",
    toolsConfig,
    "",
    "Hard rules:",
    "- Never invent details that are not present in this prompt.",
    "- If a caller asks for unknown info, offer to take a message or transfer.",
    "- End every response with a question or clear next step."
  ];

  return lines.join("\n");
}
