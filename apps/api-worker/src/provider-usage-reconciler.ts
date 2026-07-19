import { z } from "zod";
import type { AnalyticsHourResult } from "./provider-usage";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const epochSchema = z.string().regex(/^[0-9a-f]{32}$/);
const analyticsGroupSchema = z
  .object({
    event_type: z.enum(["fetch", "queue", "scheduled"]),
    entrypoint: z.enum(["default", "queue", "scheduled"]),
    version_id: z.string().regex(UUID_PATTERN),
    release_report_sha256: hashSchema,
    point_count: nonnegativeInteger,
    minimum_sample_interval: z.literal(1),
    maximum_sample_interval: z.literal(1),
  })
  .strict();
const inputSchema = z
  .object({
    hourKey: nonnegativeInteger,
    observedAt: nonnegativeInteger,
    logpush: z
      .object({
        complete: z.boolean(),
        lastCompleteMilliseconds: nonnegativeInteger.nullable(),
      })
      .strict(),
    analytics: z
      .object({
        handlerInvocationCount: nonnegativeInteger,
        sampled: z.literal(false),
        groups: z.array(analyticsGroupSchema).max(128),
      })
      .strict(),
    liveCostModelSha256: hashSchema,
    providerUsageSchemaSha256: hashSchema,
    releaseReportSha256: hashSchema,
    expectedWorkerModuleSha256: hashSchema,
    expectedGeneratedConfigSha256: hashSchema,
  })
  .strict()
  .superRefine((input, context) => {
    let groupCount = 0;
    const groups = new Set<string>();
    for (const group of input.analytics.groups) {
      groupCount += group.point_count;
      const expectedEntrypoint = {
        fetch: "default",
        queue: "queue",
        scheduled: "scheduled",
      }[group.event_type];
      if (group.entrypoint !== expectedEntrypoint) {
        context.addIssue({ code: "custom", message: "Analytics entrypoint is invalid." });
      }
      const groupKey = `${group.event_type}:${group.entrypoint}:${group.version_id}:${group.release_report_sha256}`;
      if (groups.has(groupKey)) {
        context.addIssue({ code: "custom", message: "Analytics groups must be unique." });
      }
      groups.add(groupKey);
    }
    if (
      !Number.isSafeInteger(groupCount) ||
      groupCount !== input.analytics.handlerInvocationCount
    ) {
      context.addIssue({ code: "custom", message: "Analytics group counts must reconcile." });
    }
  });

