import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CostAccountingRuntimeConfig,
  createCostAccountingRuntime,
} from "../src/cost-accounting-runtime";
import { reconcileWorkerProviderHour } from "../src/provider-usage-reconciler";

const accountingEpoch = "a".repeat(32);
const liveCostModelSha256 = "b".repeat(64);
const providerUsageSchemaSha256 = "c".repeat(64);
const releaseReportSha256 = "d".repeat(64);
const workerModuleSha256 = "e".repeat(64);
const generatedConfigSha256 = "f".repeat(64);
const versionId = "123e4567-e89b-42d3-a456-426614174000";
const hourKey = 495_408;
const hourStart = hourKey * 3_600_000;
const observedAt = hourStart + 3_600_000 + 50 * 60_000;

const input = (overrides: Record<string, unknown> = {}) => ({
  hourKey,
  observedAt,
  logpush: { complete: true, lastCompleteMilliseconds: hourStart + 3_600_000 },
  liveCostModelSha256,
  providerUsageSchemaSha256,
  releaseReportSha256,
  expectedWorkerModuleSha256: workerModuleSha256,
  expectedGeneratedConfigSha256: generatedConfigSha256,
  ...overrides,
});

async function seedStableUsageHour(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage_log_objects (
         object_key, etag, byte_size, first_seen_at, last_seen_at,
         stable_observation_count, parsed_sha256, first_hour_key, last_hour_key, state
       ) VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, 'parsed')`,
    ).bind(
      "logs/hour.ndjson.gz",
      "etag-1",
      512,
      observedAt - 10 * 60_000,
      observedAt,
      "1".repeat(64),
      hourKey,
      hourKey,
    ),
    env.DB.prepare(
      `INSERT INTO usage_log_object_hours (
         object_key, hour_key, invocation_count, worker_cpu_ms,
         subset_invocation_count, payload_sha256, handler_version_ids
       ) VALUES (?, ?, 4, 17, 3, ?, ?)`,
    ).bind("logs/hour.ndjson.gz", hourKey, "2".repeat(64), JSON.stringify([versionId])),
    env.DB.prepare(
      `INSERT INTO usage_log_hour_observations (
         accounting_epoch, hour_key, object_set_sha256, object_count, object_bytes,
         first_observed_at, last_observed_at, matching_observation_count
       ) VALUES (?, ?, ?, 1, 512, ?, ?, 2)`,
    ).bind(accountingEpoch, hourKey, "3".repeat(64), observedAt - 10 * 60_000, observedAt),
  ]);
}

async function seedAttestation(id = versionId): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO worker_version_attestations (
       version_id, worker_module_sha256, generated_config_sha256,
       release_report_sha256, kind, public_admission_allowed, observed_at
     ) VALUES (?, ?, ?, ?, 'active', 1, ?)`,
  )
    .bind(id, workerModuleSha256, generatedConfigSha256, releaseReportSha256, hourStart - 1)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(
    `UPDATE rollout_control
     SET cost_accounting_epoch = ?, circuit_open = 0, reason = NULL, opened_at = NULL
     WHERE id = 1`,
  )
    .bind(accountingEpoch)
    .run();
  await seedStableUsageHour();
  await seedAttestation();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operational_cost_hourly"),
    env.DB.prepare("DELETE FROM usage_log_hour_observations"),
    env.DB.prepare("DELETE FROM usage_log_objects"),
    env.DB.prepare("DELETE FROM worker_version_attestations"),
  ]);
});

