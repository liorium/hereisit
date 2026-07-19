import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCostHistory } from "../src/cost-history-cleanup";

const now = Date.parse("2026-07-19T12:00:00.000Z");
const old = now - 36 * 24 * 60 * 60_000;
const oldHourKey = Math.floor(old / 3_600_000);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM usage_log_objects").run();
  await env.DB.prepare(
    `INSERT INTO usage_log_objects (
       object_key, etag, byte_size, first_seen_at, last_seen_at, state
     ) VALUES ('logs/one.gz', 'etag-1', 10, ?, ?, 'sealed')`,
  )
    .bind(old, old)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO operational_cost_hourly (
         accounting_epoch, hour_key, live_cost_model_sha256,
         provider_usage_schema_sha256, release_report_sha256, complete, updated_at
       )
       SELECT cost_accounting_epoch, ?, ?, ?, ?, 1, ? FROM rollout_control WHERE id = 1`,
    ).bind(oldHourKey, "a".repeat(64), "b".repeat(64), "c".repeat(64), old),
    env.DB.prepare(
      `INSERT INTO operational_counter_hourly (
         accounting_epoch, hour_key, d1_rows_read, updated_at
       )
       SELECT cost_accounting_epoch, ?, 1, ? FROM rollout_control WHERE id = 1`,
    ).bind(oldHourKey, old),
    env.DB.prepare(
      `INSERT INTO container_activity_segments (id, started_at, billed_until_at)
       VALUES ('00000000-0000-4000-8000-000000000099', ?, ?)`,
    ).bind(old, old + 60_000),
  ]);
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage_log_objects"),
    env.DB.prepare("DELETE FROM operational_cost_hourly"),
    env.DB.prepare("DELETE FROM operational_counter_hourly"),
    env.DB.prepare("DELETE FROM container_activity_segments"),
  ]);
});

describe("cost history cleanup", () => {
  it("deletes sealed private logs, records R2 cost, and purges the ledger after seven days", async () => {
    const bucket = { delete: vi.fn(async () => undefined) };

    await expect(cleanupCostHistory(env.DB, bucket, { now, limit: 10 })).resolves.toEqual({
      deletedObjects: 1,
      purgedObjectLedgers: 0,
      purgedCostHours: 1,
      purgedActivitySegments: 1,
    });
    expect(bucket.delete).toHaveBeenCalledWith("logs/one.gz");
    await expect(
      env.DB.prepare("SELECT state, deleted_at FROM usage_log_objects").first(),
    ).resolves.toEqual({ state: "deleted", deleted_at: now });
    await expect(
      env.DB.prepare(
        "SELECT SUM(r2_class_a_operations) AS operations FROM operational_counter_hourly",
      ).first("operations"),
    ).resolves.toBe(1);

    await expect(
      cleanupCostHistory(env.DB, bucket, { now: now + 7 * 24 * 60 * 60_000, limit: 10 }),
    ).resolves.toMatchObject({ purgedObjectLedgers: 1 });
  });

  it("keeps a failed deletion pending and retries without exposing its key", async () => {
    const bucket = {
      delete: vi
        .fn<(key: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("unavailable"))
        .mockResolvedValueOnce(undefined),
    };

    await expect(cleanupCostHistory(env.DB, bucket, { now, limit: 10 })).resolves.toMatchObject({
      deletedObjects: 0,
    });
    await expect(
      env.DB.prepare("SELECT state FROM usage_log_objects").first("state"),
    ).resolves.toBe("delete-pending");
    await expect(
      cleanupCostHistory(env.DB, bucket, { now: now + 1, limit: 10 }),
    ).resolves.toMatchObject({ deletedObjects: 1 });
  });
});
