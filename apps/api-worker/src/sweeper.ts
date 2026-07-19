import type { ImageJobMessage } from "@hereisit/server-contracts";
import { calculateSettledWeightedUnits, retentionDecision } from "@hereisit/server-job";
import { z } from "zod";
import { evaluateCircuitBreaker } from "./circuit-breaker";
import { createD1JobRepository, createD1LifecycleRepository } from "./d1-job-repository";
import { type Env, parseOperationalConfig } from "./env";
import { prepareOperationalCounter } from "./operational-counters";
import { dispatchJobOutbox, dispatchPendingOutbox } from "./outbox";
import { emitSafeProcessingEvent, sessionHashPrefix } from "./telemetry";

const MAINTENANCE_LIMIT = 100;
const LOST_QUEUE_AFTER_MS = 60_000;
const ORPHAN_GRACE_MS = 10 * 60_000;
const NETWORK_RETENTION_MS = 48 * 60 * 60_000;
const AGGREGATE_RETENTION_MS = 35 * 24 * 60 * 60_000;
const RETRY_CLEANUP_AFTER_MS = 5 * 60_000;
const RECOVERY_LEASE_MS = 30_000;
const TERMINAL_RECORD_MS = 24 * 60 * 60_000;
const CONTROL_PLANE_FLOOR_UNITS = calculateSettledWeightedUnits([]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEY_PATTERN =
  /^inputs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTPUT_KEY_PATTERN =
  /^outputs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ResultRetentionState {
  readonly resultExpiresAt: number | null;
  readonly downloadAcknowledgedAt: number | null;
  readonly downloadLeaseExpiresAt: number | null;
}

export function resultDeletionDue(state: ResultRetentionState, now: number): boolean {
  requireTime(now);
  const activeLease = state.downloadLeaseExpiresAt !== null && state.downloadLeaseExpiresAt > now;
  if (activeLease) return false;
  return (
    state.downloadAcknowledgedAt !== null ||
    (state.resultExpiresAt !== null && state.resultExpiresAt <= now)
  );
}

export function nextArtifactCursor(page: {
  readonly truncated: boolean;
  readonly cursor?: string | undefined;
}): string | null {
  if (!page.truncated) return null;
  if (typeof page.cursor !== "string" || page.cursor.length === 0 || page.cursor.length > 2_048) {
    throw new TypeError("A truncated R2 listing must provide a bounded cursor.");
  }
  return page.cursor;
}

function requireTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Maintenance time must be a non-negative safe integer.");
  }
}

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAINTENANCE_LIMIT) {
    throw new RangeError(`Maintenance limit must be between 1 and ${MAINTENANCE_LIMIT}.`);
  }
}

export interface ScheduledMaintenanceDependencies<Environment> {
  readonly recordCounters: (env: Environment, now: number) => Promise<unknown>;
  readonly dispatchPendingOutbox: (
    env: Environment,
    now: number,
    limit: number,
  ) => Promise<unknown>;
  readonly recoverStale: (env: Environment, now: number, limit: number) => Promise<unknown>;
  readonly sweepExpired: (env: Environment, now: number, limit: number) => Promise<unknown>;
  readonly sweepOrphans: (env: Environment, olderThan: number, limit: number) => Promise<unknown>;
  readonly evaluateCircuit: (env: Environment, now: number) => Promise<unknown>;
}

export async function runScheduledMaintenanceWithDependencies<Environment>(
  env: Environment,
  now: number,
  dependencies: ScheduledMaintenanceDependencies<Environment>,
): Promise<void> {
  requireTime(now);
  await dependencies.recordCounters(env, now);
  await dependencies.dispatchPendingOutbox(env, now, MAINTENANCE_LIMIT);
  await dependencies.recoverStale(env, now, MAINTENANCE_LIMIT);
  await dependencies.sweepExpired(env, now, MAINTENANCE_LIMIT);
  await dependencies.sweepOrphans(env, now - ORPHAN_GRACE_MS, MAINTENANCE_LIMIT);
  await dependencies.evaluateCircuit(env, now);
}

