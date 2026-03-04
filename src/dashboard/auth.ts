import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import nodemailer from "nodemailer";
import { pool } from "../db";

const router = express.Router();

const ADMIN_EMAIL = "aust@autom8everything.com";
const SESSION_COOKIE_NAME = "cadence_dashboard_session";
const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;
const DEFAULT_SESSION_TTL_HOURS = 24;

const GMAIL_CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_FILE ||
  "C:\\Users\\austen\\.openclaw\\credentials\\gmail-autom8.txt";

export interface DashboardSessionUser {
  userId: string;
  email: string;
  role: "client_admin" | "platform_admin";
  clientId: string | null;
}

export type DashboardAuthedRequest = express.Request & {
  dashboardUser?: DashboardSessionUser;
};

type DashboardUserRow = {
  id: string;
  client_id: string | null;
  email: string;
  role: "client_admin" | "platform_admin";
  active: boolean;
};

type MagicLinkLookupRow = {
  token_id: number;
  user_id: string;
  email: string;
  role: "client_admin" | "platform_admin";
  client_id: string | null;
  active: boolean;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

type SessionTokenPayload = {
  userId: string;
  email: string;
  role: "client_admin" | "platform_admin";
  clientId: string | null;
  exp: number;
};

type MailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

let cachedMailer: nodemailer.Transporter | null = null;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getMagicLinkTtlMinutes(): number {
  return parsePositiveInt(process.env.MAGIC_LINK_TTL_MINUTES, DEFAULT_MAGIC_LINK_TTL_MINUTES);
}

function getSessionTtlHours(): number {
  return parsePositiveInt(process.env.DASHBOARD_SESSION_TTL_HOURS, DEFAULT_SESSION_TTL_HOURS);
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getSigningSecret(): string {
  return process.env.MAGIC_LINK_SIGNING_SECRET || "cadence-dashboard-dev-secret-change-me";
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createRandomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader.split(";").reduce<Record<string, string>>((acc, part) => {
    const [rawName, ...rest] = part.trim().split("=");
    if (!rawName || rest.length === 0) return acc;

    const name = rawName.trim();
    const value = rest.join("=").trim();

    if (!name) return acc;

    acc[name] = decodeURIComponent(value);
    return acc;
  }, {});
}

function isProbablySecureRequest(req: express.Request): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwarded = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  if (typeof forwarded === "string" && forwarded.toLowerCase().includes("https")) {
    return true;
  }

  if (typeof req.protocol === "string" && req.protocol.toLowerCase() === "https") {
    return true;
  }

  return process.env.NODE_ENV === "production";
}

function getRequestIp(req: express.Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0]?.split(",")[0]?.trim();
    if (first) return first;
  }

  return req.ip || null;
}

function getDashboardBaseUrl(req: express.Request): string {
  const configured = process.env.DASHBOARD_BASE_URL || process.env.CADENCE_BASE_URL;
  if (configured && configured.trim()) {
    return configured.replace(/\/$/, "");
  }

  const protocol = isProbablySecureRequest(req) ? "https" : "http";
  const host = req.get("host") || "localhost:3000";
  return `${protocol}://${host}`;
}

function buildMagicLink(req: express.Request, token: string): string {
  const baseUrl = getDashboardBaseUrl(req);
  const redirect = encodeURIComponent("/dashboard");
  return `${baseUrl}/dashboard/auth/verify?token=${encodeURIComponent(token)}&redirect=${redirect}`;
}

