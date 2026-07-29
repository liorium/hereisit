import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveCostModelV1 } from "../src/env";
import { sealNextHourlyCost } from "../src/hourly-cost-sealer";

const accountingEpoch = "a".repeat(32);
const liveCostModelSha256 = "b".repeat(64);
const providerUsageSchemaSha256 = "c".repeat(64);
const releaseReportSha256 = "d".repeat(64);
const firstHourKey = 495_672;
const firstHourStart = firstHourKey * 3_600_000;

function model(): LiveCostModelV1 {
  return {
    version: 1,
    containerVcpuSecondMicrousd: 1_000_000,
    containerGibSecondMicrousd: 1_000_000,
    containerDiskGbSecondMicrousd: 1_000_000,
    containerEgressGbMicrousd: 4_000_000,
    containerEgressRegionPricesMicrousd: { ENAM: 2_000_000 },
    containerEgressRegionPricesSha256: "1".repeat(64),
    containerInstanceVcpu: 1,
    containerInstanceMemoryGib: 6,
    containerInstanceDiskGb: 12,
    containerSleepAfterSeconds: 60,
    workersMillionRequestsMicrousd: 1_000_000,
    workersMillionCpuMsMicrousd: 1_000_000,
    durableObjectMillionRequestsMicrousd: 1_000_000,
    durableObjectGibSecondMicrousd: 1_000_000,
    durableObjectStorageGbMonthMicrousd: 1_000_000,
    r2StorageGbMonthMicrousd: 1_000_000,
    r2ClassAMillionMicrousd: 1_000_000,
    r2ClassBMillionMicrousd: 1_000_000,
    queueMillionOperationsMicrousd: 1_000_000,
    d1MillionRowsReadMicrousd: 1_000_000,
    d1MillionRowsWrittenMicrousd: 1_000_000,
    d1StorageGbMonthMicrousd: 1_000_000,
    observabilityMillionLogEventsMicrousd: 1_000_000,
    workersLogpushMillionEventsMicrousd: 1_000_000,
    analyticsEngineMillionDataPointsMicrousd: 1_000_000,
    analyticsEngineMillionReadQueriesMicrousd: 1_000_000,
    monthlyFixedMicrousd: 720,
    projectedMonthlyJobs: 10_000,
    routeCpuBenchmarkSha256: "2".repeat(64),
    routeCpuEnvelopeMs: {
      policy: 1,
      create: 1,
      upload: 1,
      read: 1,
      result: 1,
      maintenance: 1,
      queue: 1,
    },
    arrivalProjection: {
      algorithm: "arrival-union-tail-v1",
      steadyHourlyJobs: Array(24).fill(1),
      burstyHourlyJobs: Array(24).fill(1),
      sparseHourlyJobs: Array(24).fill(1),
      scenariosSha256: "3".repeat(64),
    },
  };
}

const input = (now: number) => ({
  now,
  model: model(),
  liveCostModelSha256,
  providerUsageSchemaSha256,
  releaseReportSha256,
});

