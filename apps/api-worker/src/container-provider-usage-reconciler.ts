import { z } from "zod";
import type { ContainerUsageHourResult } from "./container-provider-usage";

const INT64_MAXIMUM = 9_223_372_036_854_775_807n;
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const epochSchema = z.string().regex(/^[0-9a-f]{32}$/);
const int64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) => BigInt(value) <= INT64_MAXIMUM,
    "Provider integer exceeds signed 64-bit storage.",
  );
const regionUsageSchema = z
  .object({
    region: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    transmittedBytes: int64StringSchema,
  })
  .strict();
const inputSchema = z
  .object({
    hourKey: nonnegativeInteger,
    observedAt: nonnegativeInteger,
    usage: z
      .object({
        cpuMicroseconds: int64StringSchema,
        allocatedMemoryByteMilliseconds: int64StringSchema,
        allocatedDiskByteMilliseconds: int64StringSchema,
        transmittedBytes: int64StringSchema,
        transmittedBytesByRegion: z.array(regionUsageSchema).max(32),
      })
      .strict()
      .superRefine((usage, context) => {
        let total = 0n;
        let previousRegion: string | null = null;
        for (const entry of usage.transmittedBytesByRegion) {
          if (previousRegion !== null && entry.region <= previousRegion) {
            context.addIssue({
              code: "custom",
              message: "Provider regions must be strictly ordered.",
            });
          }
          previousRegion = entry.region;
          total += BigInt(entry.transmittedBytes);
        }
        if (total > INT64_MAXIMUM || total.toString() !== usage.transmittedBytes) {
          context.addIssue({
            code: "custom",
            message: "Regional transmission totals must reconcile.",
          });
        }
      }),
    liveCostModelSha256: hashSchema,
    providerUsageSchemaSha256: hashSchema,
    releaseReportSha256: hashSchema,
  })
  .strict();
