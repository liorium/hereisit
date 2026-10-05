import { z } from "zod";
import type { Env } from "./env";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z
  .object({
    epoch: z.string().regex(/^[0-9a-f]{32}$/),
    safetyGeneration: integer,
    auditGeneration: integer,
    openedAt: integer,
    reason: z.string().min(1).max(64),
  })
  .strict();
const emptyState = `circuit_open = 1 AND opened_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM jobs)
  AND NOT EXISTS (SELECT 1 FROM job_outbox)
  AND NOT EXISTS (SELECT 1 FROM usage_ledger)
  AND NOT EXISTS (SELECT 1 FROM artifact_cleanup_tombstones)
  AND NOT EXISTS (SELECT 1 FROM job_quarantine)
  AND NOT EXISTS (SELECT 1 FROM account_usage WHERE pending_jobs <> 0 OR reserved_units <> 0)
  AND NOT EXISTS (SELECT 1 FROM anonymous_usage WHERE active_jobs <> 0 OR reserved_units <> 0)
  AND NOT EXISTS (SELECT 1 FROM network_usage WHERE pending_jobs <> 0 OR reserved_units <> 0)
  AND EXISTS (SELECT 1 FROM worker_version_attestations WHERE kind = 'active'
    AND version_id = ? AND release_report_sha256 = ? AND observed_at <= ?)`;

// ponytail: only an entirely empty stopped service is audited; nonempty recovery needs a full inventory audit.
// This is present-state evidence, never proof of historical safety or permission to reopen admission.
export async function auditEmptyProcessingState(env: Env, now: number): Promise<boolean> {
  integer.parse(now);
  if (env.IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT !== "0") return false;
  const version = z.string().uuid().parse(env.WORKER_VERSION.id);
  const report = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(env.RELEASE_REPORT_SHA256);
  // Old scheduled/queue invocations are bounded to 15 minutes; this does not bound legacy HTTP/R2 writes.
  const session = env.DB.withSession("first-primary");
  const row = await session
    .prepare(`SELECT cost_accounting_epoch AS epoch,
    safety_generation AS safetyGeneration, deletion_sweep_generation AS auditGeneration,
    opened_at AS openedAt, reason FROM rollout_control WHERE id = 1 AND ${emptyState}`)
    .bind(version, report, Math.max(0, now - 15 * 60_000))
    .first();
  if (row === null) return false;
  const snapshot = snapshotSchema.parse(row);
  if (snapshot.openedAt > now || snapshot.auditGeneration === Number.MAX_SAFE_INTEGER) return false;
  // An empty first page with an explicit end is a complete bucket inventory.
  const listed = await env.JOB_OBJECTS.list({ limit: 1 });
  if (listed.truncated !== false || listed.objects.length !== 0) return false;
  const completedAt = integer.parse(Date.now());
  if (completedAt < now || completedAt - now > 15 * 60_000) return false;
  const results = await session.batch([
    session
      .prepare(`UPDATE rollout_control SET deletion_overdue_count = 0,
      deletion_sweep_generation = deletion_sweep_generation + 1,
      deletion_sweep_started_at = ?, deletion_sweep_completed_at = ?
      WHERE id = 1 AND ${emptyState}
        AND cost_accounting_epoch = ? AND safety_generation = ?
        AND deletion_sweep_generation = ? AND opened_at = ? AND reason = ?`)
      .bind(
        now,
        completedAt,
        version,
        report,
        Math.max(0, now - 15 * 60_000),
        snapshot.epoch,
        snapshot.safetyGeneration,
        snapshot.auditGeneration,
        snapshot.openedAt,
        snapshot.reason,
      ),
    session
      .prepare(`INSERT INTO maintenance_cursors(task, cursor, updated_at)
      SELECT 'empty-state-audit', ?, ? WHERE changes() = 1
      ON CONFLICT(task) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`)
      .bind(
        JSON.stringify({
          versionId: version,
          releaseReportSha256: report,
          epoch: snapshot.epoch,
          safetyGeneration: snapshot.safetyGeneration,
          auditGeneration: snapshot.auditGeneration + 1,
          startedAt: now,
          completedAt,
          historicalSafetyUnknown: true,
        }),
        completedAt,
      ),
  ]);
  return results.every((result) => result.success && result.meta.changes === 1);
}