const recoveryRowSchema = z
  .object({
    id: z.string().regex(UUID_PATTERN),
    status: z.enum(["queued", "running"]),
    lease_expires_at: z.number().int().min(0).nullable(),
    processing_deadline_at: z.number().int().min(0).nullable(),
    cancel_requested_at: z.number().int().min(0).nullable(),
    input_key: z.string().regex(INPUT_KEY_PATTERN),
    output_key: z.string().regex(OUTPUT_KEY_PATTERN),
  })
  .strict();

async function settleAbandonedRunningJob(
  env: Env,
  row: z.infer<typeof recoveryRowSchema>,
  now: number,
  terminal: "cancelled" | "expired",
): Promise<boolean> {
  const recoveryLease = crypto.randomUUID();
  const leaseExpiry = now + RECOVERY_LEASE_MS;
  const terminalExpiry = now + TERMINAL_RECORD_MS;
  const errorCode = terminal === "expired" ? "EXPIRED" : "CANCELLED";
  const session = env.DB.withSession("first-primary");
  const marker = `EXISTS (
    SELECT 1 FROM jobs JOIN usage_ledger ON usage_ledger.job_id = jobs.id
    WHERE jobs.id = ? AND jobs.status = ? AND jobs.settlement_state = 'settled'
      AND jobs.finished_at = ? AND usage_ledger.settled_at IS NULL
  )`;
  const results = await session.batch([
    session
      .prepare(
        `UPDATE jobs
       SET lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         AND (cancel_requested_at IS NOT NULL OR processing_deadline_at <= ?)`,
      )
      .bind(recoveryLease, leaseExpiry, now, row.id, now, now),
    session
      .prepare(
        `UPDATE jobs
       SET status = ?, phase = 'completed', phase_fraction = 1,
           phase_sequence = phase_sequence + 1,
           actual_units = COALESCE(actual_units, 0) + ?, settlement_state = 'settled',
           cancel_requested_at = COALESCE(cancel_requested_at, ?),
           lease_token = NULL, lease_expires_at = NULL,
           error_code = ?, error_guidance = NULL, result_expires_at = NULL,
           finished_at = ?, terminal_record_expires_at = ?,
           network_hash_expires_at = MIN(network_hash_expires_at, ?), updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_token = ?
         AND EXISTS (
           SELECT 1 FROM account_usage
           WHERE day_key = jobs.day_key AND reserved_units >= jobs.reserved_units
             AND pending_jobs > 0
         )
         AND EXISTS (
           SELECT 1 FROM anonymous_usage
           WHERE session_hash = jobs.session_hash AND day_key = jobs.day_key
             AND reserved_units >= jobs.reserved_units AND active_jobs > 0
         )
         AND EXISTS (
           SELECT 1 FROM network_usage
           WHERE network_hash = jobs.network_hash AND day_key = jobs.day_key
             AND reserved_units >= jobs.reserved_units AND pending_jobs > 0
         )
         AND EXISTS (
           SELECT 1 FROM usage_ledger WHERE job_id = jobs.id AND settled_at IS NULL
         )`,
      )
      .bind(
        terminal,
        CONTROL_PLANE_FLOOR_UNITS,
        now,
        errorCode,
        now,
        terminalExpiry,
        terminalExpiry,
        now,
        row.id,
        recoveryLease,
      ),
    session
      .prepare(
        `UPDATE account_usage
       SET reserved_units = reserved_units - (SELECT reserved_units FROM jobs WHERE id = ?),
           settled_units = settled_units + (SELECT actual_units FROM jobs WHERE id = ?),
           pending_jobs = pending_jobs - 1, updated_at = ?
       WHERE day_key = (SELECT day_key FROM jobs WHERE id = ?) AND ${marker}`,
      )
      .bind(row.id, row.id, now, row.id, row.id, terminal, now),
    session
      .prepare(
        `UPDATE anonymous_usage
       SET reserved_units = reserved_units - (SELECT reserved_units FROM jobs WHERE id = ?),
           settled_units = settled_units + (SELECT actual_units FROM jobs WHERE id = ?),
           active_jobs = active_jobs - 1, updated_at = ?
       WHERE session_hash = (SELECT session_hash FROM jobs WHERE id = ?)
         AND day_key = (SELECT day_key FROM jobs WHERE id = ?) AND ${marker}`,
      )
      .bind(row.id, row.id, now, row.id, row.id, row.id, terminal, now),
    session
      .prepare(
        `UPDATE network_usage
       SET reserved_units = reserved_units - (SELECT reserved_units FROM jobs WHERE id = ?),
           settled_units = settled_units + (SELECT actual_units FROM jobs WHERE id = ?),
           pending_jobs = pending_jobs - 1, updated_at = ?
       WHERE network_hash = (SELECT network_hash FROM jobs WHERE id = ?)
         AND day_key = (SELECT day_key FROM jobs WHERE id = ?) AND ${marker}`,
      )
      .bind(row.id, row.id, now, row.id, row.id, row.id, terminal, now),
    session
      .prepare(
        `UPDATE usage_ledger
       SET actual_units = (SELECT actual_units FROM jobs WHERE id = ?),
           outcome = ?, settled_at = ?
       WHERE job_id = ? AND settled_at IS NULL
         AND EXISTS (
           SELECT 1 FROM jobs WHERE id = ? AND status = ?
             AND settlement_state = 'settled' AND finished_at = ?
         )`,
      )
      .bind(row.id, terminal, now, row.id, row.id, terminal, now),
    session.prepare("DELETE FROM job_outbox WHERE job_id = ?").bind(row.id),
  ]);
  const claimChanged = results[0]?.meta.changes ?? results[0]?.meta.rows_written ?? 0;
  const terminalChanged = results[1]?.meta.changes ?? results[1]?.meta.rows_written ?? 0;
  if (claimChanged === 0) return false;
  if (claimChanged !== 1 || terminalChanged !== 1) {
    throw new Error("Recovery lease did not settle exactly one job.");
  }
  for (const index of [2, 3, 4, 5]) {
    const changed = results[index]?.meta.changes ?? results[index]?.meta.rows_written ?? 0;
    if (changed !== 1) throw new Error("Recovery settlement accounting is incomplete.");
  }
  return true;
}

