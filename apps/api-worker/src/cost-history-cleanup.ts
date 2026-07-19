import { z } from "zod";
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
  const candidates = z.array(cleanupRowSchema).parse(
    (
      await session
        .prepare(
          `SELECT object_key FROM usage_log_objects
           WHERE state IN ('sealed', 'delete-pending')
           ORDER BY last_seen_at, object_key
           LIMIT ?`,
        )
        .bind(limit)
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
           WHERE object_key = ? AND state IN ('sealed', 'delete-pending')`,
        )
        .bind(candidate.object_key),
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

  const objectLedgerCutoff = Math.max(0, input.now - OBJECT_LEDGER_RETENTION_MS);
  const historyCutoff = Math.max(0, input.now - COST_HISTORY_RETENTION_MS);
  const historyHourCutoff = Math.floor(historyCutoff / 3_600_000);
  const purged = await session.batch([
    session
      .prepare(
        `DELETE FROM usage_log_objects
         WHERE object_key IN (
           SELECT object_key FROM usage_log_objects
           WHERE state = 'deleted' AND deleted_at <= ?
           ORDER BY deleted_at, object_key LIMIT ?
         )`,
      )
      .bind(objectLedgerCutoff, limit),
    session
      .prepare(
        `DELETE FROM operational_cost_hourly
         WHERE complete = 1 AND hour_key < ?`,
      )
      .bind(historyHourCutoff),
    session
      .prepare("DELETE FROM operational_counter_hourly WHERE hour_key < ?")
      .bind(historyHourCutoff),
    session
      .prepare("DELETE FROM container_activity_segments WHERE billed_until_at < ?")
      .bind(historyCutoff),
  ]);

  return {
    deletedObjects,
    purgedObjectLedgers: changes(purged[0]),
    purgedCostHours: changes(purged[1]),
    purgedActivitySegments: changes(purged[3]),
  };
}
