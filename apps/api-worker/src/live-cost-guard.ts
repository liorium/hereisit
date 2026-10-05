import { z } from "zod";
import { openSafetyCircuit } from "./accounting-health";
import type { OperationalConfig } from "./env";

const HOUR = 3_600_000;
const MAX_INTEGER = 9_223_372_036_854_775_807n;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const epochSchema = z.string().regex(/^[0-9a-f]{32}$/);
const hourSchema = z
  .object({
    hourKey: integer,
    epoch: epochSchema,
    releaseReportSha256: hash,
    liveCostModelSha256: hash,
    complete: z.boolean(),
    totalCostMicrousd: z.string(),
    admittedJobs: z.string(),
  })
  .strict();
export type LiveCostHour = z.infer<typeof hourSchema>;
export type LiveCostDecision =
  | { kind: "unavailable" }
  | {
      kind: "within-limit" | "breach";
      endHourKey: number;
      costPer1000Microusd: string | null;
      projectedMonthlyCostMicrousd: string;
    };
function checked(value: bigint): bigint {
  if (value < 0n || value > MAX_INTEGER) throw new RangeError("Cost accounting integer overflow.");
  return value;
}
function parseInteger(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("Invalid cost accounting integer.");
  return checked(BigInt(value));
}
export function evaluateLiveCostWindow(input: {
  now: number;
  epoch: string;
  releaseReportSha256: string;
  liveCostModelSha256: string;
  maximumLiveCostPer1000Microusd: number;
  maximumProjectedMonthlyCostMicrousd: number;
  rows: readonly LiveCostHour[];
}): LiveCostDecision {
  integer.parse(input.now);
  epochSchema.parse(input.epoch);
  hash.parse(input.releaseReportSha256);
  hash.parse(input.liveCostModelSha256);
  integer.parse(input.maximumLiveCostPer1000Microusd);
  integer.parse(input.maximumProjectedMonthlyCostMicrousd);
  const rows = input.rows.map((row) => hourSchema.parse(row)).sort((a, b) => a.hourKey - b.hourKey);
  let cost = 0n;
  let jobs = 0n;
  for (const row of rows) {
    cost = checked(cost + parseInteger(row.totalCostMicrousd));
    jobs = checked(jobs + parseInteger(row.admittedJobs));
  }
  const end = rows.at(-1)?.hourKey;
  if (
    rows.length !== 24 ||
    end === undefined ||
    !Number.isSafeInteger((end + 1) * HOUR) ||
    (end + 1) * HOUR >= input.now ||
    input.now - (end + 1) * HOUR > 2 * HOUR ||
    rows.some(
      (row, i) =>
        row.hourKey !== end - 23 + i ||
        !row.complete ||
        row.epoch !== input.epoch ||
        row.releaseReportSha256 !== input.releaseReportSha256 ||
        row.liveCostModelSha256 !== input.liveCostModelSha256,
    )
  )
    return { kind: "unavailable" };
  const monthly = checked(cost * 30n);
  const per1000 = jobs === 0n ? null : checked((cost * 1000n + jobs - 1n) / jobs);
  return {
    kind:
      monthly > BigInt(input.maximumProjectedMonthlyCostMicrousd) ||
      (per1000 !== null && per1000 > BigInt(input.maximumLiveCostPer1000Microusd))
        ? "breach"
        : "within-limit",
    endHourKey: end,
    costPer1000Microusd: per1000?.toString() ?? null,
    projectedMonthlyCostMicrousd: monthly.toString(),
  };
}
export async function applyLiveCostGuard(
  db: D1Database,
  config: OperationalConfig,
  now: number,
): Promise<LiveCostDecision> {
  const session = db.withSession("first-primary");
  try {
    const control = z
      .object({ epoch: epochSchema, end: integer.nullable() })
      .strict()
      .parse(
        await session
          .prepare(
            "SELECT cost_accounting_epoch AS epoch, last_sealed_hour_key AS end FROM rollout_control WHERE id = 1",
          )
          .first(),
      );
    if (control.end === null) return { kind: "unavailable" };
    const result = await session
      .prepare(`SELECT hour_key AS hourKey, accounting_epoch AS epoch,
      release_report_sha256 AS releaseReportSha256, live_cost_model_sha256 AS liveCostModelSha256,
      complete, CAST(total_cost_microusd AS TEXT) AS totalCostMicrousd,
      CAST(admitted_jobs AS TEXT) AS admittedJobs FROM operational_cost_hourly
      WHERE accounting_epoch = ? AND hour_key BETWEEN ? AND ? ORDER BY hour_key`)
      .bind(control.epoch, Math.max(0, control.end - 23), control.end)
      .all();
    const rows = result.results.map((row) =>
      hourSchema.parse({
        ...row,
        complete: z.union([z.literal(0), z.literal(1)]).parse(row.complete) === 1,
      }),
    );
    const decision = evaluateLiveCostWindow({ ...config, now, epoch: control.epoch, rows });
    if (decision.kind === "unavailable") return decision;
    const breach = decision.kind === "breach" ? 1 : 0;
    const applied = await session
      .prepare(`UPDATE rollout_control SET
      last_cost_per_1000_microusd = CAST(? AS INTEGER),
      last_projected_monthly_cost_microusd = CAST(? AS INTEGER),
      last_cost_evaluated_hour_key = ?, last_cost_window_complete = 1, last_evaluated_at = ?,
      cost_breach_count = CASE WHEN ? = 1 THEN cost_breach_count + 1 ELSE 0 END,
      cost_breach_window_started_at = CASE WHEN ? = 1 THEN COALESCE(cost_breach_window_started_at, ?) ELSE NULL END,
      safety_generation = safety_generation + CASE WHEN ? = 1 AND (circuit_open = 0 OR reason = 'COST_ACCOUNTING_INCOMPLETE') THEN 1 ELSE 0 END,
      reason = CASE WHEN ? = 1 AND (circuit_open = 0 OR reason = 'COST_ACCOUNTING_INCOMPLETE') THEN 'LIVE_COST_LIMIT_EXCEEDED' ELSE reason END,
      opened_at = CASE WHEN ? = 1 AND circuit_open = 0 THEN ? ELSE opened_at END,
      circuit_open = CASE WHEN ? = 1 THEN 1 ELSE circuit_open END
      WHERE id = 1 AND cost_accounting_epoch = ? AND last_sealed_hour_key = ?
        AND (last_cost_evaluated_hour_key IS NULL OR last_cost_evaluated_hour_key < ?)
        AND EXISTS (SELECT 1 FROM worker_version_attestations WHERE kind = 'active' AND release_report_sha256 = ?)
        AND (SELECT COUNT(*) FROM operational_cost_hourly WHERE accounting_epoch = ? AND hour_key BETWEEN ? AND ?
          AND complete = 1 AND release_report_sha256 = ? AND live_cost_model_sha256 = ?) = 24`)
      .bind(
        decision.costPer1000Microusd,
        decision.projectedMonthlyCostMicrousd,
        decision.endHourKey,
        now,
        breach,
        breach,
        now,
        breach,
        breach,
        breach,
        now,
        breach,
        control.epoch,
        control.end,
        decision.endHourKey,
        config.releaseReportSha256,
        control.epoch,
        decision.endHourKey - 23,
        decision.endHourKey,
        config.releaseReportSha256,
        config.liveCostModelSha256,
      )
      .run();
    // An already applied window remains valid; a changed epoch/release does not.
    if (applied.meta.changes === 0) {
      const current = await session
        .prepare(`SELECT 1 AS valid FROM rollout_control WHERE id = 1 AND cost_accounting_epoch = ?
        AND last_cost_evaluated_hour_key = ? AND EXISTS (SELECT 1 FROM worker_version_attestations WHERE kind = 'active' AND release_report_sha256 = ?)`)
        .bind(control.epoch, decision.endHourKey, config.releaseReportSha256)
        .first();
      if (current === null) return { kind: "unavailable" };
    }
    return decision;
  } catch (error) {
    await openSafetyCircuit(db, now, "ACCOUNTING_STATE_INVALID");
    throw error;
  }
}
