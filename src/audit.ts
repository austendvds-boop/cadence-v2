import { pool } from "./db";

export async function writeAuditLog(
  entityType: "client" | "onboarding_session" | "subscription",
  entityId: string,
  action: string,
  details?: Record<string, unknown>
): Promise<void> {
  await pool.query(
    "INSERT INTO audit_log (entity_type, entity_id, action, details) VALUES ($1, $2, $3, $4)",
    [entityType, entityId, action, details ? JSON.stringify(details) : null]
  );
}
