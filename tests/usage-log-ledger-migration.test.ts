import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationPath = "apps/api-worker/migrations/0005_usage_log_ledger.sql";

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const path of [
    "apps/api-worker/migrations/0001_processing_jobs.sql",
    "apps/api-worker/migrations/0002_worker_version_attestations.sql",
    "apps/api-worker/migrations/0003_circuit_breaker.sql",
    "apps/api-worker/migrations/0004_live_cost_accounting.sql",
    migrationPath,
  ]) {
    database.exec(readFileSync(path, "utf8"));
  }
  return database;
}

describe("usage log ledger D1 migration", () => {
  it("is checked in after live cost accounting", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("stores object identity, per-hour splits, and stable set observations", () => {
    const database = createDatabase();
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'usage_log_%'
         ORDER BY name`,
      )
      .all();
    expect(tables).toEqual([
      { name: "usage_log_hour_observations" },
      { name: "usage_log_object_hours" },
      { name: "usage_log_objects" },
    ]);

    database
      .prepare(
        `INSERT INTO usage_log_objects (
          object_key, etag, byte_size, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("trace/2026-07-19/a.ndjson.gz", "etag-1", 100, 1, 2);
    database
      .prepare(
        `INSERT INTO usage_log_object_hours (
          object_key, hour_key, invocation_count, worker_cpu_ms,
          subset_invocation_count, payload_sha256
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("trace/2026-07-19/a.ndjson.gz", 123, 10, 20, 8, "a".repeat(64));

    expect(
      database.prepare("SELECT state, stable_observation_count FROM usage_log_objects").get(),
    ).toEqual({ state: "observed", stable_observation_count: 1 });
    expect(database.prepare("PRAGMA foreign_key_list(usage_log_object_hours)").all()).toEqual([
      expect.objectContaining({
        table: "usage_log_objects",
        from: "object_key",
        to: "object_key",
        on_delete: "CASCADE",
      }),
    ]);
  });

  it("rejects invalid states, hashes, counters, and observation windows", () => {
    const database = createDatabase();

    expect(() =>
      database
        .prepare(
          `INSERT INTO usage_log_objects (
            object_key, etag, byte_size, first_seen_at, last_seen_at, state
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("trace/a", "etag", 1, 2, 1, "unknown"),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO usage_log_hour_observations (
            accounting_epoch, hour_key, object_set_sha256, object_count,
            object_bytes, first_observed_at, last_observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("b".repeat(32), 1, "not-a-hash", 1, 1, 2, 1),
    ).toThrow();
  });
});