const controlSchema = z
  .object({
    cost_accounting_epoch: epochSchema,
    circuit_open: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const storedSchema = z
  .object({
    live_cost_model_sha256: hashSchema,
    provider_usage_schema_sha256: hashSchema,
    release_report_sha256: hashSchema,
    cpu_microseconds: int64StringSchema,
    memory_byte_milliseconds: int64StringSchema,
    disk_byte_milliseconds: int64StringSchema,
    transmitted_bytes: int64StringSchema,
    provider_container_usage_complete: z.union([z.literal(0), z.literal(1)]),
    provider_usage_complete: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const storedRegionSchema = z
  .object({
    region: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    transmitted_bytes: int64StringSchema,
  })
  .strict();

export interface ReconcileContainerProviderHourInput {
  readonly hourKey: number;
  readonly observedAt: number;
  readonly usage: ContainerUsageHourResult;
  readonly liveCostModelSha256: string;
  readonly providerUsageSchemaSha256: string;
  readonly releaseReportSha256: string;
}

export type ReconcileContainerProviderHourResult =
  | ({
      readonly kind: "verified";
      readonly providerUsageComplete: boolean;
      readonly circuitOpen: boolean;
    } & ContainerUsageHourResult)
  | {
      readonly kind: "incomplete";
      readonly reason: "provider-delay";
      readonly circuitOpen: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly reason: "PROVIDER_CONTAINER_USAGE_MISMATCH";
      readonly circuitOpen: true;
    };

async function openContainerProviderCircuit(
  database: D1Database,
  observedAt: number,
): Promise<Extract<ReconcileContainerProviderHourResult, { kind: "conflict" }>> {
  await database
    .withSession("first-primary")
    .prepare(
      `UPDATE rollout_control
       SET circuit_open = 1,
           reason = CASE
             WHEN circuit_open = 1 THEN reason
             ELSE 'PROVIDER_CONTAINER_USAGE_MISMATCH'
           END,
           opened_at = COALESCE(opened_at, ?)
       WHERE id = 1`,
    )
    .bind(observedAt)
    .run();
  return {
    kind: "conflict",
    reason: "PROVIDER_CONTAINER_USAGE_MISMATCH",
    circuitOpen: true,
  };
}

export async function reconcileContainerProviderHour(
  database: D1Database,
  rawInput: ReconcileContainerProviderHourInput,
): Promise<ReconcileContainerProviderHourResult> {
  const input = inputSchema.parse(rawInput);
  const hourEnd = (input.hourKey + 1) * 3_600_000;
  const providerReadyAt = hourEnd + 30 * 60_000;
  if (!Number.isSafeInteger(hourEnd) || !Number.isSafeInteger(providerReadyAt)) {
    throw new RangeError("Container provider hour exceeded its timestamp bound.");
  }
  const session = database.withSession("first-primary");
  const control = controlSchema.parse(
    await session
      .prepare("SELECT cost_accounting_epoch, circuit_open FROM rollout_control WHERE id = 1")
      .first(),
  );
  if (input.observedAt < providerReadyAt) {
    return {
      kind: "incomplete",
      reason: "provider-delay",
      circuitOpen: control.circuit_open === 1,
    };
  }
  const regionsJson = JSON.stringify(input.usage.transmittedBytesByRegion);

  const results = await session.batch([
    session
      .prepare(
        `INSERT INTO operational_cost_hourly (
           accounting_epoch, hour_key, live_cost_model_sha256,
           provider_usage_schema_sha256, release_report_sha256, updated_at
         )
         SELECT cost_accounting_epoch, ?, ?, ?, ?, ?
         FROM rollout_control
         WHERE id = 1 AND cost_accounting_epoch = ?
         ON CONFLICT(accounting_epoch, hour_key) DO NOTHING`,
      )
      .bind(
        input.hourKey,
        input.liveCostModelSha256,
        input.providerUsageSchemaSha256,
        input.releaseReportSha256,
        input.observedAt,
        control.cost_accounting_epoch,
      ),
    session
      .prepare(
        `INSERT INTO container_provider_egress_hourly (
           accounting_epoch, hour_key, region, transmitted_bytes
         )
         SELECT ?, ?,
                json_extract(value, '$.region'),
                CAST(json_extract(value, '$.transmittedBytes') AS INTEGER)
         FROM json_each(?)
         WHERE EXISTS (
           SELECT 1 FROM operational_cost_hourly
           WHERE accounting_epoch = ? AND hour_key = ?
             AND live_cost_model_sha256 = ?
             AND provider_usage_schema_sha256 = ?
             AND release_report_sha256 = ?
             AND provider_container_usage_complete = 0
         )
         ON CONFLICT(accounting_epoch, hour_key, region) DO NOTHING`,
      )
      .bind(
        control.cost_accounting_epoch,
        input.hourKey,
        regionsJson,
        control.cost_accounting_epoch,
        input.hourKey,
        input.liveCostModelSha256,
        input.providerUsageSchemaSha256,
        input.releaseReportSha256,
      ),
    session
      .prepare(
        `UPDATE operational_cost_hourly
         SET provider_container_cpu_microseconds = CAST(? AS INTEGER),
             provider_container_allocated_memory_byte_milliseconds = CAST(? AS INTEGER),
             provider_container_allocated_disk_byte_milliseconds = CAST(? AS INTEGER),
             provider_container_tx_bytes = CAST(? AS INTEGER),
             provider_container_usage_complete = 1,
             provider_usage_complete = CASE
               WHEN provider_worker_usage_complete = 1
                AND analytics_engine_usage_complete = 1 THEN 1
               ELSE 0
             END,
             updated_at = ?
         WHERE accounting_epoch = ? AND hour_key = ?
           AND live_cost_model_sha256 = ?
           AND provider_usage_schema_sha256 = ?
           AND release_report_sha256 = ?
           AND (
             provider_container_usage_complete = 0
             OR (
               CAST(provider_container_cpu_microseconds AS TEXT) = ?
               AND CAST(provider_container_allocated_memory_byte_milliseconds AS TEXT) = ?
               AND CAST(provider_container_allocated_disk_byte_milliseconds AS TEXT) = ?
               AND CAST(provider_container_tx_bytes AS TEXT) = ?
             )
           )
           AND (
             SELECT COUNT(*) FROM container_provider_egress_hourly
             WHERE accounting_epoch = ? AND hour_key = ?
           ) = json_array_length(?)
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(?) AS requested
             LEFT JOIN container_provider_egress_hourly AS stored
               ON stored.accounting_epoch = ? AND stored.hour_key = ?
              AND stored.region = json_extract(requested.value, '$.region')
             WHERE stored.region IS NULL
                OR CAST(stored.transmitted_bytes AS TEXT) <>
                   json_extract(requested.value, '$.transmittedBytes')
           )
           AND NOT EXISTS (
             SELECT 1
             FROM container_provider_egress_hourly AS stored
             WHERE stored.accounting_epoch = ? AND stored.hour_key = ?
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?) AS requested
                 WHERE json_extract(requested.value, '$.region') = stored.region
               )
           )`,
      )
      .bind(
        input.usage.cpuMicroseconds,
        input.usage.allocatedMemoryByteMilliseconds,
        input.usage.allocatedDiskByteMilliseconds,
        input.usage.transmittedBytes,
        input.observedAt,
        control.cost_accounting_epoch,
        input.hourKey,
        input.liveCostModelSha256,
        input.providerUsageSchemaSha256,
        input.releaseReportSha256,
        input.usage.cpuMicroseconds,
        input.usage.allocatedMemoryByteMilliseconds,
        input.usage.allocatedDiskByteMilliseconds,
        input.usage.transmittedBytes,
        control.cost_accounting_epoch,
        input.hourKey,
        regionsJson,
        regionsJson,
        control.cost_accounting_epoch,
        input.hourKey,
        control.cost_accounting_epoch,
        input.hourKey,
        regionsJson,
      ),
    session
      .prepare(
        `SELECT live_cost_model_sha256, provider_usage_schema_sha256, release_report_sha256,
                CAST(provider_container_cpu_microseconds AS TEXT) AS cpu_microseconds,
                CAST(provider_container_allocated_memory_byte_milliseconds AS TEXT)
                  AS memory_byte_milliseconds,
                CAST(provider_container_allocated_disk_byte_milliseconds AS TEXT)
                  AS disk_byte_milliseconds,
                CAST(provider_container_tx_bytes AS TEXT) AS transmitted_bytes,
                provider_container_usage_complete, provider_usage_complete
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
      .bind(control.cost_accounting_epoch, input.hourKey),
    session
      .prepare(
        `SELECT region, CAST(transmitted_bytes AS TEXT) AS transmitted_bytes
         FROM container_provider_egress_hourly
         WHERE accounting_epoch = ? AND hour_key = ?
         ORDER BY region`,
      )
      .bind(control.cost_accounting_epoch, input.hourKey),
  ]);
  const stored = storedSchema.safeParse(results[3]?.results[0]);
  const storedRegions = z
    .array(storedRegionSchema)
    .max(32)
    .safeParse(results[4]?.results ?? []);
  const regionsMatch =
    storedRegions.success &&
    storedRegions.data.length === input.usage.transmittedBytesByRegion.length &&
    storedRegions.data.every((storedRegion, index) => {
      const expected = input.usage.transmittedBytesByRegion[index];
      return (
        expected !== undefined &&
        storedRegion.region === expected.region &&
        storedRegion.transmitted_bytes === expected.transmittedBytes
      );
    });
  const matches =
    stored.success &&
    regionsMatch &&
    stored.data.live_cost_model_sha256 === input.liveCostModelSha256 &&
    stored.data.provider_usage_schema_sha256 === input.providerUsageSchemaSha256 &&
    stored.data.release_report_sha256 === input.releaseReportSha256 &&
    stored.data.cpu_microseconds === input.usage.cpuMicroseconds &&
    stored.data.memory_byte_milliseconds === input.usage.allocatedMemoryByteMilliseconds &&
    stored.data.disk_byte_milliseconds === input.usage.allocatedDiskByteMilliseconds &&
    stored.data.transmitted_bytes === input.usage.transmittedBytes &&
    stored.data.provider_container_usage_complete === 1;
  if (!matches) return openContainerProviderCircuit(database, input.observedAt);

  return {
    kind: "verified",
    ...input.usage,
    providerUsageComplete: stored.data.provider_usage_complete === 1,
    circuitOpen: control.circuit_open === 1,
  };
}
