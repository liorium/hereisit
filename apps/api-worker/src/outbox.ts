import { type ImageJobMessage, imageJobMessageSchema } from "@hereisit/server-contracts";

const DEFAULT_DISPATCH_LIMIT = 10;
const MAX_DISPATCH_LIMIT = 100;
const MAX_PAYLOAD_BYTES = 8_192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEY_PATTERN =
  /^inputs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTPUT_KEY_PATTERN =
  /^outputs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface OutboxRow {
  readonly job_id: string;
  readonly payload: string;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly sent_at: null;
}

interface D1RunResultLike {
  readonly success: boolean;
  readonly meta: {
    readonly changes?: number;
    readonly rows_written?: number;
  };
}

interface D1AllResultLike<T> {
  readonly success: boolean;
  readonly results: T[];
}

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T>(): Promise<D1AllResultLike<T>>;
  run(): Promise<D1RunResultLike>;
}

interface OutboxDatabase {
  prepare(query: string): D1PreparedStatementLike;
}

interface OutboxQueue {
  send(message: ImageJobMessage, options: { contentType: "json" }): Promise<unknown>;
}

export interface OutboxEnvironment {
  readonly DB: OutboxDatabase;
  readonly IMAGE_JOBS: OutboxQueue;
}

function changedRows(result: D1RunResultLike): number {
  if (!result.success) {
    throw new Error("Outbox compare-and-set failed.");
  }
  return result.meta.changes ?? result.meta.rows_written ?? 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOutboxRow(value: unknown):
  | { readonly kind: "valid"; readonly row: OutboxRow }
  | {
      readonly kind: "corrupt";
      readonly row: OutboxRow;
    } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox row validation failed.");
  }
  const row = value as Record<string, unknown>;
  const jobId = row.job_id;
  const payload = row.payload;
  const attempts = row.attempts;
  const nextAttemptAt = row.next_attempt_at;
  if (
    typeof jobId !== "string" ||
    jobId.length < 1 ||
    jobId.length > 128 ||
    /[^\x20-\x7e]/.test(jobId) ||
    typeof payload !== "string" ||
    !isNonnegativeSafeInteger(attempts) ||
    attempts >= Number.MAX_SAFE_INTEGER ||
    !isNonnegativeSafeInteger(nextAttemptAt) ||
    row.sent_at !== null
  ) {
    throw new Error("Outbox row validation failed.");
  }
  const parsed = {
    job_id: jobId,
    payload,
    attempts,
    next_attempt_at: nextAttemptAt,
    sent_at: null,
  };
  if (!UUID_PATTERN.test(jobId)) {
    return { kind: "corrupt", row: parsed };
  }
  return { kind: "valid", row: parsed };
}

function parsePayload(payload: string): ImageJobMessage | null {
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = imageJobMessageSchema.safeParse(value);
  if (!parsed.success) return null;
  if (
    !UUID_PATTERN.test(parsed.data.jobId) ||
    !UUID_PATTERN.test(parsed.data.queueEpoch) ||
    !INPUT_KEY_PATTERN.test(parsed.data.inputKey) ||
    !OUTPUT_KEY_PATTERN.test(parsed.data.outputKey)
  ) {
    return null;
  }
  return parsed.data;
}

function requireDispatchLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISPATCH_LIMIT) {
    throw new RangeError(`Outbox dispatch limit must be between 1 and ${MAX_DISPATCH_LIMIT}.`);
  }
  return limit;
}

function requireDispatchTime(now: number): void {
  if (!isNonnegativeSafeInteger(now) || now > Number.MAX_SAFE_INTEGER - 120_000) {
    throw new RangeError("Outbox dispatch time must be a non-negative safe integer.");
  }
}

export function outboxRetryDelayMilliseconds(attemptsBeforeFailure: number): number {
  if (!Number.isSafeInteger(attemptsBeforeFailure) || attemptsBeforeFailure < 0) {
    throw new RangeError("Outbox attempts must be a non-negative safe integer.");
  }
  if (attemptsBeforeFailure === 0) return 10_000;
  if (attemptsBeforeFailure === 1) return 30_000;
  return 120_000;
}

