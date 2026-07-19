import { z } from "zod";
import type { ParsedTraceEvents } from "./usage-log-parser";

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hourSchema = z
  .object({
    hourKey: nonnegativeInteger,
    invocationCount: nonnegativeInteger,
    workerCpuMs: nonnegativeInteger,
    handlerInvocationCount: nonnegativeInteger,
    payloadSha256: hashSchema,
  })
  .strict()
  .refine((hour) => hour.handlerInvocationCount <= hour.invocationCount);
const inputSchema = z
  .object({
    objectKey: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\0")),
    etag: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !value.includes("\0")),
    byteSize: nonnegativeInteger,
    observedAt: nonnegativeInteger,
    parsed: z
      .object({
        invocationCount: nonnegativeInteger,
        decompressedBytes: nonnegativeInteger,
        payloadSha256: hashSchema,
        hours: z.array(hourSchema).max(256),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<number>();
    let invocationCount = 0;
    let previousHourKey = -1;
    for (const hour of input.parsed.hours) {
      if (seen.has(hour.hourKey)) {
        context.addIssue({ code: "custom", message: "Usage-log hour keys must be unique." });
      }
      if (hour.hourKey <= previousHourKey) {
        context.addIssue({ code: "custom", message: "Usage-log hours must be strictly ordered." });
      }
      seen.add(hour.hourKey);
      previousHourKey = hour.hourKey;
      invocationCount += hour.invocationCount;
    }
    if (
      !Number.isSafeInteger(invocationCount) ||
      invocationCount !== input.parsed.invocationCount
    ) {
      context.addIssue({ code: "custom", message: "Usage-log hourly counts must reconcile." });
    }
  });

const objectRowSchema = z
  .object({
    etag: z.string(),
    byte_size: nonnegativeInteger,
    parsed_sha256: hashSchema.nullable(),
    state: z.enum(["observed", "parsed", "sealed", "delete-pending", "deleted"]),
    stable_observation_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    circuit_open: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const storedHourSchema = z
  .object({
    hour_key: nonnegativeInteger,
    invocation_count: nonnegativeInteger,
    worker_cpu_ms: nonnegativeInteger,
    subset_invocation_count: nonnegativeInteger,
    payload_sha256: hashSchema,
  })
  .strict();

export interface RecordParsedUsageLogInput {
  readonly objectKey: string;
  readonly etag: string;
  readonly byteSize: number;
  readonly observedAt: number;
  readonly parsed: ParsedTraceEvents;
}

export type RecordParsedUsageLogResult =
  | {
      readonly kind: "recorded" | "replayed";
      readonly state: "parsed";
      readonly stableObservationCount: number;
      readonly circuitOpen: boolean;
    }
  | { readonly kind: "conflict"; readonly circuitOpen: true };

function hourJson(parsed: ParsedTraceEvents): string {
  return JSON.stringify(
    parsed.hours.map((hour) => ({
      hourKey: hour.hourKey,
      invocationCount: hour.invocationCount,
      workerCpuMs: hour.workerCpuMs,
      handlerInvocationCount: hour.handlerInvocationCount,
      payloadSha256: hour.payloadSha256,
    })),
  );
}

export async function recordParsedUsageLog(
  database: D1Database,
  rawInput: RecordParsedUsageLogInput,
): Promise<RecordParsedUsageLogResult> {
  const input = inputSchema.parse(rawInput);
  const hoursJson = hourJson(input.parsed);
  const firstHourKey = input.parsed.hours[0]?.hourKey ?? null;
  const lastHourKey = input.parsed.hours.at(-1)?.hourKey ?? null;
  const session = database.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `INSERT INTO usage_log_objects (
           object_key, etag, byte_size, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(object_key) DO NOTHING`,
      )
      .bind(input.objectKey, input.etag, input.byteSize, input.observedAt, input.observedAt),
    session
      .prepare(
        `UPDATE rollout_control
         SET circuit_open = 1,
             reason = CASE
               WHEN circuit_open = 1 THEN reason
               ELSE 'USAGE_LOG_OBJECT_CHANGED'
             END,
             opened_at = COALESCE(opened_at, ?)
         WHERE id = 1
           AND EXISTS (
             SELECT 1 FROM usage_log_objects
             WHERE object_key = ?
               AND (
                 etag <> ?
                 OR byte_size <> ?
                 OR (parsed_sha256 IS NOT NULL AND parsed_sha256 <> ?)
               )
           )`,
      )
      .bind(
        input.observedAt,
        input.objectKey,
        input.etag,
        input.byteSize,
        input.parsed.payloadSha256,
      ),
    session
      .prepare(
        `INSERT INTO usage_log_object_hours (
           object_key, hour_key, invocation_count, worker_cpu_ms,
           subset_invocation_count, payload_sha256
         )
         SELECT ?,
                json_extract(value, '$.hourKey'),
                json_extract(value, '$.invocationCount'),
                json_extract(value, '$.workerCpuMs'),
                json_extract(value, '$.handlerInvocationCount'),
                json_extract(value, '$.payloadSha256')
         FROM json_each(?)
         WHERE EXISTS (
           SELECT 1 FROM usage_log_objects
           WHERE object_key = ? AND etag = ? AND byte_size = ?
             AND (parsed_sha256 IS NULL OR parsed_sha256 = ?)
         )
         ON CONFLICT(object_key, hour_key) DO NOTHING`,
      )
      .bind(
        input.objectKey,
        hoursJson,
        input.objectKey,
        input.etag,
        input.byteSize,
        input.parsed.payloadSha256,
      ),
    session
      .prepare(
        `WITH incoming AS (
           SELECT json_extract(value, '$.hourKey') AS hour_key,
                  json_extract(value, '$.invocationCount') AS invocation_count,
                  json_extract(value, '$.workerCpuMs') AS worker_cpu_ms,
                  json_extract(value, '$.handlerInvocationCount') AS subset_invocation_count,
                  json_extract(value, '$.payloadSha256') AS payload_sha256
           FROM json_each(?)
         )
         UPDATE rollout_control
         SET circuit_open = 1,
             reason = CASE
               WHEN circuit_open = 1 THEN reason
               ELSE 'USAGE_LOG_OBJECT_CHANGED'
             END,
             opened_at = COALESCE(opened_at, ?)
         WHERE id = 1
           AND (
             EXISTS (
               SELECT 1 FROM incoming
               LEFT JOIN usage_log_object_hours AS stored
                 ON stored.object_key = ? AND stored.hour_key = incoming.hour_key
               WHERE stored.object_key IS NULL
                  OR stored.invocation_count <> incoming.invocation_count
                  OR stored.worker_cpu_ms <> incoming.worker_cpu_ms
                  OR stored.subset_invocation_count <> incoming.subset_invocation_count
                  OR stored.payload_sha256 <> incoming.payload_sha256
             )
             OR EXISTS (
               SELECT 1 FROM usage_log_object_hours AS stored
               WHERE stored.object_key = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM incoming WHERE incoming.hour_key = stored.hour_key
                 )
             )
           )`,
      )
      .bind(hoursJson, input.observedAt, input.objectKey, input.objectKey),
    session
      .prepare(
        `UPDATE usage_log_objects
         SET last_seen_at = max(last_seen_at, ?),
             stable_observation_count = stable_observation_count +
               CASE
                 WHEN parsed_sha256 IS NOT NULL AND ? > last_seen_at THEN 1
                 ELSE 0
               END,
             parsed_sha256 = ?,
             first_hour_key = ?,
             last_hour_key = ?,
             state = 'parsed'
         WHERE object_key = ? AND etag = ? AND byte_size = ?
           AND (parsed_sha256 IS NULL OR parsed_sha256 = ?)`,
      )
      .bind(
        input.observedAt,
        input.observedAt,
        input.parsed.payloadSha256,
        firstHourKey,
        lastHourKey,
        input.objectKey,
        input.etag,
        input.byteSize,
        input.parsed.payloadSha256,
      ),
    session
      .prepare(
        `SELECT objects.etag,
                objects.byte_size,
                objects.parsed_sha256,
                objects.state,
                objects.stable_observation_count,
                control.circuit_open
         FROM usage_log_objects AS objects
         CROSS JOIN rollout_control AS control
         WHERE objects.object_key = ? AND control.id = 1`,
      )
      .bind(input.objectKey),
    session
      .prepare(
        `SELECT hour_key, invocation_count, worker_cpu_ms,
                subset_invocation_count, payload_sha256
         FROM usage_log_object_hours
         WHERE object_key = ?
         ORDER BY hour_key`,
      )
      .bind(input.objectKey),
  ]);

  const object = objectRowSchema.safeParse(results[5]?.results[0]);
  const storedHours = z.array(storedHourSchema).safeParse(results[6]?.results ?? []);
  if (!object.success || !storedHours.success) {
    throw new Error("Usage-log ledger state is unavailable or malformed.");
  }
  const hoursMatch =
    storedHours.data.length === input.parsed.hours.length &&
    storedHours.data.every((stored, index) => {
      const expected = input.parsed.hours[index];
      return (
        expected !== undefined &&
        stored.hour_key === expected.hourKey &&
        stored.invocation_count === expected.invocationCount &&
        stored.worker_cpu_ms === expected.workerCpuMs &&
        stored.subset_invocation_count === expected.handlerInvocationCount &&
        stored.payload_sha256 === expected.payloadSha256
      );
    });
  const objectMatches =
    object.data.etag === input.etag &&
    object.data.byte_size === input.byteSize &&
    object.data.parsed_sha256 === input.parsed.payloadSha256;
  if (!objectMatches || !hoursMatch) {
    if (object.data.circuit_open !== 1) {
      throw new Error("Usage-log ledger conflict did not open the circuit.");
    }
    return { kind: "conflict", circuitOpen: true };
  }
  if (object.data.state !== "parsed") {
    throw new Error("Usage-log ledger did not reach parsed state.");
  }
  return {
    kind: results[0]?.meta.changes === 1 ? "recorded" : "replayed",
    state: "parsed",
    stableObservationCount: object.data.stable_observation_count,
    circuitOpen: object.data.circuit_open === 1,
  };
}
