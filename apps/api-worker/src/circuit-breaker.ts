import { z } from "zod";

const VERIFICATION_WINDOW_MILLISECONDS = 15 * 60_000;

const circuitSnapshotSchema = z
  .object({
    circuit_open: z.union([z.literal(0), z.literal(1)]),
    reason: z.string().min(1).max(64).nullable(),
    opened_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    last_evaluated_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export interface EvaluateCircuitBreakerInput {
  readonly now: number;
  readonly maximumQueuedAgeSeconds: number;
}

export interface CircuitBreakerState {
  readonly open: boolean;
  readonly reason: string | null;
  readonly openedAt: number | null;
  readonly evaluatedAt: number;
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function checkedMilliseconds(seconds: number): number {
  nonnegativeSafeInteger(seconds, "maximumQueuedAgeSeconds");
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError("Maximum queued age in milliseconds must be a safe integer.");
  }
  return milliseconds;
}

export async function evaluateCircuitBreaker(
  database: D1Database,
  input: EvaluateCircuitBreakerInput,
): Promise<CircuitBreakerState> {
  const now = nonnegativeSafeInteger(input.now, "now");
  const maximumQueuedAgeMilliseconds = checkedMilliseconds(input.maximumQueuedAgeSeconds);
  const verificationWindowStartedAt = Math.max(0, now - VERIFICATION_WINDOW_MILLISECONDS);
  const oldestAllowedQueuedAt = Math.max(0, now - maximumQueuedAgeMilliseconds);
  const session = database.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `WITH hard_signal AS (
           SELECT CASE
             WHEN EXISTS (
               SELECT 1
               FROM jobs
               WHERE status = 'failed'
                 AND error_code = 'VERIFICATION_FAILED'
                 AND finished_at IS NOT NULL
                 AND finished_at >= ?
                 AND finished_at <= ?
             ) THEN 'VERIFICATION_FAILED'
             WHEN control.deletion_overdue_count > 0 THEN 'DELETION_OVERDUE'
             WHEN EXISTS (
               SELECT 1
               FROM jobs
               WHERE status = 'queued'
                 AND (
                   queued_at IS NULL
                   OR queued_at > ?
                   OR queued_at < ?
                 )
             ) THEN 'QUEUE_AGE_EXCEEDED'
             ELSE NULL
           END AS reason
           FROM rollout_control AS control
           WHERE control.id = 1
         )
         UPDATE rollout_control
         SET circuit_open = CASE
               WHEN circuit_open = 1 OR (SELECT reason FROM hard_signal) IS NOT NULL THEN 1
               ELSE 0
             END,
             reason = CASE
               WHEN circuit_open = 1 THEN reason
               ELSE COALESCE((SELECT reason FROM hard_signal), reason)
             END,
             opened_at = CASE
               WHEN circuit_open = 0 AND (SELECT reason FROM hard_signal) IS NOT NULL
                 THEN COALESCE(opened_at, ?)
               ELSE opened_at
             END,
             last_evaluated_at = ?
         WHERE id = 1`,
      )
      .bind(verificationWindowStartedAt, now, now, oldestAllowedQueuedAt, now, now),
    session.prepare(
      `SELECT circuit_open, reason, opened_at, last_evaluated_at
       FROM rollout_control
       WHERE id = 1`,
    ),
  ]);
  const raw = results[1]?.results[0];
  const parsed = circuitSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Circuit breaker control state is unavailable or malformed.");
  }

  return {
    open: parsed.data.circuit_open === 1,
    reason: parsed.data.reason,
    openedAt: parsed.data.opened_at,
    evaluatedAt: parsed.data.last_evaluated_at,
  };
}