describe("Worker provider-hour reconciliation", () => {
  it("reconciles through the real scheduler runtime without querying sampled Analytics", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url = String(request);
      urls.push(url);
      if (!url.endsWith("/logpush/jobs/41")) throw new Error("Analytics is unavailable or sampled");
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 41,
          dataset: "workers_trace_events",
          enabled: true,
          last_complete: new Date(hourStart + 3_600_000).toISOString(),
          last_error: null,
          error_message: null,
        },
      });
    });
    const runtime = createCostAccountingRuntime(
      {
        ...env,
        ANALYTICS_READ_TOKEN: "test-analytics-token",
        LOGPUSH_STATUS_TOKEN: "test-logpush-token",
        WORKER_VERSION: {
          id: versionId,
          tag: "test",
          timestamp: new Date(hourStart - 1).toISOString(),
        },
      },
      {
        accountId: "a".repeat(32),
        logpushJobId: 41,
        containerApplicationId: versionId,
        workerScriptName: "hereisit-processing-staging",
        usageLogPrefix: "workers-trace-events/staging/",
        analyticsDatasetName: "hereisit_processing_usage_staging",
        environment: "staging",
        liveCostModel: {} as CostAccountingRuntimeConfig["liveCostModel"],
        liveCostModelSha256,
        providerUsageSchemaSha256,
        releaseReportSha256,
      },
    );
    await expect(runtime.reconcileWorker(hourKey, observedAt)).resolves.toBe("verified");
    expect(urls).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/logpush/jobs/41`,
    ]);
  });

  it("uses exact original logs without Analytics availability and bounds both analytics writes", async () => {
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toEqual({
      kind: "verified",
      requestCount: 4,
      workerCpuMs: 17,
      handlerInvocationCount: 3,
      objectCount: 1,
      objectBytes: 512,
      circuitOpen: false,
    });

    await expect(
      env.DB.prepare(
        `SELECT provider_worker_requests, provider_worker_cpu_ms,
                provider_worker_usage_complete, analytics_engine_data_points,
                analytics_engine_read_queries, analytics_engine_usage_complete,
                workers_logpush_events, usage_log_objects, usage_log_bytes,
                provider_usage_complete, complete
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, hourKey)
        .first(),
    ).resolves.toEqual({
      provider_worker_requests: 4,
      provider_worker_cpu_ms: 17,
      provider_worker_usage_complete: 1,
      analytics_engine_data_points: 6,
      analytics_engine_read_queries: 0,
      analytics_engine_usage_complete: 1,
      workers_logpush_events: 4,
      usage_log_objects: 1,
      usage_log_bytes: 512,
      provider_usage_complete: 0,
      complete: 0,
    });
  });

  it("leaves the hour incomplete while Logpush has not reached the hour end", async () => {
    await expect(
      reconcileWorkerProviderHour(
        env.DB,
        input({
          logpush: { complete: false, lastCompleteMilliseconds: hourStart + 3_600_000 - 1 },
        }),
      ),
    ).resolves.toMatchObject({ kind: "incomplete", reason: "logpush", circuitOpen: false });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM operational_cost_hourly").first("count"),
    ).resolves.toBe(0);
  });

  it("does not reconcile before the conservative provider delivery allowance", async () => {
    await expect(
      reconcileWorkerProviderHour(
        env.DB,
        input({ observedAt: hourStart + 29 * 60_000 + 3_600_000 }),
      ),
    ).resolves.toMatchObject({
      kind: "incomplete",
      reason: "provider-delay",
      circuitOpen: false,
    });
  });

  it("records an explicit zero-usage hour without requiring a version attestation", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_log_hour_observations"),
      env.DB.prepare("DELETE FROM usage_log_objects"),
      env.DB.prepare("DELETE FROM worker_version_attestations"),
      env.DB.prepare(
        `INSERT INTO usage_log_hour_observations (
           accounting_epoch, hour_key, object_set_sha256, object_count, object_bytes,
           first_observed_at, last_observed_at, matching_observation_count
         ) VALUES (?, ?, ?, 0, 0, ?, ?, 2)`,
      ).bind(accountingEpoch, hourKey, "4".repeat(64), observedAt - 10 * 60_000, observedAt),
    ]);

    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "verified",
      requestCount: 0,
      workerCpuMs: 0,
      handlerInvocationCount: 0,
      objectCount: 0,
      objectBytes: 0,
    });
  });

  it("completes combined provider usage when Container verification arrived first", async () => {
    await env.DB.prepare(
      `INSERT INTO operational_cost_hourly (
         accounting_epoch, hour_key, live_cost_model_sha256,
         provider_usage_schema_sha256, release_report_sha256,
         provider_container_usage_complete, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
      .bind(
        accountingEpoch,
        hourKey,
        liveCostModelSha256,
        providerUsageSchemaSha256,
        releaseReportSha256,
        observedAt,
      )
      .run();

    await reconcileWorkerProviderHour(env.DB, input());

    await expect(
      env.DB.prepare(
        `SELECT provider_worker_usage_complete, analytics_engine_usage_complete,
                provider_container_usage_complete, provider_usage_complete
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, hourKey)
        .first(),
    ).resolves.toEqual({
      provider_worker_usage_complete: 1,
      analytics_engine_usage_complete: 1,
      provider_container_usage_complete: 1,
      provider_usage_complete: 1,
    });
  });

  it("opens the circuit when the observed and current log sets disagree", async () => {
    await env.DB.prepare("UPDATE usage_log_hour_observations SET object_count = 2").run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "conflict",
      reason: "PROVIDER_USAGE_MISMATCH",
    });
    await expect(
      env.DB.prepare("SELECT circuit_open, reason FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ circuit_open: 1, reason: "PROVIDER_USAGE_MISMATCH" });
  });

  it("opens the circuit for an unattested version in the original logs", async () => {
    const unknownVersion = "123e4567-e89b-42d3-a456-426614174001";
    await env.DB.prepare("UPDATE usage_log_object_hours SET handler_version_ids = ?")
      .bind(JSON.stringify([unknownVersion]))
      .run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "conflict",
      reason: "PROVIDER_USAGE_UNATTESTED_VERSION",
    });
  });

  it("never rewrites an already verified provider snapshot", async () => {
    await reconcileWorkerProviderHour(env.DB, input());
    await env.DB.prepare("UPDATE usage_log_object_hours SET worker_cpu_ms = 18").run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "conflict",
      reason: "PROVIDER_USAGE_RACE",
    });
    await expect(
      env.DB.prepare(
        `SELECT provider_worker_requests, provider_worker_cpu_ms, analytics_engine_data_points
         FROM operational_cost_hourly WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, hourKey)
        .first(),
    ).resolves.toEqual({
      provider_worker_requests: 4,
      provider_worker_cpu_ms: 17,
      analytics_engine_data_points: 6,
    });
  });

  it("waits for legacy provenance to be replayed instead of treating it as zero usage", async () => {
    await env.DB.prepare("UPDATE usage_log_object_hours SET handler_version_ids = NULL").run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "incomplete",
      reason: "usage-log-set",
      circuitOpen: false,
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM operational_cost_hourly").first("count"),
    ).toBe(0);
  });

  it("does not accept empty provenance for a nonempty handler hour", async () => {
    await env.DB.prepare("UPDATE usage_log_object_hours SET handler_version_ids = '[]'").run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "incomplete",
      reason: "usage-log-set",
    });
  });

  it("accounts for attested canary and public versions without resetting a transition hour", async () => {
    const publicVersion = "123e4567-e89b-42d3-a456-426614174001";
    await env.DB.prepare(
      "UPDATE worker_version_attestations SET kind = 'retired', public_admission_allowed = 0, generated_config_sha256 = ?, retired_at = ?",
    )
      .bind("1".repeat(64), hourStart + 1_800_000)
      .run();
    await seedAttestation(publicVersion);
    // Verification can finish after the event hour; it is not the deployment start time.
    await env.DB.prepare(
      "UPDATE worker_version_attestations SET observed_at = ? WHERE version_id = ?",
    )
      .bind(hourStart + 3_600_002, publicVersion)
      .run();
    await env.DB.prepare("UPDATE usage_log_object_hours SET handler_version_ids = ?")
      .bind(JSON.stringify([versionId, publicVersion]))
      .run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "verified",
      requestCount: 4,
      handlerInvocationCount: 3,
    });
    expect(
      await env.DB.prepare("SELECT cost_accounting_epoch FROM rollout_control").first(
        "cost_accounting_epoch",
      ),
    ).toBe(accountingEpoch);
  });

  it.each([
    "worker_module_sha256",
    "release_report_sha256",
    "generated_config_sha256",
  ])("rejects a mismatched active %s", async (column) => {
    await env.DB.prepare(`UPDATE worker_version_attestations SET ${column} = ?`)
      .bind("0".repeat(64))
      .run();
    await expect(reconcileWorkerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "conflict",
      reason: "PROVIDER_USAGE_UNATTESTED_VERSION",
    });
  });
});
