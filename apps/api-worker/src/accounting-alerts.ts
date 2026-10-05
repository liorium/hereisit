import { z } from "zod";
import type { AccountingHealth } from "./accounting-health";

const TICK = 5 * 60_000;
const DAY = 24 * 60 * 60_000;
const environmentSchema = z.enum(["local", "staging", "production"]);
const reasonSchema = z.enum([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_SAMPLED",
  "ACCOUNTING_DELAY",
  "HISTORICAL_GAP",
  "SAFETY_CONFLICT",
]);
type Message = { subject: string; text: string };
export function formatAccountingAlert(
  health: AccountingHealth,
  environment: "local" | "staging" | "production",
): Message {
  environmentSchema.parse(environment);
  const status = z.enum(["degraded", "healthy"]).parse(health.status);
  const reason = health.reason === null ? "NONE" : reasonSchema.parse(health.reason);
  const hour = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .parse(health.unresolvedSinceHourKey ?? health.pendingHourKey);
  return {
    subject: `HereIsIt ${environment} accounting ${status === "healthy" ? "recovered" : "degraded"}`,
    text: `Environment: ${environment}\nReason: ${reason}\nFirst unresolved hour: ${hour ?? "none"}\nInspect: processing preflight accounting status\n`,
  };
}
export function createAccountingEmailSender(input: {
  binding?: SendEmail | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): ((message: Message) => Promise<void>) | null {
  const address = z
    .email()
    .max(254)
    .regex(/^[\x21-\x7e]+$/);
  if (
    !input.binding ||
    !address.safeParse(input.from).success ||
    !address.safeParse(input.to).success
  )
    return null;
  const { binding } = input;
  const from = address.parse(input.from);
  const to = address.parse(input.to);
  return async (message) => {
    if (
      !/^HereIsIt (local|staging|production) accounting (degraded|recovered)$/.test(message.subject)
    )
      throw new TypeError("Invalid accounting email subject.");
    const { EmailMessage } = await import("cloudflare:email");
    const bytes = new TextEncoder().encode(message.text);
    const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    const body = encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
    await binding.send(
      new EmailMessage(
        from,
        to,
        `From: ${from}\r\nTo: ${to}\r\nSubject: ${message.subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`,
      ),
    );
  };
}

export async function sendAccountingAlert(input: {
  db: D1Database;
  health: AccountingHealth;
  now: number;
  environment: "local" | "staging" | "production";
  send: (message: Message) => Promise<void>;
}): Promise<"sent" | "not-due" | "failed"> {
  // Alert failure is deliberately isolated from safety and job admission.
  try {
    const { health, now } = input;
    z.number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - TICK)
      .parse(now);
    if (
      health.status === "unknown" ||
      health.evaluatedAt > now ||
      health.evaluatedAt < now - 15 * 60_000
    )
      return "not-due";
    if (health.status === "healthy" && health.unresolvedSinceHourKey !== null) return "not-due";
    const message = formatAccountingAlert(health, input.environment);
    const session = input.db.withSession("first-primary");
    const snapshot = `EXISTS (SELECT 1 FROM accounting_health AS h JOIN rollout_control AS c ON c.id = h.id
      WHERE h.id = 1 AND h.epoch = ? AND h.status = ? AND h.evaluated_at = ? AND c.cost_accounting_epoch = h.epoch)`;
    const args = [health.epoch, health.status, health.evaluatedAt];
    if (health.status === "degraded") {
      await session.batch([
        session
          .prepare(`INSERT INTO operational_alert_state (kind,active,event_key,next_attempt_at)
          SELECT 'accounting-degraded',1,?,0 WHERE ${snapshot}
          ON CONFLICT(kind) DO UPDATE SET active = 1,event_key = excluded.event_key,
            last_sent_at = NULL,recovered_at = NULL,lease_token = NULL,lease_expires_at = NULL,next_attempt_at = 0
          WHERE operational_alert_state.active = 0`)
          .bind(`${health.epoch}:${health.evaluatedAt}`, ...args),
        session
          .prepare(`UPDATE operational_alert_state SET active = 0,lease_token = NULL,lease_expires_at = NULL
          WHERE kind = 'accounting-recovered' AND ${snapshot}`)
          .bind(...args),
      ]);
    } else {
      await session.batch([
        session
          .prepare(`INSERT INTO operational_alert_state (kind,active,event_key,next_attempt_at)
          SELECT 'accounting-recovered',1,event_key,0 FROM operational_alert_state
          WHERE kind = 'accounting-degraded' AND active = 1 AND ${snapshot}
          ON CONFLICT(kind) DO UPDATE SET active = 1,event_key = excluded.event_key,
            last_sent_at = NULL,recovered_at = NULL,lease_token = NULL,lease_expires_at = NULL,next_attempt_at = 0
          WHERE operational_alert_state.event_key IS NOT excluded.event_key`)
          .bind(...args),
        session
          .prepare(`UPDATE operational_alert_state SET active = 0,recovered_at = ?,lease_token = NULL,lease_expires_at = NULL
          WHERE kind = 'accounting-degraded' AND active = 1 AND ${snapshot}`)
          .bind(now, ...args),
      ]);
    }
    const kind = health.status === "degraded" ? "accounting-degraded" : "accounting-recovered";
    const token = crypto.randomUUID();
    const claim = await session
      .prepare(`UPDATE operational_alert_state SET lease_token = ?,lease_expires_at = ?,next_attempt_at = ?
      WHERE kind = ? AND active = 1 AND next_attempt_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND (last_sent_at IS NULL OR (? = 'accounting-degraded' AND last_sent_at <= ?)) AND ${snapshot}
      RETURNING event_key`)
      .bind(token, now + TICK, now + TICK, kind, now, now, kind, now - DAY, ...args)
      .first<{ event_key: string }>();
    if (claim === null) return "not-due";
    try {
      await input.send(message);
    } catch {
      return "failed";
    }
    const finalized = await session
      .prepare(`UPDATE operational_alert_state SET last_sent_at = ?,lease_token = NULL,lease_expires_at = NULL,
      active = CASE WHEN kind = 'accounting-recovered' THEN 0 ELSE active END
      WHERE kind = ? AND active = 1 AND event_key = ? AND lease_token = ?
        AND EXISTS (SELECT 1 FROM accounting_health AS h JOIN rollout_control AS c ON c.id = h.id
          WHERE h.id = 1 AND h.epoch = ? AND h.status = ? AND c.cost_accounting_epoch = h.epoch)`)
      .bind(now, kind, claim.event_key, token, health.epoch, health.status)
      .run();
    return finalized.meta.changes === 1 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
