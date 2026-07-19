import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileContainerProviderHour } from "../src/container-provider-usage-reconciler";

const accountingEpoch = "a".repeat(32);
const liveCostModelSha256 = "b".repeat(64);
const providerUsageSchemaSha256 = "c".repeat(64);
const releaseReportSha256 = "d".repeat(64);
const hourKey = 495_672;
const hourStart = hourKey * 3_600_000;
const observedAt = hourStart + 3_600_000 + 50 * 60_000;
const usage = {
  cpuMicroseconds: "3600000000",
  allocatedMemoryByteMilliseconds: "23192823398400000",
  allocatedDiskByteMilliseconds: "43200000000000000",
  transmittedBytes: "9007199254740991",
};

const input = (overrides: Record<string, unknown> = {}) => ({
  hourKey,
  observedAt,
  usage,
  liveCostModelSha256,
  providerUsageSchemaSha256,
  releaseReportSha256,
  ...overrides,
});

async function seedCostRow(workerComplete: 0 | 1): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO operational_cost_hourly (
       accounting_epoch, hour_key, live_cost_model_sha256,
       provider_usage_schema_sha256, release_report_sha256,
       provider_worker_usage_complete, analytics_engine_usage_complete, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      accountingEpoch,
      hourKey,
      liveCostModelSha256,
      providerUsageSchemaSha256,
      releaseReportSha256,
      workerComplete,
      workerComplete,
      observedAt,
    )
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
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM operational_cost_hourly").run();
});

describe("Container provider-hour reconciliation", () => {
  it("stores exact 64-bit provider units and completes the combined provider snapshot", async () => {
    await seedCostRow(1);

    await expect(reconcileContainerProviderHour(env.DB, input())).resolves.toEqual({
      kind: "verified",
      ...usage,
      providerUsageComplete: true,
      circuitOpen: false,
    });
    await expect(
      env.DB.prepare(
        `SELECT CAST(provider_container_cpu_microseconds AS TEXT) AS cpu,
                CAST(provider_container_allocated_memory_byte_milliseconds AS TEXT) AS memory,
                CAST(provider_container_allocated_disk_byte_milliseconds AS TEXT) AS disk,
                CAST(provider_container_tx_bytes AS TEXT) AS transmitted,
                provider_container_usage_complete, provider_usage_complete, complete
         FROM operational_cost_hourly
         WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, hourKey)
        .first(),
    ).resolves.toEqual({
      cpu: usage.cpuMicroseconds,
      memory: usage.allocatedMemoryByteMilliseconds,
      disk: usage.allocatedDiskByteMilliseconds,
      transmitted: usage.transmittedBytes,
      provider_container_usage_complete: 1,
      provider_usage_complete: 1,
      complete: 0,
    });
  });

  it("keeps combined provider usage incomplete until Worker sources are verified", async () => {
    await seedCostRow(0);

    await expect(reconcileContainerProviderHour(env.DB, input())).resolves.toMatchObject({
      kind: "verified",
      providerUsageComplete: false,
      circuitOpen: false,
    });
  });

  it("does not write before the provider delivery allowance", async () => {
    await expect(
      reconcileContainerProviderHour(
        env.DB,
        input({ observedAt: hourStart + 3_600_000 + 29 * 60_000 }),
      ),
    ).resolves.toEqual({ kind: "incomplete", reason: "provider-delay", circuitOpen: false });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM operational_cost_hourly").first("count"),
    ).resolves.toBe(0);
  });

  it("never rewrites a verified Container provider snapshot", async () => {
    await seedCostRow(1);
    await reconcileContainerProviderHour(env.DB, input());

    await expect(
      reconcileContainerProviderHour(
        env.DB,
        input({ usage: { ...usage, cpuMicroseconds: "3599999999" } }),
      ),
    ).resolves.toEqual({
      kind: "conflict",
      reason: "PROVIDER_CONTAINER_USAGE_MISMATCH",
      circuitOpen: true,
    });
    await expect(
      env.DB.prepare(
        `SELECT CAST(provider_container_cpu_microseconds AS TEXT) AS cpu
         FROM operational_cost_hourly WHERE accounting_epoch = ? AND hour_key = ?`,
      )
        .bind(accountingEpoch, hourKey)
        .first("cpu"),
    ).resolves.toBe(usage.cpuMicroseconds);
  });
});
