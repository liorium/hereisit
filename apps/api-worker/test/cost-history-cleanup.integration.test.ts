import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCostHistory } from "../src/cost-history-cleanup";

const now = Date.parse("2026-07-19T12:00:00.000Z");
const old = now - 36 * 24 * 60 * 60_000;
const oldHourKey = Math.floor(old / 3_600_000);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM usage_log_objects").run();
  await env.DB.prepare(
    "UPDATE rollout_control SET circuit_open=0,reason=NULL,cost_accounting_started_at=?,last_sealed_hour_key=? WHERE id=1",
  )
    .bind(old, oldHourKey)
    .run();
  await env.DB.prepare(
    "UPDATE accounting_health SET epoch=(SELECT cost_accounting_epoch FROM rollout_control WHERE id=1),status='unknown',reason=NULL,evaluated_at=0,pending_hour_key=NULL,unresolved_since_hour_key=NULL WHERE id=1",
  ).run();
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
  it("bounds each history deletion and preserves the unresolved marker and cursor", async () => {
    await env.DB.prepare("UPDATE rollout_control SET last_sealed_hour_key=NULL WHERE id=1").run();
    await env.DB.prepare("UPDATE operational_cost_hourly SET complete=0").run();
    for (let i = 1; i < 4; i++)
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO operational_counter_hourly(accounting_epoch,hour_key,updated_at) SELECT cost_accounting_epoch,?,? FROM rollout_control WHERE id=1",
        ).bind(oldHourKey + i, old),
        env.DB.prepare(
          "INSERT INTO container_activity_segments(id,started_at,billed_until_at) VALUES(?,?,?)",
        ).bind(`00000000-0000-4000-8000-00000000010${i}`, old + i, old + 60_000 + i),
      ]);
    const result = await cleanupCostHistory(
      env.DB,
      { delete: vi.fn(async () => {}) },
      { now, limit: 2 },
    );
    expect(result.purgedActivitySegments).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operational_counter_hourly WHERE hour_key < ?",
      )
        .bind(oldHourKey + 4)
        .first("count"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT status,reason,unresolved_since_hour_key FROM accounting_health WHERE id=1",
      ).first(),
    ).toEqual({
      status: "degraded",
      reason: "HISTORICAL_GAP",
      unresolved_since_hour_key: oldHourKey,
    });
    expect(
      await env.DB.prepare("SELECT last_sealed_hour_key FROM rollout_control WHERE id=1").first(
        "last_sealed_hour_key",
      ),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM operational_cost_hourly").first("count"),
    ).toBe(0);
  });
  it("retains an object spanning old and retained hours", async () => {
    await env.DB.prepare("UPDATE usage_log_objects SET first_hour_key=?,last_hour_key=?")
      .bind(oldHourKey, Math.floor(now / 3_600_000))
      .run();
    const bucket = { delete: vi.fn(async () => {}) };
    expect((await cleanupCostHistory(env.DB, bucket, { now })).deletedObjects).toBe(0);
    expect(bucket.delete).not.toHaveBeenCalled();
  });
  it("preserves evidence under a hard safety stop", async () => {
    await env.DB.prepare(
      "UPDATE rollout_control SET circuit_open=1,reason='USAGE_LOG_CONFLICT' WHERE id=1",
    ).run();
    const bucket = { delete: vi.fn(async () => {}) };
    expect(await cleanupCostHistory(env.DB, bucket, { now })).toEqual({
      deletedObjects: 0,
      purgedObjectLedgers: 0,
      purgedCostHours: 0,
      purgedActivitySegments: 0,
    });
    expect(bucket.delete).not.toHaveBeenCalled();
  });
  it.each([
    0, 2,
  ])("retains a legacy stop with unavailable safety coverage %i", async (historyStartedAt) => {
    await env.DB.prepare(
      "UPDATE rollout_control SET circuit_open=1,reason='COST_ACCOUNTING_INCOMPLETE',opened_at=1,safety_history_started_at=? WHERE id=1",
    )
      .bind(historyStartedAt)
      .run();
    const bucket = { delete: vi.fn(async () => {}) };
    expect(await cleanupCostHistory(env.DB, bucket, { now })).toEqual({
      deletedObjects: 0,
      purgedObjectLedgers: 0,
      purgedCostHours: 0,
      purgedActivitySegments: 0,
    });
    expect(bucket.delete).not.toHaveBeenCalled();
  });
  it("retains unparsed objects whose hour range cannot be proven", async () => {
    await env.DB.prepare("UPDATE usage_log_objects SET state='observed'").run();
    const bucket = { delete: vi.fn(async () => {}) };
    expect((await cleanupCostHistory(env.DB, bucket, { now })).deletedObjects).toBe(0);
  });
});