const controlSchema = z
  .object({
    cost_accounting_epoch: epochSchema,
    circuit_open: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const usageAggregateSchema = z
  .object({
    object_count: nonnegativeInteger,
    object_bytes: nonnegativeInteger,
    matching_observation_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    current_object_count: nonnegativeInteger,
    invocation_count: nonnegativeInteger,
    worker_cpu_ms: nonnegativeInteger,
    subset_invocation_count: nonnegativeInteger,
  })
  .strict();
const attestationSchema = z
  .object({
    requested_version_id: z.string().regex(UUID_PATTERN),
    version_id: z.string().regex(UUID_PATTERN).nullable(),
    worker_module_sha256: hashSchema.nullable(),
    generated_config_sha256: hashSchema.nullable(),
    release_report_sha256: hashSchema.nullable(),
    observed_at: nonnegativeInteger.nullable(),
    retired_at: nonnegativeInteger.nullable(),
  })
  .strict();
const storedCostSchema = z
  .object({
    live_cost_model_sha256: hashSchema,
    provider_usage_schema_sha256: hashSchema,
    release_report_sha256: hashSchema,
    provider_worker_requests: nonnegativeInteger,
    provider_worker_cpu_ms: nonnegativeInteger,
    provider_worker_usage_complete: z.union([z.literal(0), z.literal(1)]),
    analytics_engine_data_points: nonnegativeInteger,
    analytics_engine_read_queries: nonnegativeInteger,
    analytics_engine_usage_complete: z.union([z.literal(0), z.literal(1)]),
    workers_logpush_events: nonnegativeInteger,
    usage_log_objects: nonnegativeInteger,
    usage_log_bytes: nonnegativeInteger,
  })
  .strict();

export interface ReconcileWorkerProviderHourInput {
  readonly hourKey: number;
  readonly observedAt: number;
  readonly logpush: {
    readonly complete: boolean;
    readonly lastCompleteMilliseconds: number | null;
  };
  readonly analytics: AnalyticsHourResult;
  readonly liveCostModelSha256: string;
  readonly providerUsageSchemaSha256: string;
  readonly releaseReportSha256: string;
  readonly expectedWorkerModuleSha256: string;
  readonly expectedGeneratedConfigSha256: string;
}

export type ReconcileWorkerProviderHourResult =
  | {
      readonly kind: "verified";
      readonly requestCount: number;
      readonly workerCpuMs: number;
      readonly handlerInvocationCount: number;
      readonly objectCount: number;
      readonly objectBytes: number;
      readonly circuitOpen: boolean;
    }
  | {
      readonly kind: "incomplete";
      readonly reason: "provider-delay" | "logpush" | "usage-log-set";
      readonly circuitOpen: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly reason:
        | "PROVIDER_USAGE_MISMATCH"
        | "PROVIDER_USAGE_UNATTESTED_VERSION"
        | "PROVIDER_USAGE_RACE";
      readonly circuitOpen: true;
    };

async function openProviderCircuit(
  database: D1Database,
  observedAt: number,
  reason: Extract<ReconcileWorkerProviderHourResult, { kind: "conflict" }>["reason"],
): Promise<Extract<ReconcileWorkerProviderHourResult, { kind: "conflict" }>> {
  await database
    .withSession("first-primary")
    .prepare(
      `UPDATE rollout_control
       SET circuit_open = 1,
           reason = CASE WHEN circuit_open = 1 THEN reason ELSE ? END,
           opened_at = COALESCE(opened_at, ?)
       WHERE id = 1`,
    )
    .bind(reason, observedAt)
    .run();
  return { kind: "conflict", reason, circuitOpen: true };
}

function uniqueVersions(input: z.infer<typeof inputSchema>): string {
  return JSON.stringify(
    [...new Map(input.analytics.groups.map((group) => [group.version_id, group])).values()].map(
      (group) => ({
        versionId: group.version_id,
        releaseReportSha256: group.release_report_sha256,
      }),
    ),
  );
}

export async function reconcileWorkerProviderHour(
  database: D1Database,
  rawInput: ReconcileWorkerProviderHourInput,
): Promise<ReconcileWorkerProviderHourResult> {
  const input = inputSchema.parse(rawInput);
  const hourStart = input.hourKey * 3_600_000;
  const hourEnd = (input.hourKey + 1) * 3_600_000;
  const providerReadyAt = hourEnd + 30 * 60_000;
  if (
    !Number.isSafeInteger(hourStart) ||
    !Number.isSafeInteger(hourEnd) ||
    !Number.isSafeInteger(providerReadyAt)
  ) {
    throw new RangeError("Provider usage hour exceeded its timestamp bound.");
  }
  const session = database.withSession("first-primary");
  const controlRaw = await session
    .prepare("SELECT cost_accounting_epoch, circuit_open FROM rollout_control WHERE id = 1")
    .first();
  const control = controlSchema.parse(controlRaw);

  if (input.observedAt < providerReadyAt) {
    return {
      kind: "incomplete",
      reason: "provider-delay",
      circuitOpen: control.circuit_open === 1,
    };
  }

  if (
    !input.logpush.complete ||
    input.logpush.lastCompleteMilliseconds === null ||
    input.logpush.lastCompleteMilliseconds < hourEnd
  ) {
    return { kind: "incomplete", reason: "logpush", circuitOpen: control.circuit_open === 1 };
  }

  const aggregateRaw = await session
    .prepare(
      `SELECT observation.object_count,
              observation.object_bytes,
              observation.matching_observation_count,
              COUNT(hours.object_key) AS current_object_count,
              COALESCE(SUM(hours.invocation_count), 0) AS invocation_count,
              COALESCE(SUM(hours.worker_cpu_ms), 0) AS worker_cpu_ms,
              COALESCE(SUM(hours.subset_invocation_count), 0) AS subset_invocation_count
       FROM usage_log_hour_observations AS observation
       LEFT JOIN usage_log_object_hours AS hours ON hours.hour_key = observation.hour_key
       WHERE observation.accounting_epoch = ? AND observation.hour_key = ?
       GROUP BY observation.accounting_epoch, observation.hour_key`,
    )
    .bind(control.cost_accounting_epoch, input.hourKey)
    .first();
  if (aggregateRaw === null) {
    return {
      kind: "incomplete",
      reason: "usage-log-set",
      circuitOpen: control.circuit_open === 1,
    };
  }
  const aggregate = usageAggregateSchema.parse(aggregateRaw);
  if (aggregate.matching_observation_count < 2) {
    return {
      kind: "incomplete",
      reason: "usage-log-set",
      circuitOpen: control.circuit_open === 1,
    };
  }
  if (
    aggregate.current_object_count !== aggregate.object_count ||
    aggregate.subset_invocation_count !== input.analytics.handlerInvocationCount
  ) {
    return openProviderCircuit(database, input.observedAt, "PROVIDER_USAGE_MISMATCH");
  }
  if (
    input.analytics.groups.some(
      (group) => group.release_report_sha256 !== input.releaseReportSha256,
    )
  ) {
    return openProviderCircuit(database, input.observedAt, "PROVIDER_USAGE_UNATTESTED_VERSION");
  }

  const versionsJson = uniqueVersions(input);
  const attestationResult = await session
    .prepare(
      `WITH requested AS (
         SELECT DISTINCT json_extract(value, '$.versionId') AS requested_version_id
         FROM json_each(?)
       )
       SELECT requested.requested_version_id,
              attestation.version_id,
              attestation.worker_module_sha256,
              attestation.generated_config_sha256,
              attestation.release_report_sha256,
              attestation.observed_at,
              attestation.retired_at
       FROM requested
       LEFT JOIN worker_version_attestations AS attestation
         ON attestation.version_id = requested.requested_version_id
       ORDER BY requested.requested_version_id`,
    )
    .bind(versionsJson)
    .all();
  const attestations = z.array(attestationSchema).max(128).parse(attestationResult.results);
  if (
    attestations.some(
      (attestation) =>
        attestation.version_id === null ||
        attestation.worker_module_sha256 !== input.expectedWorkerModuleSha256 ||
        attestation.generated_config_sha256 !== input.expectedGeneratedConfigSha256 ||
        attestation.release_report_sha256 !== input.releaseReportSha256 ||
        attestation.observed_at === null ||
        attestation.observed_at > hourStart ||
        (attestation.retired_at !== null && attestation.retired_at < hourEnd),
    )
  ) {
    return openProviderCircuit(database, input.observedAt, "PROVIDER_USAGE_UNATTESTED_VERSION");
  }

  const writes = await session.batch([
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
        `UPDATE operational_cost_hourly
         SET provider_worker_requests = ?,
             provider_worker_cpu_ms = ?,
             provider_worker_usage_complete = 1,
             analytics_engine_data_points = ?,
             analytics_engine_read_queries = 1,
             analytics_engine_usage_complete = 1,
             workers_logpush_events = ?,
             usage_log_objects = ?,
             usage_log_bytes = ?,
             updated_at = ?
         WHERE accounting_epoch = ? AND hour_key = ?
           AND live_cost_model_sha256 = ?
           AND provider_usage_schema_sha256 = ?
           AND release_report_sha256 = ?
           AND (
             provider_worker_usage_complete = 0
             OR (
               provider_worker_requests = ?
               AND provider_worker_cpu_ms = ?
               AND analytics_engine_data_points = ?
               AND analytics_engine_read_queries = 1
               AND workers_logpush_events = ?
               AND usage_log_objects = ?
               AND usage_log_bytes = ?
             )
           )
           AND EXISTS (
             SELECT 1
             FROM usage_log_hour_observations AS observation
             WHERE observation.accounting_epoch = ? AND observation.hour_key = ?
               AND observation.matching_observation_count >= 2
               AND observation.object_count = ? AND observation.object_bytes = ?
               AND (
                 SELECT COUNT(*) FROM usage_log_object_hours WHERE hour_key = ?
               ) = ?
               AND COALESCE((
                 SELECT SUM(invocation_count) FROM usage_log_object_hours WHERE hour_key = ?
               ), 0) = ?
               AND COALESCE((
                 SELECT SUM(worker_cpu_ms) FROM usage_log_object_hours WHERE hour_key = ?
               ), 0) = ?
               AND COALESCE((
                 SELECT SUM(subset_invocation_count) FROM usage_log_object_hours WHERE hour_key = ?
               ), 0) = ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(?) AS requested
             LEFT JOIN worker_version_attestations AS attestation
               ON attestation.version_id = json_extract(requested.value, '$.versionId')
             WHERE attestation.version_id IS NULL
                OR attestation.worker_module_sha256 <> ?
                OR attestation.generated_config_sha256 <> ?
                OR attestation.release_report_sha256 <>
                   json_extract(requested.value, '$.releaseReportSha256')
                OR attestation.observed_at > ?
                OR (attestation.retired_at IS NOT NULL AND attestation.retired_at < ?)
           )`,
      )
      .bind(
        aggregate.invocation_count,
        aggregate.worker_cpu_ms,
        input.analytics.handlerInvocationCount,
        aggregate.invocation_count,
        aggregate.object_count,
        aggregate.object_bytes,
        input.observedAt,
        control.cost_accounting_epoch,
        input.hourKey,
        input.liveCostModelSha256,
        input.providerUsageSchemaSha256,
        input.releaseReportSha256,
        aggregate.invocation_count,
        aggregate.worker_cpu_ms,
        input.analytics.handlerInvocationCount,
        aggregate.invocation_count,
        aggregate.object_count,
        aggregate.object_bytes,
        control.cost_accounting_epoch,
        input.hourKey,
        aggregate.object_count,
        aggregate.object_bytes,
        input.hourKey,
        aggregate.object_count,
        input.hourKey,
        aggregate.invocation_count,
        input.hourKey,
        aggregate.worker_cpu_ms,
        input.hourKey,
        input.analytics.handlerInvocationCount,
        versionsJson,
        input.expectedWorkerModuleSha256,
        input.expectedGeneratedConfigSha256,
        hourStart,
        hourEnd,
      ),
    session
      .prepare(
        `SELECT live_cost_model_sha256, provider_usage_schema_sha256, release_report_sha256,
                provider_worker_requests, provider_worker_cpu_ms,
                provider_worker_usage_complete, analytics_engine_data_points,
                analytics_engine_read_queries, analytics_engine_usage_complete,
                workers_logpush_events, usage_log_objects, usage_log_bytes
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
      .bind(control.cost_accounting_epoch, input.hourKey),
  ]);
  const stored = storedCostSchema.safeParse(writes[2]?.results[0]);
  const matches =
    stored.success &&
    stored.data.live_cost_model_sha256 === input.liveCostModelSha256 &&
    stored.data.provider_usage_schema_sha256 === input.providerUsageSchemaSha256 &&
    stored.data.release_report_sha256 === input.releaseReportSha256 &&
    stored.data.provider_worker_requests === aggregate.invocation_count &&
    stored.data.provider_worker_cpu_ms === aggregate.worker_cpu_ms &&
    stored.data.provider_worker_usage_complete === 1 &&
    stored.data.analytics_engine_data_points === input.analytics.handlerInvocationCount &&
    stored.data.analytics_engine_read_queries === 1 &&
    stored.data.analytics_engine_usage_complete === 1 &&
    stored.data.workers_logpush_events === aggregate.invocation_count &&
    stored.data.usage_log_objects === aggregate.object_count &&
    stored.data.usage_log_bytes === aggregate.object_bytes;
  if (!matches) {
    return openProviderCircuit(database, input.observedAt, "PROVIDER_USAGE_RACE");
  }
  return {
    kind: "verified",
    requestCount: aggregate.invocation_count,
    workerCpuMs: aggregate.worker_cpu_ms,
    handlerInvocationCount: input.analytics.handlerInvocationCount,
    objectCount: aggregate.object_count,
    objectBytes: aggregate.object_bytes,
    circuitOpen: control.circuit_open === 1,
  };
}
