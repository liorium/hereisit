import { z } from "zod";
import type { LiveCostModelV1 } from "./env";
import { calculateHourlyCosts, type HourlyCostUsage } from "./hourly-cost";

const INT64_MAXIMUM = 9_223_372_036_854_775_807n;
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const epochSchema = z.string().regex(/^[0-9a-f]{32}$/);
const int64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= INT64_MAXIMUM);
const controlSchema = z
  .object({
    cost_accounting_epoch: epochSchema,
    cost_accounting_started_at: nonnegativeInteger,
    last_sealed_hour_key: nonnegativeInteger.nullable(),
    circuit_open: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const rawCostRowSchema = z
  .object({
    live_cost_model_sha256: hashSchema,
    provider_usage_schema_sha256: hashSchema,
    release_report_sha256: hashSchema,
    provider_usage_complete: z.union([z.literal(0), z.literal(1)]),
    complete: z.union([z.literal(0), z.literal(1)]),
    provider_worker_requests: int64StringSchema,
    provider_worker_cpu_ms: int64StringSchema,
    provider_container_cpu_microseconds: int64StringSchema,
    provider_container_allocated_memory_byte_milliseconds: int64StringSchema,
    provider_container_allocated_disk_byte_milliseconds: int64StringSchema,
    provider_container_tx_bytes: int64StringSchema,
    analytics_engine_data_points: int64StringSchema,
    analytics_engine_read_queries: int64StringSchema,
    workers_logpush_events: int64StringSchema,
    durable_object_active_milliseconds: int64StringSchema,
    durable_object_requests: int64StringSchema,
    durable_object_storage_byte_milliseconds: int64StringSchema,
    queue_operations: int64StringSchema,
    d1_rows_read: int64StringSchema,
    d1_rows_written: int64StringSchema,
    d1_storage_byte_milliseconds: int64StringSchema,
    r2_class_a_operations: int64StringSchema,
    r2_class_b_operations: int64StringSchema,
    r2_storage_byte_milliseconds: int64StringSchema,
    observability_log_events: int64StringSchema,
  })
  .strict();
const egressRowSchema = z
  .object({
    region: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    transmitted_bytes: int64StringSchema,
  })
  .strict();
const sealedStateSchema = z
  .object({
    complete: z.literal(1),
    worker_cost_microusd: int64StringSchema,
    container_cost_microusd: int64StringSchema,
    durable_object_cost_microusd: int64StringSchema,
    queue_cost_microusd: int64StringSchema,
    d1_cost_microusd: int64StringSchema,
    r2_cost_microusd: int64StringSchema,
    analytics_engine_cost_microusd: int64StringSchema,
    observability_cost_microusd: int64StringSchema,
    fixed_cost_microusd: int64StringSchema,
    total_cost_microusd: int64StringSchema,
    last_sealed_hour_key: nonnegativeInteger,
    circuit_open: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export interface SealNextHourlyCostInput {
  readonly now: number;
  readonly model: LiveCostModelV1;
  readonly liveCostModelSha256: string;
  readonly providerUsageSchemaSha256: string;
  readonly releaseReportSha256: string;
}

export type SealNextHourlyCostResult =
  | {
      readonly kind: "not-due" | "incomplete";
      readonly hourKey: number;
      readonly circuitOpen: boolean;
    }
  | {
      readonly kind: "sealed";
      readonly hourKey: number;
      readonly totalCostMicrousd: string;
      readonly circuitOpen: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly hourKey: number;
      readonly reason:
        | "COST_ACCOUNTING_INCOMPLETE"
        | "COST_ACCOUNTING_HASH_MISMATCH"
        | "COST_ACCOUNTING_EGRESS_MISMATCH"
        | "COST_MODEL_INVALID"
        | "COST_SEAL_RACE";
      readonly circuitOpen: true;
    };

async function openCostCircuit(
  database: D1Database,
  now: number,
  hourKey: number,
  reason: Extract<SealNextHourlyCostResult, { kind: "conflict" }>["reason"],
): Promise<Extract<SealNextHourlyCostResult, { kind: "conflict" }>> {
  await database
    .withSession("first-primary")
    .prepare(
      `UPDATE rollout_control
       SET circuit_open = 1,
           reason = CASE WHEN circuit_open = 1 THEN reason ELSE ? END,
           opened_at = COALESCE(opened_at, ?)
       WHERE id = 1`,
    )
    .bind(reason, now)
    .run();
  return { kind: "conflict", hourKey, reason, circuitOpen: true };
}

function validateInput(input: SealNextHourlyCostInput): void {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("Hourly cost evaluation time is invalid.");
  }
  for (const [label, value] of [
    ["live cost model", input.liveCostModelSha256],
    ["provider usage schema", input.providerUsageSchemaSha256],
    ["release report", input.releaseReportSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} hash is invalid.`);
  }
}

function usageFromRow(
  row: z.infer<typeof rawCostRowSchema>,
  egressRows: readonly z.infer<typeof egressRowSchema>[],
): HourlyCostUsage {
  return {
    workerRequests: row.provider_worker_requests,
    workerCpuMs: row.provider_worker_cpu_ms,
    containerCpuMicroseconds: row.provider_container_cpu_microseconds,
    containerAllocatedMemoryByteMilliseconds:
      row.provider_container_allocated_memory_byte_milliseconds,
    containerAllocatedDiskByteMilliseconds: row.provider_container_allocated_disk_byte_milliseconds,
    containerTransmittedBytesByRegion: egressRows.map((entry) => ({
      region: entry.region,
      transmittedBytes: entry.transmitted_bytes,
    })),
    durableObjectActiveMilliseconds: row.durable_object_active_milliseconds,
    durableObjectRequests: row.durable_object_requests,
    durableObjectStorageByteMilliseconds: row.durable_object_storage_byte_milliseconds,
    queueOperations: row.queue_operations,
    d1RowsRead: row.d1_rows_read,
    d1RowsWritten: row.d1_rows_written,
    d1StorageByteMilliseconds: row.d1_storage_byte_milliseconds,
    r2ClassAOperations: row.r2_class_a_operations,
    r2ClassBOperations: row.r2_class_b_operations,
    r2StorageByteMilliseconds: row.r2_storage_byte_milliseconds,
    analyticsEngineDataPoints: row.analytics_engine_data_points,
    analyticsEngineReadQueries: row.analytics_engine_read_queries,
    observabilityLogEvents: row.observability_log_events,
    workersLogpushEvents: row.workers_logpush_events,
  };
}

export async function sealNextHourlyCost(
  database: D1Database,
  input: SealNextHourlyCostInput,
): Promise<SealNextHourlyCostResult> {
  validateInput(input);
  const session = database.withSession("first-primary");
  const control = controlSchema.parse(
    await session
      .prepare(
        `SELECT cost_accounting_epoch, cost_accounting_started_at,
                last_sealed_hour_key, circuit_open
         FROM rollout_control WHERE id = 1`,
      )
      .first(),
  );
  const firstHourKey = Math.ceil(control.cost_accounting_started_at / 3_600_000);
  const hourKey =
    control.last_sealed_hour_key === null ? firstHourKey : control.last_sealed_hour_key + 1;
  const hourEnd = (hourKey + 1) * 3_600_000;
  const earliestSealAt = hourEnd + 40 * 60_000;
  const completenessDeadline = hourEnd + 60 * 60_000;
  if (
    !Number.isSafeInteger(hourKey) ||
    !Number.isSafeInteger(hourEnd) ||
    !Number.isSafeInteger(earliestSealAt) ||
    !Number.isSafeInteger(completenessDeadline)
  ) {
    throw new RangeError("Hourly cost key exceeded its timestamp bound.");
  }
  if (input.now < earliestSealAt) {
    return { kind: "not-due", hourKey, circuitOpen: control.circuit_open === 1 };
  }

  const rawRow = await session
    .prepare(
      `SELECT live_cost_model_sha256, provider_usage_schema_sha256, release_report_sha256,
              provider_usage_complete, complete,
              CAST(provider_worker_requests AS TEXT) AS provider_worker_requests,
              CAST(provider_worker_cpu_ms AS TEXT) AS provider_worker_cpu_ms,
              CAST(provider_container_cpu_microseconds AS TEXT)
                AS provider_container_cpu_microseconds,
              CAST(provider_container_allocated_memory_byte_milliseconds AS TEXT)
                AS provider_container_allocated_memory_byte_milliseconds,
              CAST(provider_container_allocated_disk_byte_milliseconds AS TEXT)
                AS provider_container_allocated_disk_byte_milliseconds,
              CAST(provider_container_tx_bytes AS TEXT) AS provider_container_tx_bytes,
              CAST(analytics_engine_data_points AS TEXT) AS analytics_engine_data_points,
              CAST(analytics_engine_read_queries AS TEXT) AS analytics_engine_read_queries,
              CAST(workers_logpush_events AS TEXT) AS workers_logpush_events,
              CAST(durable_object_active_milliseconds AS TEXT)
                AS durable_object_active_milliseconds,
              CAST(durable_object_requests AS TEXT) AS durable_object_requests,
              CAST(durable_object_storage_byte_milliseconds AS TEXT)
                AS durable_object_storage_byte_milliseconds,
              CAST(queue_operations AS TEXT) AS queue_operations,
              CAST(d1_rows_read AS TEXT) AS d1_rows_read,
              CAST(d1_rows_written AS TEXT) AS d1_rows_written,
              CAST(d1_storage_byte_milliseconds AS TEXT) AS d1_storage_byte_milliseconds,
              CAST(r2_class_a_operations AS TEXT) AS r2_class_a_operations,
              CAST(r2_class_b_operations AS TEXT) AS r2_class_b_operations,
              CAST(r2_storage_byte_milliseconds AS TEXT) AS r2_storage_byte_milliseconds,
              CAST(observability_log_events AS TEXT) AS observability_log_events
       FROM operational_cost_hourly
       WHERE accounting_epoch = ? AND hour_key = ?`,
    )
    .bind(control.cost_accounting_epoch, hourKey)
    .first();
  const row = rawCostRowSchema.safeParse(rawRow);
  if (!row.success || row.data.provider_usage_complete !== 1) {
    if (input.now >= completenessDeadline) {
      return openCostCircuit(database, input.now, hourKey, "COST_ACCOUNTING_INCOMPLETE");
    }
    return { kind: "incomplete", hourKey, circuitOpen: control.circuit_open === 1 };
  }
  if (
    row.data.live_cost_model_sha256 !== input.liveCostModelSha256 ||
    row.data.provider_usage_schema_sha256 !== input.providerUsageSchemaSha256 ||
    row.data.release_report_sha256 !== input.releaseReportSha256
  ) {
    return openCostCircuit(database, input.now, hourKey, "COST_ACCOUNTING_HASH_MISMATCH");
  }
  const egressResult = await session
    .prepare(
      `SELECT region, CAST(transmitted_bytes AS TEXT) AS transmitted_bytes
       FROM container_provider_egress_hourly
       WHERE accounting_epoch = ? AND hour_key = ? ORDER BY region`,
    )
    .bind(control.cost_accounting_epoch, hourKey)
    .all();
  const egressRows = z.array(egressRowSchema).max(32).parse(egressResult.results);
  const egressTotal = egressRows.reduce((sum, entry) => sum + BigInt(entry.transmitted_bytes), 0n);
  if (egressTotal.toString() !== row.data.provider_container_tx_bytes) {
    return openCostCircuit(database, input.now, hourKey, "COST_ACCOUNTING_EGRESS_MISMATCH");
  }
  const usage = usageFromRow(row.data, egressRows);
  let costs: ReturnType<typeof calculateHourlyCosts>;
  try {
    costs = calculateHourlyCosts(input.model, usage);
  } catch {
    return openCostCircuit(database, input.now, hourKey, "COST_MODEL_INVALID");
  }
  const egressJson = JSON.stringify(
    egressRows.map((entry) => ({
      region: entry.region,
      transmittedBytes: entry.transmitted_bytes,
    })),
  );
  const results = await session.batch([
    session
      .prepare(
        `UPDATE operational_cost_hourly
         SET worker_cost_microusd = CAST(? AS INTEGER),
             container_cost_microusd = CAST(? AS INTEGER),
             durable_object_cost_microusd = CAST(? AS INTEGER),
             queue_cost_microusd = CAST(? AS INTEGER),
             d1_cost_microusd = CAST(? AS INTEGER),
             r2_cost_microusd = CAST(? AS INTEGER),
             analytics_engine_cost_microusd = CAST(? AS INTEGER),
             observability_cost_microusd = CAST(? AS INTEGER),
             fixed_cost_microusd = CAST(? AS INTEGER),
             total_cost_microusd = CAST(? AS INTEGER),
             complete = 1,
             updated_at = ?
         WHERE accounting_epoch = ? AND hour_key = ?
           AND live_cost_model_sha256 = ?
           AND provider_usage_schema_sha256 = ?
           AND release_report_sha256 = ?
           AND provider_usage_complete = 1
           AND CAST(provider_worker_requests AS TEXT) = ?
           AND CAST(provider_worker_cpu_ms AS TEXT) = ?
           AND CAST(provider_container_cpu_microseconds AS TEXT) = ?
           AND CAST(provider_container_allocated_memory_byte_milliseconds AS TEXT) = ?
           AND CAST(provider_container_allocated_disk_byte_milliseconds AS TEXT) = ?
           AND CAST(provider_container_tx_bytes AS TEXT) = ?
           AND CAST(analytics_engine_data_points AS TEXT) = ?
           AND CAST(analytics_engine_read_queries AS TEXT) = ?
           AND CAST(workers_logpush_events AS TEXT) = ?
           AND CAST(durable_object_active_milliseconds AS TEXT) = ?
           AND CAST(durable_object_requests AS TEXT) = ?
           AND CAST(durable_object_storage_byte_milliseconds AS TEXT) = ?
           AND CAST(queue_operations AS TEXT) = ?
           AND CAST(d1_rows_read AS TEXT) = ?
           AND CAST(d1_rows_written AS TEXT) = ?
           AND CAST(d1_storage_byte_milliseconds AS TEXT) = ?
           AND CAST(r2_class_a_operations AS TEXT) = ?
           AND CAST(r2_class_b_operations AS TEXT) = ?
           AND CAST(r2_storage_byte_milliseconds AS TEXT) = ?
           AND CAST(observability_log_events AS TEXT) = ?
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
           AND (
             complete = 0
             OR (
               CAST(worker_cost_microusd AS TEXT) = ?
               AND CAST(container_cost_microusd AS TEXT) = ?
               AND CAST(durable_object_cost_microusd AS TEXT) = ?
               AND CAST(queue_cost_microusd AS TEXT) = ?
               AND CAST(d1_cost_microusd AS TEXT) = ?
               AND CAST(r2_cost_microusd AS TEXT) = ?
               AND CAST(analytics_engine_cost_microusd AS TEXT) = ?
               AND CAST(observability_cost_microusd AS TEXT) = ?
               AND CAST(fixed_cost_microusd AS TEXT) = ?
               AND CAST(total_cost_microusd AS TEXT) = ?
             )
           )`,
      )
      .bind(
        costs.workerCostMicrousd,
        costs.containerCostMicrousd,
        costs.durableObjectCostMicrousd,
        costs.queueCostMicrousd,
        costs.d1CostMicrousd,
        costs.r2CostMicrousd,
        costs.analyticsEngineCostMicrousd,
        costs.observabilityCostMicrousd,
        costs.fixedCostMicrousd,
        costs.totalCostMicrousd,
        input.now,
        control.cost_accounting_epoch,
        hourKey,
        input.liveCostModelSha256,
        input.providerUsageSchemaSha256,
        input.releaseReportSha256,
        usage.workerRequests,
        usage.workerCpuMs,
        usage.containerCpuMicroseconds,
        usage.containerAllocatedMemoryByteMilliseconds,
        usage.containerAllocatedDiskByteMilliseconds,
        row.data.provider_container_tx_bytes,
        usage.analyticsEngineDataPoints,
        usage.analyticsEngineReadQueries,
        usage.workersLogpushEvents,
        usage.durableObjectActiveMilliseconds,
        usage.durableObjectRequests,
        usage.durableObjectStorageByteMilliseconds,
        usage.queueOperations,
        usage.d1RowsRead,
        usage.d1RowsWritten,
        usage.d1StorageByteMilliseconds,
        usage.r2ClassAOperations,
        usage.r2ClassBOperations,
        usage.r2StorageByteMilliseconds,
        usage.observabilityLogEvents,
        control.cost_accounting_epoch,
        hourKey,
        egressJson,
        egressJson,
        control.cost_accounting_epoch,
        hourKey,
        costs.workerCostMicrousd,
        costs.containerCostMicrousd,
        costs.durableObjectCostMicrousd,
        costs.queueCostMicrousd,
        costs.d1CostMicrousd,
        costs.r2CostMicrousd,
        costs.analyticsEngineCostMicrousd,
        costs.observabilityCostMicrousd,
        costs.fixedCostMicrousd,
        costs.totalCostMicrousd,
      ),
    session
      .prepare(
        `UPDATE rollout_control
         SET last_sealed_hour_key = ?
         WHERE id = 1
           AND cost_accounting_epoch = ?
           AND cost_accounting_started_at = ?
           AND COALESCE(last_sealed_hour_key + 1, ?) = ?
           AND EXISTS (
             SELECT 1 FROM operational_cost_hourly
             WHERE accounting_epoch = ? AND hour_key = ? AND complete = 1
               AND CAST(worker_cost_microusd AS TEXT) = ?
               AND CAST(container_cost_microusd AS TEXT) = ?
               AND CAST(durable_object_cost_microusd AS TEXT) = ?
               AND CAST(queue_cost_microusd AS TEXT) = ?
               AND CAST(d1_cost_microusd AS TEXT) = ?
               AND CAST(r2_cost_microusd AS TEXT) = ?
               AND CAST(analytics_engine_cost_microusd AS TEXT) = ?
               AND CAST(observability_cost_microusd AS TEXT) = ?
               AND CAST(fixed_cost_microusd AS TEXT) = ?
               AND CAST(total_cost_microusd AS TEXT) = ?
           )`,
      )
      .bind(
        hourKey,
        control.cost_accounting_epoch,
        control.cost_accounting_started_at,
        firstHourKey,
        hourKey,
        control.cost_accounting_epoch,
        hourKey,
        costs.workerCostMicrousd,
        costs.containerCostMicrousd,
        costs.durableObjectCostMicrousd,
        costs.queueCostMicrousd,
        costs.d1CostMicrousd,
        costs.r2CostMicrousd,
        costs.analyticsEngineCostMicrousd,
        costs.observabilityCostMicrousd,
        costs.fixedCostMicrousd,
        costs.totalCostMicrousd,
      ),
    session
      .prepare(
        `UPDATE usage_log_objects
         SET state = 'sealed'
         WHERE state = 'parsed'
           AND NOT EXISTS (
             SELECT 1
             FROM usage_log_object_hours AS object_hour
             LEFT JOIN operational_cost_hourly AS cost
               ON cost.accounting_epoch = ?
              AND cost.hour_key = object_hour.hour_key
              AND cost.complete = 1
              AND cost.hour_key <= COALESCE((
                SELECT last_sealed_hour_key FROM rollout_control
                WHERE id = 1 AND cost_accounting_epoch = ?
              ), -1)
             WHERE object_hour.object_key = usage_log_objects.object_key
               AND cost.hour_key IS NULL
           )`,
      )
      .bind(control.cost_accounting_epoch, control.cost_accounting_epoch),
    session
      .prepare(
        `SELECT cost.complete,
                CAST(cost.worker_cost_microusd AS TEXT) AS worker_cost_microusd,
                CAST(cost.container_cost_microusd AS TEXT) AS container_cost_microusd,
                CAST(cost.durable_object_cost_microusd AS TEXT) AS durable_object_cost_microusd,
                CAST(cost.queue_cost_microusd AS TEXT) AS queue_cost_microusd,
                CAST(cost.d1_cost_microusd AS TEXT) AS d1_cost_microusd,
                CAST(cost.r2_cost_microusd AS TEXT) AS r2_cost_microusd,
                CAST(cost.analytics_engine_cost_microusd AS TEXT)
                  AS analytics_engine_cost_microusd,
                CAST(cost.observability_cost_microusd AS TEXT) AS observability_cost_microusd,
                CAST(cost.fixed_cost_microusd AS TEXT) AS fixed_cost_microusd,
                CAST(cost.total_cost_microusd AS TEXT) AS total_cost_microusd,
                control.last_sealed_hour_key,
                control.circuit_open
         FROM operational_cost_hourly AS cost
         CROSS JOIN rollout_control AS control
         WHERE cost.accounting_epoch = ? AND cost.hour_key = ? AND control.id = 1`,
      )
      .bind(control.cost_accounting_epoch, hourKey),
  ]);
  const sealed = sealedStateSchema.safeParse(results[3]?.results[0]);
  if (
    !sealed.success ||
    sealed.data.last_sealed_hour_key !== hourKey ||
    sealed.data.worker_cost_microusd !== costs.workerCostMicrousd ||
    sealed.data.container_cost_microusd !== costs.containerCostMicrousd ||
    sealed.data.durable_object_cost_microusd !== costs.durableObjectCostMicrousd ||
    sealed.data.queue_cost_microusd !== costs.queueCostMicrousd ||
    sealed.data.d1_cost_microusd !== costs.d1CostMicrousd ||
    sealed.data.r2_cost_microusd !== costs.r2CostMicrousd ||
    sealed.data.analytics_engine_cost_microusd !== costs.analyticsEngineCostMicrousd ||
    sealed.data.observability_cost_microusd !== costs.observabilityCostMicrousd ||
    sealed.data.fixed_cost_microusd !== costs.fixedCostMicrousd ||
    sealed.data.total_cost_microusd !== costs.totalCostMicrousd
  ) {
    return openCostCircuit(database, input.now, hourKey, "COST_SEAL_RACE");
  }
  return {
    kind: "sealed",
    hourKey,
    totalCostMicrousd: costs.totalCostMicrousd,
    circuitOpen: sealed.data.circuit_open === 1,
  };
}
