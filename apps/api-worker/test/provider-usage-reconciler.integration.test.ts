import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsHourResult } from "../src/provider-usage";
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

const analytics = (count = 3, id = versionId): AnalyticsHourResult => ({
  handlerInvocationCount: count,
  sampled: false,
  groups: [
    {
      event_type: "fetch",
      entrypoint: "default",
      version_id: id,
      release_report_sha256: releaseReportSha256,
      point_count: count,
      minimum_sample_interval: 1,
      maximum_sample_interval: 1,
    },
  ],
});

const input = (overrides: Record<string, unknown> = {}) => ({
  hourKey,
  observedAt,
  logpush: { complete: true, lastCompleteMilliseconds: hourStart + 3_600_000 },
  analytics: analytics(),
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
         subset_invocation_count, payload_sha256
       ) VALUES (?, ?, 4, 17, 3, ?)`,
    ).bind("logs/hour.ndjson.gz", hourKey, "2".repeat(64)),
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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operational_cost_hourly"),
    env.DB.prepare("DELETE FROM usage_log_hour_observations"),
    env.DB.prepare("DELETE FROM usage_log_objects"),
    env.DB.prepare("DELETE FROM worker_version_attestations"),
  ]);
});

describe("Worker provider-hour reconciliation", () => {
  it("records an immutable Worker provider snapshot only after all sources agree", async () => {
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
      analytics_engine_data_points: 3,
      analytics_engine_read_queries: 1,
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

    await expect(
      reconcileWorkerProviderHour(
        env.DB,
        input({ analytics: { handlerInvocationCount: 0, sampled: false, groups: [] } }),
      ),
    ).resolves.toMatchObject({
      kind: "verified",
      requestCount: 0,
      workerCpuMs: 0,
      handlerInvocationCount: 0,
      objectCount: 0,
      objectBytes: 0,
    });
  });

  it("opens the circuit when Analytics and Trace handler counts disagree", async () => {
    await expect(
      reconcileWorkerProviderHour(env.DB, input({ analytics: analytics(2) })),
    ).resolves.toMatchObject({ kind: "conflict", reason: "PROVIDER_USAGE_MISMATCH" });
    await expect(
      env.DB.prepare("SELECT circuit_open, reason FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ circuit_open: 1, reason: "PROVIDER_USAGE_MISMATCH" });
  });

  it("opens the circuit for an unattested Analytics Worker version", async () => {
    const unknownVersion = "123e4567-e89b-42d3-a456-426614174001";
    await expect(
      reconcileWorkerProviderHour(env.DB, input({ analytics: analytics(3, unknownVersion) })),
    ).resolves.toMatchObject({ kind: "conflict", reason: "PROVIDER_USAGE_UNATTESTED_VERSION" });
  });

  it("never rewrites an already verified provider snapshot", async () => {
    await reconcileWorkerProviderHour(env.DB, input());

    await expect(
      reconcileWorkerProviderHour(env.DB, input({ analytics: analytics(2) })),
    ).resolves.toMatchObject({ kind: "conflict", reason: "PROVIDER_USAGE_MISMATCH" });
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
      analytics_engine_data_points: 3,
    });
  });
});