async function requeueForRecovery(env: Env, jobId: string, now: number): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs
       SET status = 'queued', phase = 'queued', phase_fraction = NULL,
           phase_sequence = phase_sequence + 1, lease_token = NULL, lease_expires_at = NULL,
           queue_generation = queue_generation + 1, updated_at = ?
       WHERE id = ? AND settlement_state = 'reserved'
         AND (
           (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           OR status = 'queued'
         )`,
    ).bind(now, jobId, now),
    env.DB.prepare(
      `INSERT INTO job_outbox (
         job_id, payload, attempts, next_attempt_at, sent_at, reconciled_at
       )
       SELECT id,
         json_object(
           'jobId', id,
           'contractId', contract_id,
           'specHash', spec_hash,
           'inputKey', input_key,
           'inputEtag', input_etag,
           'outputKey', output_key,
           'resourceClass', resource_class,
           'attempt', attempt,
           'queueEpoch', queue_epoch,
           'queueGeneration', queue_generation
         ),
         0, ?, NULL, ?
       FROM jobs
       WHERE id = ? AND status = 'queued' AND settlement_state = 'reserved'
         AND input_etag IS NOT NULL
       ON CONFLICT(job_id) DO UPDATE SET
         payload = excluded.payload,
         attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         sent_at = NULL,
         reconciled_at = excluded.reconciled_at`,
    ).bind(now, now, jobId),
  ]);
  const changed = results[0]?.meta.changes ?? results[0]?.meta.rows_written ?? 0;
  return changed === 1;
}

async function bestEffortWorkspaceCleanup(env: Env, jobId: string): Promise<void> {
  try {
    const { createContainerEngineClient } = await import("./container-client");
    const engine = createContainerEngineClient(env);
    await engine.cancel(jobId).catch(() => undefined);
    await engine.remove(jobId).catch(() => undefined);
  } catch {
    // Task 11 installs the runtime Container binding; retention remains recoverable until then.
  }
}

async function markRecoveredDeadlineExpired(env: Env, jobId: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs
       SET status = 'expired', error_code = 'EXPIRED', updated_at = ?
       WHERE id = ? AND status = 'cancelled' AND settlement_state = 'settled'
         AND finished_at = ?`,
    ).bind(now, jobId, now),
    env.DB.prepare(
      `UPDATE usage_ledger
       SET outcome = 'expired'
       WHERE job_id = ? AND outcome = 'cancelled' AND settled_at = ?
         AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'expired')`,
    ).bind(jobId, now, jobId),
  ]);
}

