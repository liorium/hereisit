import { z } from "zod";
import type { StreamingDigest } from "./usage-log-parser";

const PAGE_SIZE = 128;
const MAXIMUM_OBJECTS_PER_HOUR = 8_192;
const MINIMUM_MATCH_SPACING_MILLISECONDS = 10 * 60_000;

const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const epochSchema = z.string().regex(/^[0-9a-f]{32}$/);
const objectRowSchema = z
  .object({
    object_key: z.string().min(1).max(1_024),
    etag: z.string().min(1).max(256),
    byte_size: nonnegativeInteger,
    parsed_sha256: hashSchema,
    payload_sha256: hashSchema,
  })
  .strict();
const controlSchema = z
  .object({
    cost_accounting_epoch: epochSchema,
    circuit_open: z.union([z.literal(0), z.literal(1)]),
    reason: z.string().nullable(),
    duplicate_payload: z.union([z.literal(0), z.literal(1)]),
    current_object_count: nonnegativeInteger,
    current_object_bytes: nonnegativeInteger,
  })
  .strict();
const observationSchema = z
  .object({
    object_set_sha256: hashSchema,
    object_count: nonnegativeInteger,
    object_bytes: nonnegativeInteger,
    matching_observation_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export interface ObserveUsageLogHourInput {
  readonly hourKey: number;
  readonly observedAt: number;
  readonly createDigest: () => StreamingDigest;
}

export type ObserveUsageLogHourResult =
  | {
      readonly kind: "observed" | "stable";
      readonly matchingObservationCount: number;
      readonly objectCount: number;
      readonly objectBytes: number;
      readonly circuitOpen: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly objectCount: number;
      readonly objectBytes: number;
      readonly circuitOpen: true;
    };

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} exceeded its bound.`);
  return value;
}

async function openInvalidObservationCircuit(
  database: D1Database,
  observedAt: number,
): Promise<void> {
  await database
    .withSession("first-primary")
    .prepare(
      `UPDATE rollout_control
       SET circuit_open = 1,
           reason = CASE WHEN circuit_open = 1 THEN reason ELSE 'USAGE_LOG_IMPORT_INVALID' END,
           opened_at = COALESCE(opened_at, ?)
       WHERE id = 1`,
    )
    .bind(observedAt)
    .run();
}

export async function observeUsageLogHour(
  database: D1Database,
  input: ObserveUsageLogHourInput,
): Promise<ObserveUsageLogHourResult> {
  const hourKey = nonnegativeInteger.parse(input.hourKey);
  const observedAt = nonnegativeInteger.parse(input.observedAt);
  const session = database.withSession("first-primary");
  const epochRow = await session
    .prepare("SELECT cost_accounting_epoch FROM rollout_control WHERE id = 1")
    .first();
  const epoch = epochSchema.parse(epochRow?.cost_accounting_epoch);
  const digest = input.createDigest();
  const encoder = new TextEncoder();
  let cursor: string | null = null;
  let objectCount = 0;
  let objectBytes = 0;

  for (;;) {
    const page = await session
      .prepare(
        `SELECT objects.object_key, objects.etag, objects.byte_size,
                objects.parsed_sha256, hours.payload_sha256
         FROM usage_log_object_hours AS hours
         JOIN usage_log_objects AS objects USING (object_key)
         WHERE hours.hour_key = ?
           AND (? IS NULL OR objects.object_key > ?)
         ORDER BY objects.object_key
         LIMIT ?`,
      )
      .bind(hourKey, cursor, cursor, PAGE_SIZE)
      .all();
    const rows = z.array(objectRowSchema).parse(page.results);
    if (rows.length === 0) break;
    for (const row of rows) {
      objectCount = checkedAdd(objectCount, 1, "Usage-log object count");
      objectBytes = checkedAdd(objectBytes, row.byte_size, "Usage-log object bytes");
      if (objectCount > MAXIMUM_OBJECTS_PER_HOUR) {
        await openInvalidObservationCircuit(database, observedAt);
        return { kind: "conflict", objectCount, objectBytes, circuitOpen: true };
      }
      await digest.update(
        encoder.encode(
          `${JSON.stringify([
            row.object_key,
            row.etag,
            row.byte_size,
            row.parsed_sha256,
            row.payload_sha256,
          ])}\n`,
        ),
      );
      cursor = row.object_key;
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const objectSetSha256 = await digest.finish();
  const results = await session.batch([
    session
      .prepare(
        `UPDATE rollout_control
         SET circuit_open = 1,
             reason = CASE WHEN circuit_open = 1 THEN reason ELSE 'USAGE_LOG_DUPLICATE_PAYLOAD' END,
             opened_at = COALESCE(opened_at, ?)
         WHERE id = 1
           AND EXISTS (
             SELECT 1
             FROM usage_log_object_hours
             WHERE hour_key = ?
             GROUP BY payload_sha256
             HAVING COUNT(*) > 1
           )`,
      )
      .bind(observedAt, hourKey),
    session
      .prepare(
        `INSERT INTO usage_log_hour_observations (
           accounting_epoch, hour_key, object_set_sha256, object_count, object_bytes,
           first_observed_at, last_observed_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
         FROM rollout_control
         WHERE id = 1 AND cost_accounting_epoch = ?
           AND (
             SELECT COUNT(*) FROM usage_log_object_hours WHERE hour_key = ?
           ) = ?
           AND COALESCE((
             SELECT SUM(objects.byte_size)
             FROM usage_log_object_hours AS hours
             JOIN usage_log_objects AS objects USING (object_key)
             WHERE hours.hour_key = ?
           ), 0) = ?
           AND NOT EXISTS (
             SELECT 1 FROM usage_log_object_hours
             WHERE hour_key = ?
             GROUP BY payload_sha256
             HAVING COUNT(*) > 1
           )
         ON CONFLICT(accounting_epoch, hour_key) DO NOTHING`,
      )
      .bind(
        epoch,
        hourKey,
        objectSetSha256,
        objectCount,
        objectBytes,
        observedAt,
        observedAt,
        epoch,
        hourKey,
        objectCount,
        hourKey,
        objectBytes,
        hourKey,
      ),
    session
      .prepare(
        `UPDATE usage_log_hour_observations
         SET matching_observation_count = matching_observation_count + 1,
             last_observed_at = ?
         WHERE accounting_epoch = ? AND hour_key = ?
           AND object_set_sha256 = ? AND object_count = ? AND object_bytes = ?
           AND ? >= last_observed_at + ?
           AND (
             SELECT COUNT(*) FROM usage_log_object_hours WHERE hour_key = ?
           ) = ?
           AND COALESCE((
             SELECT SUM(objects.byte_size)
             FROM usage_log_object_hours AS hours
             JOIN usage_log_objects AS objects USING (object_key)
             WHERE hours.hour_key = ?
           ), 0) = ?`,
      )
      .bind(
        observedAt,
        epoch,
        hourKey,
        objectSetSha256,
        objectCount,
        objectBytes,
        observedAt,
        MINIMUM_MATCH_SPACING_MILLISECONDS,
        hourKey,
        objectCount,
        hourKey,
        objectBytes,
      ),
    session
      .prepare(
        `UPDATE rollout_control
         SET circuit_open = 1,
             reason = CASE WHEN circuit_open = 1 THEN reason ELSE 'USAGE_LOG_OBJECT_SET_CHANGED' END,
             opened_at = COALESCE(opened_at, ?)
         WHERE id = 1
           AND (
             EXISTS (
               SELECT 1 FROM usage_log_hour_observations
               WHERE accounting_epoch = ? AND hour_key = ?
                 AND (
                   object_set_sha256 <> ? OR object_count <> ? OR object_bytes <> ?
                 )
             )
             OR (
               SELECT COUNT(*) FROM usage_log_object_hours WHERE hour_key = ?
             ) <> ?
             OR COALESCE((
               SELECT SUM(objects.byte_size)
               FROM usage_log_object_hours AS hours
               JOIN usage_log_objects AS objects USING (object_key)
               WHERE hours.hour_key = ?
             ), 0) <> ?
           )`,
      )
      .bind(
        observedAt,
        epoch,
        hourKey,
        objectSetSha256,
        objectCount,
        objectBytes,
        hourKey,
        objectCount,
        hourKey,
        objectBytes,
      ),
    session
      .prepare(
        `SELECT control.cost_accounting_epoch, control.circuit_open, control.reason,
                EXISTS (
                  SELECT 1 FROM usage_log_object_hours
                  WHERE hour_key = ?
                  GROUP BY payload_sha256
                  HAVING COUNT(*) > 1
                ) AS duplicate_payload
                ,(
                  SELECT COUNT(*) FROM usage_log_object_hours WHERE hour_key = ?
                ) AS current_object_count
                ,COALESCE((
                  SELECT SUM(objects.byte_size)
                  FROM usage_log_object_hours AS hours
                  JOIN usage_log_objects AS objects USING (object_key)
                  WHERE hours.hour_key = ?
                ), 0) AS current_object_bytes
         FROM rollout_control AS control
         WHERE control.id = 1`,
      )
      .bind(hourKey, hourKey, hourKey),
    session
      .prepare(
        `SELECT object_set_sha256, object_count, object_bytes, matching_observation_count
         FROM usage_log_hour_observations
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
      .bind(epoch, hourKey),
  ]);

  const control = controlSchema.parse(results[4]?.results[0]);
  if (control.cost_accounting_epoch !== epoch) {
    throw new Error("Usage-log accounting epoch changed during observation.");
  }
  const observation = observationSchema.safeParse(results[5]?.results[0]);
  const matches =
    observation.success &&
    observation.data.object_set_sha256 === objectSetSha256 &&
    observation.data.object_count === objectCount &&
    observation.data.object_bytes === objectBytes &&
    control.current_object_count === objectCount &&
    control.current_object_bytes === objectBytes;
  if (control.duplicate_payload === 1 || !matches) {
    if (control.circuit_open !== 1) {
      throw new Error("Usage-log observation conflict did not open the circuit.");
    }
    return { kind: "conflict", objectCount, objectBytes, circuitOpen: true };
  }
  return {
    kind: observation.data.matching_observation_count >= 2 ? "stable" : "observed",
    matchingObservationCount: observation.data.matching_observation_count,
    objectCount,
    objectBytes,
    circuitOpen: control.circuit_open === 1,
  };
}