async function seedCompleteProviderRow(hourKey: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO operational_cost_hourly (
         accounting_epoch, hour_key, live_cost_model_sha256,
         provider_usage_schema_sha256, release_report_sha256,
         provider_worker_requests, provider_worker_cpu_ms, provider_worker_usage_complete,
         provider_container_cpu_microseconds,
         provider_container_allocated_memory_byte_milliseconds,
         provider_container_allocated_disk_byte_milliseconds,
         provider_container_tx_bytes, provider_container_usage_complete,
         analytics_engine_data_points, analytics_engine_read_queries,
         analytics_engine_usage_complete, workers_logpush_events, provider_usage_complete,
         durable_object_active_milliseconds, durable_object_requests,
         queue_operations, d1_rows_read, d1_rows_written,
         r2_class_a_operations, r2_class_b_operations,
         observability_log_events, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         1, 1, 1,
         CAST('1000000' AS INTEGER), CAST('1073741824000' AS INTEGER),
         CAST('1000000000000' AS INTEGER), CAST('1000000000' AS INTEGER), 1,
         1, 1, 1, 1, 1,
         8000, 99,
         99, 99, 99,
         99, 99,
         99, ?
       )`,
    ).bind(
      accountingEpoch,
      hourKey,
      liveCostModelSha256,
      providerUsageSchemaSha256,
      releaseReportSha256,
      firstHourStart,
    ),
    env.DB.prepare(
      `INSERT INTO container_provider_egress_hourly (
         accounting_epoch, hour_key, region, transmitted_bytes
       ) VALUES (?, ?, 'enam', CAST('1000000000' AS INTEGER))`,
    ).bind(accountingEpoch, hourKey),
    env.DB.prepare(
      `INSERT INTO operational_counter_hourly (
         accounting_epoch, hour_key, durable_object_requests, queue_operations,
         d1_rows_read, d1_rows_written, r2_class_a_operations, r2_class_b_operations,
         observability_log_events, updated_at
       ) VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1, ?)`,
    ).bind(accountingEpoch, hourKey, firstHourStart),
  ]);
}

beforeEach(async () => {
  await env.DB.prepare(
    `UPDATE rollout_control
     SET cost_accounting_epoch = ?, cost_accounting_started_at = ?,
         last_sealed_hour_key = NULL, circuit_open = 0, reason = NULL, opened_at = NULL
     WHERE id = 1`,
  )
    .bind(accountingEpoch, firstHourStart)
    .run();
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operational_cost_hourly"),
    env.DB.prepare("DELETE FROM container_activity_segments"),
    env.DB.prepare("DELETE FROM operational_counter_hourly"),
  ]);
});

describe("hourly cost sealing", () => {
  it("prices and atomically seals the next complete provider hour", async () => {
    await seedCompleteProviderRow(firstHourKey);

    await expect(
      sealNextHourlyCost(env.DB, input(firstHourStart + 3_600_000 + 50 * 60_000)),
    ).resolves.toEqual({
      kind: "sealed",
      hourKey: firstHourKey,
      totalCostMicrousd: "5000013",
      circuitOpen: false,
    });
    await expect(
      env.DB.prepare(
        `SELECT CAST(worker_cost_microusd AS TEXT) AS worker,
                CAST(container_cost_microusd AS TEXT) AS container,
                CAST(durable_object_cost_microusd AS TEXT) AS durable_object,
                CAST(total_cost_microusd AS TEXT) AS total, complete
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, firstHourKey)
        .first(),
    ).resolves.toEqual({
      worker: "2",
      container: "5000000",
      durable_object: "1",
      total: "5000013",
      complete: 1,
    });
    await expect(
      env.DB.prepare("SELECT last_sealed_hour_key FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ last_sealed_hour_key: firstHourKey });
  });

  it("waits for a due source, then opens the circuit at the one-hour deadline", async () => {
    const hourEnd = firstHourStart + 3_600_000;
    await expect(sealNextHourlyCost(env.DB, input(hourEnd + 59 * 60_000))).resolves.toEqual({
      kind: "incomplete",
      hourKey: firstHourKey,
      circuitOpen: false,
    });
    await expect(sealNextHourlyCost(env.DB, input(hourEnd + 60 * 60_000))).resolves.toEqual({
      kind: "conflict",
      hourKey: firstHourKey,
      reason: "COST_ACCOUNTING_INCOMPLETE",
      circuitOpen: true,
    });
  });

  it("never skips an hour even when multiple complete rows are available", async () => {
    await seedCompleteProviderRow(firstHourKey);
    await seedCompleteProviderRow(firstHourKey + 1);
    const now = firstHourStart + 3 * 3_600_000;

    await expect(sealNextHourlyCost(env.DB, input(now))).resolves.toMatchObject({
      kind: "sealed",
      hourKey: firstHourKey,
    });
    await expect(
      env.DB.prepare(
        `SELECT hour_key, complete FROM operational_cost_hourly
         WHERE accounting_epoch = ? ORDER BY hour_key`,
      )
        .bind(accountingEpoch)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { hour_key: firstHourKey, complete: 1 },
        { hour_key: firstHourKey + 1, complete: 0 },
      ],
    });
    await expect(sealNextHourlyCost(env.DB, input(now))).resolves.toMatchObject({
      kind: "sealed",
      hourKey: firstHourKey + 1,
    });
  });

  it("opens the circuit when the signed cost model cannot price a provider region", async () => {
    await seedCompleteProviderRow(firstHourKey);
    const invalidModel = { ...model(), containerEgressRegionPricesMicrousd: {} };

    await expect(
      sealNextHourlyCost(env.DB, {
        ...input(firstHourStart + 3_600_000 + 50 * 60_000),
        model: invalidModel,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      hourKey: firstHourKey,
      reason: "COST_MODEL_INVALID",
      circuitOpen: true,
    });
  });

  it("rejects a pre-sealed row whose component costs do not match its total", async () => {
    await seedCompleteProviderRow(firstHourKey);
    await env.DB.prepare(
      `UPDATE operational_cost_hourly
       SET complete = 1, worker_cost_microusd = 999, total_cost_microusd = 5000013
       WHERE accounting_epoch = ? AND hour_key = ?`,
    )
      .bind(accountingEpoch, firstHourKey)
      .run();

    await expect(
      sealNextHourlyCost(env.DB, input(firstHourStart + 3_600_000 + 50 * 60_000)),
    ).resolves.toEqual({
      kind: "conflict",
      hourKey: firstHourKey,
      reason: "COST_SEAL_RACE",
      circuitOpen: true,
    });
    await expect(
      env.DB.prepare(
        "SELECT last_sealed_hour_key, circuit_open FROM rollout_control WHERE id = 1",
      ).first(),
    ).resolves.toEqual({ last_sealed_hour_key: null, circuit_open: 1 });
  });

  it("derives Container and Durable Object active time from the interval union", async () => {
    await seedCompleteProviderRow(firstHourKey);
    await env.DB.prepare(
      `INSERT INTO container_activity_segments (id, started_at, billed_until_at)
       VALUES ('00000000-0000-4000-8000-000000000010', ?, ?)`,
    )
      .bind(firstHourStart + 1_000, firstHourStart + 61_000)
      .run();

    await expect(
      sealNextHourlyCost(env.DB, input(firstHourStart + 3_600_000 + 50 * 60_000)),
    ).resolves.toMatchObject({ kind: "sealed", totalCostMicrousd: "12500013" });
    await expect(
      env.DB.prepare(
        `SELECT container_active_milliseconds, durable_object_active_milliseconds
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, firstHourKey)
        .first(),
    ).resolves.toEqual({
      container_active_milliseconds: 60_000,
      durable_object_active_milliseconds: 60_000,
    });
  });
});
