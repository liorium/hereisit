import { z } from "zod";
import { readAccountingHealth, recordAccountingHealth } from "./accounting-health";
import { prepareOperationalCounter } from "./operational-counters";

const DAY_MS = 24 * 60 * 60_000;
const OBJECT_LEDGER_RETENTION_MS = 7 * DAY_MS;
const COST_HISTORY_RETENTION_MS = 35 * DAY_MS;

const cleanupRowSchema = z
  .object({
    object_key: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\0")),
  })
  .strict();

export interface PrivateUsageLogBucket {
  readonly delete: (key: string) => Promise<void>;
}

export interface CleanupCostHistoryInput {
  readonly now: number;
  readonly limit?: number;
}

export interface CleanupCostHistoryResult {
  readonly deletedObjects: number;
  readonly purgedObjectLedgers: number;
  readonly purgedCostHours: number;
  readonly purgedActivitySegments: number;
}

function changes(result: D1Result<unknown> | undefined): number {
  const value = result?.meta.changes;
  if (
    result?.success !== true ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error("Cost-history cleanup returned invalid D1 metadata.");
  }
  return value;
}

export async function cleanupCostHistory(
  database: D1Database,
  bucket: PrivateUsageLogBucket,
  input: CleanupCostHistoryInput,
): Promise<CleanupCostHistoryResult> {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("Cost-history cleanup time is invalid.");
  }
  const limit = input.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
    throw new RangeError("Cost-history cleanup limit is invalid.");
  }
  const session = database.withSession("first-primary");
  const empty = {
    deletedObjects: 0,
    purgedObjectLedgers: 0,
    purgedCostHours: 0,
    purgedActivitySegments: 0,
  };
  const objectLedgerCutoff = Math.max(0, input.now - OBJECT_LEDGER_RETENTION_MS);
  const historyCutoff = Math.max(0, input.now - COST_HISTORY_RETENTION_MS);
  const historyHourCutoff = Math.floor(historyCutoff / 3_600_000);
  const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const control = z
    .object({
      epoch: z.string().regex(/^[a-f0-9]{32}$/),
      circuit_open: z.union([z.literal(0), z.literal(1)]),
      reason: z.string().nullable(),
      opened_at: integer.nullable(),
      safety_history_started_at: integer,
      started_at: integer,
      last_sealed: integer.nullable(),
    })
    .strict()
    .parse(
      await session
        .prepare(
          "SELECT cost_accounting_epoch AS epoch,circuit_open,reason,opened_at,safety_history_started_at,cost_accounting_started_at AS started_at,last_sealed_hour_key AS last_sealed FROM rollout_control WHERE id=1",
        )
        .first(),
    );
  // Retain primary evidence until a hard incident has been investigated.
  if (
    control.circuit_open === 1 &&
    (control.reason !== "COST_ACCOUNTING_INCOMPLETE" ||
      control.opened_at === null ||
      control.safety_history_started_at === 0 ||
      control.opened_at < control.safety_history_started_at)
  )
    return empty;
  const nextHour =
    control.last_sealed === null
      ? Math.ceil(control.started_at / 3_600_000)
      : control.last_sealed + 1;
  const gap = z
    .object({ hour: integer.nullable() })
    .strict()
    .parse(
      await session
        .prepare(`SELECT MIN(hour) AS hour FROM (
    SELECT ? AS hour WHERE ? < ?
    UNION ALL SELECT MIN(hour_key) FROM operational_cost_hourly WHERE complete=0 AND hour_key < ?
    UNION ALL SELECT MIN(first_hour_key) FROM usage_log_objects WHERE state IN ('observed','parsed') AND last_hour_key < ?
  )`)
        .bind(nextHour, nextHour, historyHourCutoff, historyHourCutoff, historyHourCutoff)
        .first(),
    );
  if (gap.hour !== null) {
    const health = await readAccountingHealth(database);
    const earliest = Math.min(gap.hour, health.unresolvedSinceHourKey ?? gap.hour);
    if (
      !(
        health.epoch === control.epoch &&
        health.reason === "HISTORICAL_GAP" &&
        health.unresolvedSinceHourKey !== null &&
        health.unresolvedSinceHourKey <= earliest
      )
    ) {
      const recorded = await recordAccountingHealth(database, {
        epoch: control.epoch,
        status: "degraded",
        reason: "HISTORICAL_GAP",
        evaluatedAt: input.now,
        pendingHourKey: health.pendingHourKey ?? nextHour,
        unresolvedSinceHourKey: earliest,
      });
      if (recorded !== "updated") return empty;
    }
  }
  const safeControl = `EXISTS (SELECT 1 FROM rollout_control WHERE id=1 AND cost_accounting_epoch=?
    AND (circuit_open=0 OR (reason='COST_ACCOUNTING_INCOMPLETE' AND opened_at IS NOT NULL AND safety_history_started_at > 0 AND opened_at >= safety_history_started_at)))`;
  const expiredObject = `(last_hour_key < ? OR (state IN ('sealed','delete-pending','deleted') AND last_hour_key IS NULL
    AND NOT EXISTS (SELECT 1 FROM usage_log_object_hours AS hours WHERE hours.object_key=usage_log_objects.object_key)))
    AND NOT EXISTS (SELECT 1 FROM usage_log_object_hours AS hours WHERE hours.object_key=usage_log_objects.object_key AND hours.hour_key >= ?)
    AND (state NOT IN ('observed','parsed') OR EXISTS (SELECT 1 FROM accounting_health
      WHERE epoch=(SELECT cost_accounting_epoch FROM rollout_control WHERE id=1) AND reason='HISTORICAL_GAP'
        AND unresolved_since_hour_key <= usage_log_objects.first_hour_key))`;
  const candidates = z.array(cleanupRowSchema).parse(
    (
      await session
        .prepare(
          `SELECT object_key FROM usage_log_objects
           WHERE ((state IN ('sealed', 'delete-pending')) OR (state IN ('observed','parsed') AND last_seen_at <= ?))
             AND ${expiredObject} AND ${safeControl}
           ORDER BY last_seen_at, object_key
           LIMIT ?`,
        )
        .bind(objectLedgerCutoff, historyHourCutoff, historyHourCutoff, control.epoch, limit)
        .all()
    ).results,
  );

  let deletedObjects = 0;
  for (const candidate of candidates) {
    const marked = await session.batch([
      session
        .prepare(
          `UPDATE usage_log_objects
           SET state = 'delete-pending'
           WHERE object_key = ? AND state IN ('sealed', 'delete-pending','observed','parsed')
             AND ${expiredObject} AND ${safeControl}`,
        )
        .bind(candidate.object_key, historyHourCutoff, historyHourCutoff, control.epoch),
      prepareOperationalCounter(session, {
        recordedAt: input.now,
        d1RowsRead: 1,
        d1RowsWritten: 3,
        r2ClassAOperations: 1,
      }),
    ]);
    if (changes(marked[0]) !== 1) continue;
    try {
      await bucket.delete(candidate.object_key);
    } catch {
      continue;
    }
    const finalized = await session
      .prepare(
        `UPDATE usage_log_objects
         SET state = 'deleted', deleted_at = ?
         WHERE object_key = ? AND state = 'delete-pending'`,
      )
      .bind(input.now, candidate.object_key)
      .run();
    if (changes(finalized) !== 1) {
      throw new Error("Deleted usage-log object could not be finalized.");
    }
    deletedObjects += 1;
  }

  const purged = await session.batch([
    session
      .prepare(
        `DELETE FROM usage_log_objects
         WHERE object_key IN (
           SELECT object_key FROM usage_log_objects
           WHERE state = 'deleted' AND deleted_at <= ? AND ${expiredObject} AND ${safeControl}
           ORDER BY deleted_at, object_key LIMIT ?
         )`,
      )
      .bind(objectLedgerCutoff, historyHourCutoff, historyHourCutoff, control.epoch, limit),
    session
      .prepare(
        `DELETE FROM operational_cost_hourly
         WHERE (accounting_epoch,hour_key) IN (SELECT accounting_epoch,hour_key FROM operational_cost_hourly
           WHERE hour_key < ? AND ${safeControl}
             AND (complete=1 OR EXISTS (SELECT 1 FROM accounting_health
               WHERE epoch=(SELECT cost_accounting_epoch FROM rollout_control WHERE id=1) AND reason='HISTORICAL_GAP'
                 AND unresolved_since_hour_key <= operational_cost_hourly.hour_key))
           ORDER BY hour_key,accounting_epoch LIMIT ? )`,
      )
      .bind(historyHourCutoff, control.epoch, limit),
    session
      .prepare(`DELETE FROM operational_counter_hourly WHERE (accounting_epoch,hour_key) IN (
        SELECT accounting_epoch,hour_key FROM operational_counter_hourly WHERE hour_key < ? AND ${safeControl}
        ORDER BY hour_key,accounting_epoch LIMIT ?)`)
      .bind(historyHourCutoff, control.epoch, limit),
    session
      .prepare(`DELETE FROM container_activity_segments WHERE id IN (SELECT id FROM container_activity_segments
        WHERE billed_until_at < ? AND ${safeControl} ORDER BY billed_until_at,id LIMIT ?)`)
      .bind(historyCutoff, control.epoch, limit),
    session
      .prepare(`DELETE FROM usage_log_hour_observations WHERE (accounting_epoch,hour_key) IN (
      SELECT accounting_epoch,hour_key FROM usage_log_hour_observations WHERE hour_key < ? AND ${safeControl}
      ORDER BY hour_key,accounting_epoch LIMIT ?)`)
      .bind(historyHourCutoff, control.epoch, limit),
  ]);

  return {
    deletedObjects,
    purgedObjectLedgers: changes(purged[0]),
    purgedCostHours: changes(purged[1]),
    purgedActivitySegments: changes(purged[3]),
  };
}