export async function recoverStaleLeasesAndLostQueueMessages(
  env: Env,
  now: number,
  limit = MAINTENANCE_LIMIT,
): Promise<number> {
  requireTime(now);
  requireLimit(limit);
  const selected = await env.DB.prepare(
    `SELECT jobs.id, jobs.status, jobs.lease_expires_at, jobs.processing_deadline_at,
            jobs.cancel_requested_at, jobs.input_key, jobs.output_key
     FROM jobs
     LEFT JOIN job_outbox ON job_outbox.job_id = jobs.id
     WHERE jobs.settlement_state = 'reserved'
       AND (
         (jobs.status = 'running' AND jobs.lease_expires_at IS NOT NULL
           AND jobs.lease_expires_at <= ?)
         OR (jobs.status = 'queued' AND job_outbox.sent_at IS NOT NULL
           AND job_outbox.sent_at <= ? AND job_outbox.reconciled_at IS NULL)
       )
     ORDER BY jobs.updated_at ASC, jobs.id ASC
     LIMIT ?`,
  )
    .bind(now, now - LOST_QUEUE_AFTER_MS, limit)
    .all<unknown>();
  if (!selected.success) throw new Error("Recovery selection failed.");
  let recovered = 0;
  const lifecycle = createD1LifecycleRepository(env.DB);
  for (const raw of selected.results) {
    const parsed = recoveryRowSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Recovery row validation failed.");
    const row = parsed.data;
    const deadlinePassed = row.processing_deadline_at !== null && row.processing_deadline_at <= now;
    if (row.cancel_requested_at !== null || deadlinePassed) {
      if (row.status === "running") {
        if (
          await settleAbandonedRunningJob(env, row, now, deadlinePassed ? "expired" : "cancelled")
        ) {
          await Promise.allSettled([
            env.JOB_OBJECTS.delete(row.input_key),
            env.JOB_OBJECTS.delete(row.output_key),
            bestEffortWorkspaceCleanup(env, row.id),
          ]);
          recovered += 1;
        }
        continue;
      }
      const terminal = await lifecycle.cancelJob(row.id, now);
      if (terminal.kind === "cancelled-and-settled" || terminal.kind === "terminal") {
        if (deadlinePassed) await markRecoveredDeadlineExpired(env, row.id, now);
        await Promise.allSettled([
          env.JOB_OBJECTS.delete(terminal.job.inputKey),
          env.JOB_OBJECTS.delete(terminal.job.outputKey),
          bestEffortWorkspaceCleanup(env, row.id),
        ]);
        recovered += 1;
      }
      continue;
    }
    if (await requeueForRecovery(env, row.id, now)) {
      await dispatchJobOutbox(env, row.id, now);
      recovered += 1;
    }
  }
  return recovered;
}

const sweepRowSchema = z
  .object({
    id: z.string().regex(UUID_PATTERN),
    status: z.enum(["created", "uploading", "succeeded", "failed", "cancelled", "expired"]),
    input_key: z.string().regex(INPUT_KEY_PATTERN),
    output_key: z.string().regex(OUTPUT_KEY_PATTERN),
    upload_version: z.number().int().min(0),
    upload_expires_at: z.number().int().min(0),
    result_expires_at: z.number().int().min(0).nullable(),
    download_acknowledged_at: z.number().int().min(0).nullable(),
    download_lease_expires_at: z.number().int().min(0).nullable(),
    terminal_record_expires_at: z.number().int().min(0).nullable(),
    session_hash: z.string().regex(/^[0-9a-f]{64}$/),
    declared_bytes: z.number().int().min(1),
    declared_width: z.number().int().min(1),
    declared_height: z.number().int().min(1),
    reserved_units: z.number().int().min(0),
    result_kind: z.enum(["download", "original-retained"]).nullable(),
  })
  .strict();