function createSessionToken(user: DashboardSessionUser): string {
  const payload: SessionTokenPayload = {
    userId: user.userId,
    email: user.email,
    role: user.role,
    clientId: user.clientId,
    exp: nowEpochSeconds() + getSessionTtlHours() * 60 * 60
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", getSigningSecret())
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${signature}`;
}

function verifySessionToken(token: string): DashboardSessionUser | null {
  const [payloadB64, providedSignature] = token.split(".");
  if (!payloadB64 || !providedSignature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", getSigningSecret())
    .update(payloadB64)
    .digest("base64url");

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionTokenPayload;
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  if (!payload.userId || !payload.email || !payload.role || typeof payload.exp !== "number") return null;
  if (payload.exp <= nowEpochSeconds()) return null;

  return {
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
    clientId: payload.clientId ?? null
  };
}

function setSessionCookie(res: express.Response, req: express.Request, token: string): void {
  const maxAgeMs = getSessionTtlHours() * 60 * 60 * 1000;
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];

  if (isProbablySecureRequest(req)) {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function clearSessionCookie(res: express.Response, req: express.Request): void {
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (isProbablySecureRequest(req)) {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function extractSessionUser(req: express.Request): DashboardSessionUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token);
}

function parseGmailCredentialsFile(filePath: string): { email: string; appPassword: string } | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);

    let email = "";
    let appPassword = "";

    for (const line of lines) {
      const [rawKey, ...valueParts] = line.split(":");
      if (!rawKey || valueParts.length === 0) continue;

      const key = rawKey.trim().toLowerCase();
      const value = valueParts.join(":").trim();

      if (key === "email") email = value;
      if (key === "app_password") appPassword = value;
    }

    if (!email || !appPassword) return null;

    return {
      email,
      appPassword: appPassword.replace(/\s+/g, "")
    };
  } catch {
    return null;
  }
}

function resolveMailConfig(): MailConfig {
  const parsedFileCreds = parseGmailCredentialsFile(path.resolve(GMAIL_CREDENTIALS_PATH));

  const user = process.env.SMTP_USER || parsedFileCreds?.email || "";
  const pass = process.env.SMTP_PASS || parsedFileCreds?.appPassword || "";

  if (!user || !pass) {
    throw new Error("Missing SMTP_USER/SMTP_PASS and no valid Gmail credentials file found");
  }

  const port = parsePositiveInt(process.env.SMTP_PORT, 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;

  return {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure,
    user,
    pass,
    from: process.env.SMTP_FROM || `Cadence <${user}>`
  };
}

function getMailer(): nodemailer.Transporter {
  if (cachedMailer) return cachedMailer;

  const config = resolveMailConfig();
  cachedMailer = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  return cachedMailer;
}

async function sendMagicLinkEmail(email: string, link: string): Promise<void> {
  const config = resolveMailConfig();
  const mailer = getMailer();

  await mailer.sendMail({
    from: config.from,
    to: email,
    subject: "Your Cadence dashboard sign-in link",
    text: `Use this secure sign-in link to access your Cadence dashboard:\n\n${link}\n\nThis link expires in ${getMagicLinkTtlMinutes()} minutes and can only be used once.`,
    html: `<p>Use this secure sign-in link to access your Cadence dashboard:</p><p><a href="${link}">${link}</a></p><p>This link expires in ${getMagicLinkTtlMinutes()} minutes and can only be used once.</p>`
  });
}

async function findDashboardUserByEmail(email: string): Promise<DashboardUserRow | null> {
  const result = await pool.query<DashboardUserRow>(
    `SELECT id, client_id, email, role, active
     FROM dashboard_users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function createDashboardUser(email: string): Promise<DashboardUserRow | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const isAdmin = normalizedEmail === ADMIN_EMAIL;
  if (isAdmin) {
    const adminInsert = await pool.query<DashboardUserRow>(
      `INSERT INTO dashboard_users (client_id, email, role, active)
       VALUES (NULL, $1, 'platform_admin', true)
       ON CONFLICT (email)
       DO UPDATE SET role = 'platform_admin', active = true
       RETURNING id, client_id, email, role, active`,
      [normalizedEmail]
    );

    return adminInsert.rows[0] || null;
  }

  const clientLookup = await pool.query<{ id: string }>(
    `SELECT id
     FROM clients
     WHERE LOWER(owner_email) = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalizedEmail]
  );

  const clientId = clientLookup.rows[0]?.id;
  if (!clientId) {
    return null;
  }

  const clientInsert = await pool.query<DashboardUserRow>(
    `INSERT INTO dashboard_users (client_id, email, role, active)
     VALUES ($1, $2, 'client_admin', true)
     ON CONFLICT (email)
     DO UPDATE SET
       client_id = EXCLUDED.client_id,
       role = 'client_admin',
       active = true
     RETURNING id, client_id, email, role, active`,
    [clientId, normalizedEmail]
  );

  return clientInsert.rows[0] || null;
}

async function findOrCreateDashboardUser(email: string): Promise<DashboardUserRow | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const existing = await findDashboardUserByEmail(normalizedEmail);
  if (existing) {
    if (existing.email !== normalizedEmail) {
      const normalized = await pool.query<DashboardUserRow>(
        `UPDATE dashboard_users
         SET email = $2
         WHERE id = $1
         RETURNING id, client_id, email, role, active`,
        [existing.id, normalizedEmail]
      );

      return normalized.rows[0] || existing;
    }

    if (normalizedEmail === ADMIN_EMAIL && existing.role !== "platform_admin") {
      const promoted = await pool.query<DashboardUserRow>(
        `UPDATE dashboard_users
         SET role = 'platform_admin', active = true
         WHERE id = $1
         RETURNING id, client_id, email, role, active`,
        [existing.id]
      );

      return promoted.rows[0] || existing;
    }

    return existing;
  }

  return createDashboardUser(normalizedEmail);
}

function parseDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return new Date(0);
  return parsed;
}

function parseRedirectTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  return trimmed;
}

router.post("/request-link", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const user = await findOrCreateDashboardUser(email);
  if (!user || !user.active) {
    res.status(200).json({ ok: true });
    return;
  }

  const rawToken = createRandomToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + getMagicLinkTtlMinutes() * 60 * 1000).toISOString();

  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token_hash, expires_at, request_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, tokenHash, expiresAt, getRequestIp(req), req.headers["user-agent"] || null]
  );

  const magicLink = buildMagicLink(req, rawToken);
  const isAdminBypass = email === ADMIN_EMAIL;

  try {
    await sendMagicLinkEmail(email, magicLink);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[DASHBOARD_AUTH] failed to send magic link email", message);

    if (!isAdminBypass) {
      res.status(500).json({ error: "Failed to send magic link" });
      return;
    }
  }

  if (isAdminBypass) {
    res.status(200).json({
      ok: true,
      bypass: true,
      verify_url: magicLink
    });
    return;
  }

  res.status(200).json({ ok: true });
});

router.get("/verify", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const tokenHash = sha256Hex(token);

  const lookup = await pool.query<MagicLinkLookupRow>(
    `SELECT
      t.id AS token_id,
      t.user_id,
      t.expires_at,
      t.consumed_at,
      u.email,
      u.role,
      u.client_id,
      u.active
     FROM magic_link_tokens t
     JOIN dashboard_users u ON u.id = t.user_id
     WHERE t.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );

  const row = lookup.rows[0];
  if (!row) {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }

  const expiresAt = parseDate(row.expires_at);
  const consumedAt = row.consumed_at ? parseDate(row.consumed_at) : null;

  if (!row.active || consumedAt || expiresAt.getTime() <= Date.now()) {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }

  const consume = await pool.query(
    "UPDATE magic_link_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
    [row.token_id]
  );

  if (!consume.rowCount) {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }

  await pool.query("UPDATE dashboard_users SET last_login_at = now() WHERE id = $1", [row.user_id]);

  const sessionUser: DashboardSessionUser = {
    userId: row.user_id,
    email: normalizeEmail(row.email),
    role: row.role,
    clientId: row.client_id
  };

  const sessionToken = createSessionToken(sessionUser);
  setSessionCookie(res, req, sessionToken);

  const redirectTarget = parseRedirectTarget(req.query.redirect) || "/dashboard";

  if (req.query.redirect) {
    res.redirect(302, redirectTarget);
    return;
  }

  res.status(200).json({
    ok: true,
    user: {
      email: sessionUser.email,
      role: sessionUser.role,
      clientId: sessionUser.clientId
    },
    redirect: redirectTarget
  });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res, req);
  res.status(200).json({ ok: true });
});

export function getDashboardUserFromRequest(req: express.Request): DashboardSessionUser | null {
  return extractSessionUser(req);
}

export function isPlatformAdmin(user: DashboardSessionUser): boolean {
  return user.role === "platform_admin" || normalizeEmail(user.email) === ADMIN_EMAIL;
}

export function requireDashboardUser(
  req: DashboardAuthedRequest,
  res: express.Response,
  next: express.NextFunction
): void {
  const user = extractSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.dashboardUser = user;
  next();
}

export function requireDashboardAdmin(
  req: DashboardAuthedRequest,
  res: express.Response,
  next: express.NextFunction
): void {
  const user = extractSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!isPlatformAdmin(user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  req.dashboardUser = user;
  next();
}

export default router;
