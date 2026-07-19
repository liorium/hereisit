import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationPath = "apps/api-worker/migrations/0003_circuit_breaker.sql";

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const path of [
    "apps/api-worker/migrations/0001_processing_jobs.sql",
    "apps/api-worker/migrations/0002_worker_version_attestations.sql",
    migrationPath,
  ]) {
    database.exec(readFileSync(path, "utf8"));
  }
  return database;
}

describe("circuit breaker D1 migration", () => {
  it("is checked in after the Worker attestation migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("extends the singleton with initialized, bounded operational state", () => {
    const database = createDatabase();
    const columns = database
      .prepare("PRAGMA table_info(rollout_control)")
      .all()
      .map((column) => column.name);

    expect(columns).toEqual([
      "id",
      "circuit_open",
      "reason",
      "opened_at",
      "cost_accounting_epoch",
      "last_evaluated_at",
      "last_sample_size",
      "traffic_breach_count",
      "traffic_breach_reason",
      "traffic_breach_window_started_at",
      "cost_breach_count",
      "cost_breach_window_started_at",
      "last_cost_per_1000_microusd",
      "last_projected_monthly_cost_microusd",
      "cost_accounting_started_at",
      "first_admitted_at",
      "last_sealed_hour_key",
      "last_cost_evaluated_hour_key",
      "last_cost_window_complete",
      "deletion_overdue_count",
      "deletion_sweep_generation",
      "deletion_sweep_started_at",
      "deletion_sweep_completed_at",
      "manual_reset_at",
    ]);
    expect(
      database
        .prepare(
          `SELECT
            circuit_open AS circuitOpen,
            cost_accounting_epoch AS accountingEpoch,
            cost_accounting_started_at AS accountingStartedAt,
            last_sample_size AS lastSampleSize,
            traffic_breach_count AS trafficBreachCount,
            cost_breach_count AS costBreachCount,
            last_cost_window_complete AS costWindowComplete,
            deletion_overdue_count AS deletionOverdueCount,
            deletion_sweep_generation AS deletionSweepGeneration
          FROM rollout_control WHERE id = 1`,
        )
        .get(),
    ).toMatchObject({
      circuitOpen: 0,
      accountingEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
      accountingStartedAt: expect.any(Number),
      lastSampleSize: 0,
      trafficBreachCount: 0,
      costBreachCount: 0,
      costWindowComplete: 0,
      deletionOverdueCount: 0,
      deletionSweepGeneration: 0,
    });
  });

  it("stores content-free alert state and cascade-safe artifact presence audits", () => {
    const database = createDatabase();

    database
      .prepare(
        `INSERT INTO operational_alert_state (
          kind, active, last_sent_at, recovered_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("circuit-open", 1, 1_700_000_000_000, null);
    expect(
      database.prepare("SELECT * FROM operational_alert_state WHERE kind = ?").get("circuit-open"),
    ).toEqual({
      kind: "circuit-open",
      active: 1,
      last_sent_at: 1_700_000_000_000,
      recovered_at: null,
    });
    expect(() =>
      database
        .prepare("INSERT INTO operational_alert_state (kind, active) VALUES ('invalid flag', 2)")
        .run(),
    ).toThrow();

    expect(database.prepare("PRAGMA foreign_key_list(artifact_presence_audit)").all()).toEqual([
      expect.objectContaining({
        table: "jobs",
        from: "job_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    ]);
    const indexes = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (?, ?) ORDER BY name",
      )
      .all("jobs_health_window_idx", "operational_alert_active_idx");
    expect(indexes).toEqual([
      { name: "jobs_health_window_idx" },
      { name: "operational_alert_active_idx" },
    ]);
  });

  it("rejects malformed breaker, alert, and artifact audit state", () => {
    const database = createDatabase();

    expect(() =>
      database.prepare("UPDATE rollout_control SET traffic_breach_count = -1 WHERE id = 1").run(),
    ).toThrow();
    expect(() =>
      database
        .prepare("UPDATE rollout_control SET last_cost_window_complete = 2 WHERE id = 1")
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO operational_alert_state (
            kind, active, last_sent_at, recovered_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run("cost-limit", 1, 200, 100),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact_presence_audit (
            job_id, input_exists, output_exists, checked_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run("missing-job", 2, 0, 0),
    ).toThrow();
  });
});
