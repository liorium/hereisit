import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationPath = "apps/api-worker/migrations/0004_live_cost_accounting.sql";

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const path of [
    "apps/api-worker/migrations/0001_processing_jobs.sql",
    "apps/api-worker/migrations/0002_worker_version_attestations.sql",
    "apps/api-worker/migrations/0003_circuit_breaker.sql",
    migrationPath,
  ]) {
    database.exec(readFileSync(path, "utf8"));
  }
  return database;
}

describe("live cost accounting D1 migration", () => {
  it("is checked in after the circuit breaker migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("stores hash-bound hourly provider and application costs", () => {
    const database = createDatabase();
    const columns = database.prepare("PRAGMA table_info(operational_cost_hourly)").all() as Array<{
      name: string;
      pk: number;
    }>;

    expect(columns.find(({ name }) => name === "accounting_epoch")).toMatchObject({ pk: 1 });
    expect(columns.find(({ name }) => name === "hour_key")).toMatchObject({ pk: 2 });
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "live_cost_model_sha256",
        "provider_usage_schema_sha256",
        "release_report_sha256",
        "provider_worker_usage_complete",
        "provider_container_usage_complete",
        "analytics_engine_usage_complete",
        "provider_usage_complete",
        "container_active_milliseconds",
        "durable_object_active_milliseconds",
        "workers_logpush_events",
        "usage_log_bytes",
        "total_cost_microusd",
        "complete",
        "updated_at",
      ]),
    );

    const hash = "a".repeat(64);
    database
      .prepare(
        `INSERT INTO operational_cost_hourly (
          accounting_epoch,
          hour_key,
          live_cost_model_sha256,
          provider_usage_schema_sha256,
          release_report_sha256,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("b".repeat(32), 123, hash, hash, hash, 456);
    expect(
      database
        .prepare(
          `SELECT admitted_jobs, provider_usage_complete, total_cost_microusd, complete
           FROM operational_cost_hourly`,
        )
        .get(),
    ).toEqual({
      admitted_jobs: 0,
      provider_usage_complete: 0,
      total_cost_microusd: 0,
      complete: 0,
    });
  });

  it("rejects incomplete flags, negative counters, and inverted activity segments", () => {
    const database = createDatabase();
    const hash = "a".repeat(64);
    const insertHour = database.prepare(
      `INSERT INTO operational_cost_hourly (
        accounting_epoch,
        hour_key,
        live_cost_model_sha256,
        provider_usage_schema_sha256,
        release_report_sha256,
        admitted_jobs,
        complete,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() => insertHour.run("b".repeat(32), 1, hash, hash, hash, -1, 0, 1)).toThrow();
    expect(() => insertHour.run("b".repeat(32), 1, hash, hash, hash, 0, 2, 1)).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO container_activity_segments (id, started_at, billed_until_at)
           VALUES (?, ?, ?)`,
        )
        .run("550e8400-e29b-41d4-a716-446655440000", 200, 100),
    ).toThrow();

    const indexes = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name = 'container_activity_segments_time_idx'`,
      )
      .all();
    expect(indexes).toEqual([{ name: "container_activity_segments_time_idx" }]);
  });
});