async function deleteTerminalRecord(
  env: Env,
  row: z.infer<typeof sweepRowSchema>,
  now: number,
): Promise<void> {
  const [input, output] = await Promise.all([
    env.JOB_OBJECTS.head(row.input_key).then(
      (value) => ({ exists: value !== null }),
      () => ({ exists: true }),
    ),
    env.JOB_OBJECTS.head(row.output_key).then(
      (value) => ({ exists: value !== null }),
      () => ({ exists: true }),
    ),
  ]);
  const statements: D1PreparedStatement[] = [];
  if (input.exists || output.exists) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO artifact_cleanup_tombstones (
         id, input_key, output_key, input_exists, output_exists,
         first_failed_at, next_attempt_at, attempt_count, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'STORAGE_FAILURE')
       ON CONFLICT DO UPDATE SET
         input_key = excluded.input_key,
         output_key = excluded.output_key,
         input_exists = excluded.input_exists,
         output_exists = excluded.output_exists,
         next_attempt_at = excluded.next_attempt_at,
         last_error_code = excluded.last_error_code`,
      ).bind(
        crypto.randomUUID(),
        input.exists ? row.input_key : null,
        output.exists ? row.output_key : null,
        input.exists ? 1 : 0,
        output.exists ? 1 : 0,
        now,
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare("DELETE FROM jobs WHERE id = ? AND terminal_record_expires_at <= ?").bind(
      row.id,
      now,
    ),
  );
  await env.DB.batch(statements);
  const retained = await env.DB.prepare("SELECT 1 AS present FROM jobs WHERE id = ?")
    .bind(row.id)
    .first();
  if (retained !== null) throw new Error("Terminal record deletion lost its retention fence.");
}

const tombstoneRowSchema = z
  .object({
    id: z.string().regex(UUID_PATTERN),
    input_key: z.string().regex(INPUT_KEY_PATTERN).nullable(),
    output_key: z.string().regex(OUTPUT_KEY_PATTERN).nullable(),
    attempt_count: z.number().int().min(0),
  })
  .strict();

async function sweepTombstones(env: Env, now: number, limit: number): Promise<number> {
  const selected = await env.DB.prepare(
    `SELECT id, input_key, output_key, attempt_count
     FROM artifact_cleanup_tombstones
     WHERE next_attempt_at <= ?
     ORDER BY next_attempt_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<unknown>();
  if (!selected.success) throw new Error("Cleanup tombstone selection failed.");
  let removed = 0;
  for (const raw of selected.results) {
    const parsed = tombstoneRowSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Cleanup tombstone validation failed.");
    const row = parsed.data;
    try {
      await Promise.all([
        row.input_key === null ? Promise.resolve() : env.JOB_OBJECTS.delete(row.input_key),
        row.output_key === null ? Promise.resolve() : env.JOB_OBJECTS.delete(row.output_key),
      ]);
      const [input, output] = await Promise.all([
        row.input_key === null ? null : env.JOB_OBJECTS.head(row.input_key),
        row.output_key === null ? null : env.JOB_OBJECTS.head(row.output_key),
      ]);
      if (input === null && output === null) {
        await env.DB.prepare("DELETE FROM artifact_cleanup_tombstones WHERE id = ?")
          .bind(row.id)
          .run();
        removed += 1;
        continue;
      }
    } catch {
      // The bounded retry row below records only a normalized code.
    }
    await env.DB.prepare(
      `UPDATE artifact_cleanup_tombstones
       SET attempt_count = attempt_count + 1, next_attempt_at = ?,
           last_error_code = 'STORAGE_FAILURE'
       WHERE id = ? AND attempt_count = ?`,
    )
      .bind(now + RETRY_CLEANUP_AFTER_MS, row.id, row.attempt_count)
      .run();
  }
  return removed;
}

