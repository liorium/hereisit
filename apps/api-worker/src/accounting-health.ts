import { z } from "zod";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const reasonSchema = z.enum([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_SAMPLED",
  "ACCOUNTING_DELAY",
  "HISTORICAL_GAP",
  "SAFETY_CONFLICT",
]);
export type AccountingHealthReason = z.infer<typeof reasonSchema>;
const healthSchema = z
  .object({
    epoch: z.string().regex(/^[a-f0-9]{32}$/),
    status: z.enum(["unknown", "degraded", "healthy"]),
    reason: reasonSchema.nullable(),
    evaluatedAt: integer,
    pendingHourKey: integer.nullable(),
    unresolvedSinceHourKey: integer.nullable(),
  })
  .strict()
  .refine(
    (row) =>
      row.status !== "healthy" ||
      (row.reason === null && row.pendingHourKey === null && row.unresolvedSinceHourKey === null),
  );
export type AccountingHealth = z.infer<typeof healthSchema>;
export async function readAccountingHealth(db: D1Database): Promise<AccountingHealth> {
  return healthSchema.parse(
    await db
      .withSession("first-primary")
      .prepare(
        `SELECT epoch, status, reason, evaluated_at AS evaluatedAt, pending_hour_key AS pendingHourKey, unresolved_since_hour_key AS unresolvedSinceHourKey FROM accounting_health WHERE id=1`,
      )
      .first(),
  );
}
export async function recordAccountingHealth(
  db: D1Database,
  value: AccountingHealth,
): Promise<"updated" | "stale"> {
  const next = healthSchema.parse(value);
  const result = await db
    .withSession("first-primary")
    .prepare(`UPDATE accounting_health SET epoch=?, status=?, reason=?, evaluated_at=?, pending_hour_key=?, unresolved_since_hour_key=?
    WHERE id=1 AND evaluated_at < ? AND EXISTS (SELECT 1 FROM rollout_control WHERE id=1 AND cost_accounting_epoch=?)
    AND (epoch=? OR (? <> 'healthy' AND (unresolved_since_hour_key IS NULL OR (? IS NOT NULL AND ? <= unresolved_since_hour_key))))
    AND (reason IS NOT 'HISTORICAL_GAP' OR ? = 'HISTORICAL_GAP')`)
    .bind(
      next.epoch,
      next.status,
      next.reason,
      next.evaluatedAt,
      next.pendingHourKey,
      next.unresolvedSinceHourKey,
      next.evaluatedAt,
      next.epoch,
      next.epoch,
      next.status,
      next.unresolvedSinceHourKey,
      next.unresolvedSinceHourKey,
      next.reason,
    )
    .run();
  if (!result.success) throw new Error("Accounting health update failed.");
  return result.meta.changes === 1 ? "updated" : "stale";
}
export async function openSafetyCircuit(
  db: D1Database,
  now: number,
  reason: string,
): Promise<void> {
  integer.parse(now);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reason) || reason === "COST_ACCOUNTING_INCOMPLETE")
    throw new TypeError("Invalid safety reason.");
  const result = await db
    .withSession("first-primary")
    .prepare(`UPDATE rollout_control SET
    safety_generation=safety_generation + CASE WHEN circuit_open=0 OR reason='COST_ACCOUNTING_INCOMPLETE' THEN 1 ELSE 0 END,
    reason=CASE WHEN circuit_open=1 AND reason IS NOT 'COST_ACCOUNTING_INCOMPLETE' THEN reason ELSE ? END,
    circuit_open=1, opened_at=COALESCE(opened_at,?), last_evaluated_at=? WHERE id=1`)
    .bind(reason, now, now)
    .run();
  if (!result.success || result.meta.changes < 1) throw new Error("Safety circuit update failed.");
}
