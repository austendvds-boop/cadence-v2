import type { Client } from "./db";

export type DeactivationReason = "inactive" | "trial_expired" | "overage_disabled";

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

export async function isOverageDisabled(clientId: string): Promise<boolean> {
  const { pool } = await import("./db");
  const result = await pool.query<{ overage_disabled: boolean }>(
    `SELECT overage_disabled FROM usage_monthly
     WHERE client_id = $1 AND month_start = date_trunc('month', now())::date
     LIMIT 1`,
    [clientId]
  );
  return result.rows[0]?.overage_disabled === true;
}

export function renderOverageDisabledTwiml(businessName?: string | null): string {
  const prefix = businessName?.trim()
    ? `Thanks for calling ${businessName.trim()}. `
    : "Thanks for calling. ";

  const message = `${prefix}This line is temporarily paused. Please contact us to update your billing information. Goodbye.`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}