async function markCorruptPayload(
  database: OutboxDatabase,
  row: OutboxRow,
  now: number,
): Promise<void> {
  const nextAttempts = row.attempts + 1;
  const nextAttemptAt = now + outboxRetryDelayMilliseconds(row.attempts);
  const result = await database
    .prepare(
      `UPDATE job_outbox
       SET attempts = ?, next_attempt_at = ?
       WHERE job_id = ?
         AND payload = ?
         AND attempts = ?
         AND next_attempt_at = ?
         AND sent_at IS NULL`,
    )
    .bind(nextAttempts, nextAttemptAt, row.job_id, row.payload, row.attempts, row.next_attempt_at)
    .run();
  changedRows(result);
}

async function markDispatchFailure(
  database: OutboxDatabase,
  row: OutboxRow,
  now: number,
): Promise<void> {
  const nextAttempts = row.attempts + 1;
  const nextAttemptAt = now + outboxRetryDelayMilliseconds(row.attempts);
  const result = await database
    .prepare(
      `UPDATE job_outbox
       SET attempts = ?, next_attempt_at = ?
       WHERE job_id = ?
         AND payload = ?
         AND attempts = ?
         AND next_attempt_at = ?
         AND sent_at IS NULL`,
    )
    .bind(nextAttempts, nextAttemptAt, row.job_id, row.payload, row.attempts, row.next_attempt_at)
    .run();
  changedRows(result);
}

async function markDispatchSuccess(
  database: OutboxDatabase,
  row: OutboxRow,
  now: number,
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE job_outbox
       SET sent_at = ?
       WHERE job_id = ?
         AND payload = ?
         AND attempts = ?
         AND next_attempt_at = ?
         AND sent_at IS NULL`,
    )
    .bind(now, row.job_id, row.payload, row.attempts, row.next_attempt_at)
    .run();
  return changedRows(result) === 1;
}

async function dispatchSelectedRows(
  env: OutboxEnvironment,
  candidates: readonly unknown[],
  now: number,
): Promise<number> {
  let dispatched = 0;
  for (const candidate of candidates) {
    const parsedRow = parseOutboxRow(candidate);
    const row = parsedRow.row;
    if (parsedRow.kind === "corrupt") {
      await markCorruptPayload(env.DB, row, now);
      continue;
    }
    const payload = parsePayload(row.payload);
    if (payload === null || payload.jobId !== row.job_id) {
      await markCorruptPayload(env.DB, row, now);
      continue;
    }

    try {
      await env.IMAGE_JOBS.send(payload, { contentType: "json" });
    } catch {
      await markDispatchFailure(env.DB, row, now);
      continue;
    }
    if (await markDispatchSuccess(env.DB, row, now)) {
      dispatched += 1;
    }
  }
  return dispatched;
}

export async function dispatchPendingOutbox(
  env: OutboxEnvironment,
  now: number,
  limit = DEFAULT_DISPATCH_LIMIT,
): Promise<number> {
  requireDispatchTime(now);
  const boundedLimit = requireDispatchLimit(limit);
  const selected = await env.DB.prepare(
    `SELECT job_id, payload, attempts, next_attempt_at, sent_at
     FROM job_outbox
     WHERE sent_at IS NULL
       AND next_attempt_at <= ?
     ORDER BY next_attempt_at ASC, job_id ASC
     LIMIT ?`,
  )
    .bind(now, boundedLimit)
    .all<unknown>();
  if (!selected.success) {
    throw new Error("Outbox selection failed.");
  }
  return dispatchSelectedRows(env, selected.results, now);
}

export async function dispatchJobOutbox(
  env: OutboxEnvironment,
  jobId: string,
  now: number,
): Promise<boolean> {
  if (!UUID_PATTERN.test(jobId)) {
    throw new TypeError("Outbox job ID must be a canonical lowercase UUID.");
  }
  requireDispatchTime(now);
  const selected = await env.DB.prepare(
    `SELECT job_id, payload, attempts, next_attempt_at, sent_at
     FROM job_outbox
     WHERE job_id = ?
       AND sent_at IS NULL
       AND next_attempt_at <= ?
     LIMIT 1`,
  )
    .bind(jobId, now)
    .all<unknown>();
  if (!selected.success) {
    throw new Error("Outbox selection failed.");
  }
  return (await dispatchSelectedRows(env, selected.results, now)) === 1;
}