async function markExpiredDownloadResult(env: Env, jobId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs
     SET status = 'expired', error_code = 'EXPIRED', error_guidance = NULL,
         result_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'succeeded' AND result_kind = 'download'
       AND result_expires_at <= ?
       AND (download_lease_expires_at IS NULL OR download_lease_expires_at <= ?)`,
  )
    .bind(now, jobId, now, now)
    .run();
}

export async function sweepExpiredJobs(
  env: Env,
  now: number,
  limit = MAINTENANCE_LIMIT,
): Promise<number> {
  requireTime(now);
  requireLimit(limit);
  await sweepTombstones(env, now, limit);
  const selected = await env.DB.prepare(
    `SELECT id, status, input_key, output_key, upload_version, upload_expires_at,
            result_expires_at, download_acknowledged_at, download_lease_expires_at,
            terminal_record_expires_at, session_hash, declared_bytes,
            declared_width, declared_height, reserved_units, result_kind
     FROM jobs
     WHERE
       (status IN ('created', 'uploading') AND upload_expires_at <= ?)
       OR (status = 'succeeded' AND result_kind = 'download'
         AND (download_acknowledged_at IS NOT NULL OR result_expires_at <= ?)
         AND (download_lease_expires_at IS NULL OR download_lease_expires_at <= ?))
       OR (status IN ('failed', 'cancelled', 'expired'))
       OR (terminal_record_expires_at IS NOT NULL AND terminal_record_expires_at <= ?)
     ORDER BY updated_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, now, now, now, limit)
    .all<unknown>();
  if (!selected.success) throw new Error("Expired-job selection failed.");
  const jobs = createD1JobRepository(env.DB);
  const lifecycle = createD1LifecycleRepository(env.DB);
  let swept = 0;
  for (const raw of selected.results) {
    const parsed = sweepRowSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Expired-job row validation failed.");
    const row = parsed.data;
    const decision = retentionDecision({
      state: row.status,
      resultKind: row.result_kind,
      uploadExpiresAt: row.upload_expires_at,
      resultExpiresAt: row.result_expires_at,
      terminalRecordExpiresAt: row.terminal_record_expires_at,
      now,
      downloadAcknowledgedAt: row.download_acknowledged_at,
    });
    if (decision.deleteRecord) {
      await deleteTerminalRecord(env, row, now);
      swept += 1;
      continue;
    }
    if (row.status === "created" || row.status === "uploading") {
      await jobs.settlePreEngineFailure({
        jobId: row.id,
        inputKey: row.input_key,
        uploadVersion: row.upload_version,
        now,
        outcome: "expired",
        errorCode: "UPLOAD_EXPIRED",
      });
    }
    if (row.status === "succeeded") {
      await lifecycle.deleteJob(row.id, now);
      if (decision.expireJob) await markExpiredDownloadResult(env, row.id, now);
    }
    try {
      if (decision.deleteInput) await env.JOB_OBJECTS.delete(row.input_key);
      if (decision.deleteOutput) await env.JOB_OBJECTS.delete(row.output_key);
      if (row.status !== "created" && row.status !== "uploading") {
        await bestEffortWorkspaceCleanup(env, row.id);
      }
      if (row.status === "succeeded") await lifecycle.completeResultDeletion(row.id, now);
      swept += 1;
    } catch {
      // The terminal job remains until its retention boundary; the next sweep retries.
      try {
        emitSafeProcessingEvent({
          event: "deletion",
          jobId: row.id,
          sessionHashPrefix: sessionHashPrefix(row.session_hash),
          contractId: "image.optimize@1",
          inputBytes: row.declared_bytes,
          pixels: row.declared_width * row.declared_height,
          reservedUnits: row.reserved_units,
          errorCode: "STORAGE_FAILURE",
        });
      } catch {
        // Telemetry cannot change retention behavior.
      }
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET network_hash = NULL, updated_at = ?
       WHERE network_hash IS NOT NULL AND network_hash_expires_at <= ?`,
    ).bind(now, now),
    env.DB.prepare(
      `UPDATE usage_ledger SET network_hash = NULL
       WHERE network_hash IS NOT NULL
         AND job_id IN (SELECT id FROM jobs WHERE network_hash IS NULL)`,
    ),
    env.DB.prepare(
      `DELETE FROM network_usage
       WHERE created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE jobs.network_hash = network_usage.network_hash
         )`,
    ).bind(now - NETWORK_RETENTION_MS),
    env.DB.prepare("DELETE FROM account_usage WHERE created_at <= ? AND pending_jobs = 0").bind(
      now - AGGREGATE_RETENTION_MS,
    ),
    env.DB.prepare(
      `DELETE FROM anonymous_usage
       WHERE created_at <= ? AND active_jobs = 0
         AND NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE jobs.session_hash = anonymous_usage.session_hash
             AND jobs.day_key = anonymous_usage.day_key
         )`,
    ).bind(now - AGGREGATE_RETENTION_MS),
  ]);
  return swept;
}

const cursorRowSchema = z.object({ cursor: z.string().max(2_048).nullable() }).strict();

export async function sweepOrphanArtifactsFromSavedCursor(
  env: Env,
  olderThan: number,
  limit = MAINTENANCE_LIMIT,
): Promise<number> {
  requireTime(olderThan);
  requireLimit(limit);
  const cursorRaw = await env.DB.prepare(
    "SELECT cursor FROM maintenance_cursors WHERE task = 'orphan-artifacts'",
  ).first();
  const parsedCursor = cursorRaw === null ? null : cursorRowSchema.safeParse(cursorRaw);
  if (parsedCursor !== null && !parsedCursor.success) {
    throw new Error("Saved orphan cursor is invalid.");
  }
  const cursor = parsedCursor === null ? undefined : (parsedCursor.data.cursor ?? undefined);
  const listed = await env.JOB_OBJECTS.list({ ...(cursor !== undefined ? { cursor } : {}), limit });
  let removed = 0;
  for (const object of listed.objects) {
    if (object.uploaded.valueOf() > olderThan) continue;
    if (!INPUT_KEY_PATTERN.test(object.key) && !OUTPUT_KEY_PATTERN.test(object.key)) continue;
    const owner = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT id FROM jobs WHERE input_key = ? OR output_key = ?
         UNION ALL
         SELECT id FROM artifact_cleanup_tombstones WHERE input_key = ? OR output_key = ?
       )`,
    )
      .bind(object.key, object.key, object.key, object.key)
      .first<{ count: number }>();
    if (owner === null || owner.count !== 0) continue;
    await env.JOB_OBJECTS.delete(object.key);
    removed += 1;
  }
  const next = nextArtifactCursor(listed);
  await env.DB.prepare(
    `INSERT INTO maintenance_cursors (task, cursor, updated_at)
     VALUES ('orphan-artifacts', ?, ?)
     ON CONFLICT(task) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  )
    .bind(next, olderThan + ORPHAN_GRACE_MS)
    .run();
  return removed;
}

export async function runScheduledMaintenance(env: Env, now = Date.now()): Promise<void> {
  await runScheduledMaintenanceWithDependencies(env, now, {
    recordCounters: async (environment, recordedAt) => {
      await environment.DB.batch([
        prepareOperationalCounter(environment.DB, {
          recordedAt,
          d1RowsRead: 1,
          d1RowsWritten: 1,
        }),
      ]);
    },
    dispatchPendingOutbox,
    recoverStale: recoverStaleLeasesAndLostQueueMessages,
    sweepExpired: sweepExpiredJobs,
    sweepOrphans: sweepOrphanArtifactsFromSavedCursor,
    evaluateCircuit: async (environment, evaluatedAt) => {
      const config = await parseOperationalConfig(environment);
      await evaluateCircuitBreaker(environment.DB, {
        now: evaluatedAt,
        maximumQueuedAgeSeconds: config.maximumQueuedAgeSeconds,
      });
    },
  });
}

export type ScheduledQueueMessage = ImageJobMessage;
