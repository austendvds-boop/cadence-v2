import type { Client } from "./db";

export type DeactivationReason = "inactive" | "trial_expired";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function getDeactivationReason(client: Pick<Client, "active">, trialExpired: boolean): DeactivationReason | null {
  if (!client.active) return "inactive";
  if (trialExpired) return "trial_expired";
  return null;
}

export function renderTemporarilyUnavailableTwiml(businessName?: string | null): string {
  const prefix = businessName?.trim()
    ? `Thanks for calling ${businessName.trim()}. `
    : "Thanks for calling. ";

  const message = `${prefix}This line is temporarily unavailable right now. Please try again a little later.`;

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}
