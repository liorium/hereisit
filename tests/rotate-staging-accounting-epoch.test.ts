import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rotateStagingAccountingEpoch } from "../scripts/rotate-staging-accounting-epoch.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const databaseId = "11111111-2222-3333-4444-555555555555";
const releaseReportSha256 = "a".repeat(64);
const now = Date.parse("2026-07-30T05:40:00.000Z");

function result(results: unknown[], changes = 0) {
  return {
    success: true,
    meta: {
      changed_db: changes > 0,
      changes,
      duration: 0.2,
      last_row_id: 0,
      rows_read: results.length,
      rows_written: changes,
      served_by_colo: "ICN",
      served_by_primary: true,
      served_by_region: "APAC",
      size_after: 4096,
      timings: { sql_duration_ms: 0.2 },
    },
    results,
  };
}

function response(results: ReturnType<typeof result>[]) {
  return new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result: results }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const path of [
    "apps/api-worker/migrations/0001_processing_jobs.sql",
    "apps/api-worker/migrations/0002_worker_version_attestations.sql",
    "apps/api-worker/migrations/0003_circuit_breaker.sql",
    "apps/api-worker/migrations/0004_live_cost_accounting.sql",
    "apps/api-worker/migrations/0005_usage_log_ledger.sql",
    "apps/api-worker/migrations/0006_container_provider_egress.sql",
    "apps/api-worker/migrations/0007_operational_counters.sql",
  ]) {
    database.exec(readFileSync(path, "utf8"));
  }
  database
    .prepare(
      `INSERT INTO worker_version_attestations (
        version_id, worker_module_sha256, generated_config_sha256,
        release_report_sha256, kind, public_admission_allowed, observed_at
      ) VALUES (?, ?, ?, ?, 'active', 1, ?)`,
    )
    .run(
      "123e4567-e89b-42d3-a456-426614174000",
      "b".repeat(64),
      "c".repeat(64),
      releaseReportSha256,
      now - 1,
    );
  return database;
}

describe("staging cost-accounting epoch rotation", () => {
  it("rotates once from a recovered operator-disabled release", async () => {
    const database = migratedDatabase();
    database.exec(
      "UPDATE rollout_control SET circuit_open = 1, reason = 'OPERATOR_DISABLED', opened_at = 1",
    );
    const calls: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if ("batch" in body) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = body.batch.map(
            (statement: { sql: string; params: (string | number)[] }) => {
              const changes = Number(
                database.prepare(statement.sql).run(...statement.params).changes,
              );
              return result([], changes);
            },
          );
          database.exec("COMMIT");
          return response(results);
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      return response([
        result(database.prepare(body.sql).all(...body.params) as Record<string, unknown>[]),
      ]);
    };

    const rotated = await rotateStagingAccountingEpoch({
      accountId,
      databaseId,
      apiToken: "d1-token",
      releaseReportSha256,
      now,
      fetchImpl,
    });

    expect(rotated).toMatchObject({
      rotated: true,
      accountingStartedAt: Date.parse("2026-07-30T06:00:00.000Z"),
    });
    expect(rotated.accountingEpoch).toMatch(/^[0-9a-f]{32}$/);
    expect(
      database
        .prepare(
          `SELECT circuit_open AS circuitOpen, reason,
                  cost_accounting_epoch AS accountingEpoch
           FROM rollout_control WHERE id = 1`,
        )
        .get(),
    ).toEqual({ circuitOpen: 0, reason: null, accountingEpoch: rotated.accountingEpoch });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0])).toContain("deletion_overdue_count = 0");
    expect(JSON.stringify(calls[0])).toContain("status NOT IN");
    expect(JSON.stringify(calls[0])).toContain("COST_ACCOUNTING_INCOMPLETE");
    expect(JSON.stringify(calls)).not.toContain("d1-token");
  });

  it("is idempotent for the same release without reopening a later circuit", async () => {
    const accountingEpoch = "b".repeat(32);
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if ("batch" in body) return response([result([], 0), result([], 0)]);
      return response([
        result([
          {
            accountingEpoch,
            accountingStartedAt: Date.parse("2026-07-30T06:00:00.000Z"),
            circuitOpen: 1,
            reason: "VERIFICATION_FAILED",
            openedAt: now + 1,
            manualResetAt: now,
            lastSealedHourKey: 496100,
            releaseMarker: releaseReportSha256,
            activeReleaseCount: 1,
            nonterminalJobCount: 0,
            deletionOverdueCount: 0,
          },
        ]),
      ]);
    };

    await expect(
      rotateStagingAccountingEpoch({
        accountId,
        databaseId,
        apiToken: "d1-token",
        releaseReportSha256,
        now,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ rotated: false, accountingEpoch, circuitOpen: true });
  });

  it("rearms one stale unsealed epoch before delayed public admission", async () => {
    const database = migratedDatabase();
    database
      .prepare(
        `UPDATE rollout_control
         SET cost_accounting_started_at = ?, circuit_open = 1,
             reason = 'COST_ACCOUNTING_INCOMPLETE', opened_at = ?`,
      )
      .run(now - 4 * 3_600_000, now - 1);
    database
      .prepare(
        `INSERT INTO maintenance_cursors (task, cursor, updated_at)
         VALUES ('cost-accounting-release', ?, ?)`,
      )
      .run(releaseReportSha256, now - 4 * 3_600_000);
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if ("batch" in body) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = body.batch.map(
            (statement: { sql: string; params: (string | number)[] }) => {
              const changes = Number(
                database.prepare(statement.sql).run(...statement.params).changes,
              );
              return result([], changes);
            },
          );
          database.exec("COMMIT");
          return response(results);
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      return response([
        result(database.prepare(body.sql).all(...body.params) as Record<string, unknown>[]),
      ]);
    };

    await expect(
      rotateStagingAccountingEpoch({
        accountId,
        databaseId,
        apiToken: "d1-token",
        releaseReportSha256,
        now,
        mode: "public-admission-rearm",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      rotated: true,
      accountingStartedAt: Date.parse("2026-07-30T06:00:00.000Z"),
      circuitOpen: false,
    });
    expect(
      database
        .prepare("SELECT cursor FROM maintenance_cursors WHERE task = ?")
        .get("cost-accounting-public-admission"),
    ).toEqual({ cursor: releaseReportSha256 });

    await expect(
      rotateStagingAccountingEpoch({
        accountId,
        databaseId,
        apiToken: "d1-token",
        releaseReportSha256,
        now,
        mode: "public-admission-rearm",
        fetchImpl,
      }),
    ).resolves.toMatchObject({ rotated: false, circuitOpen: false });

    database
      .prepare(
        `UPDATE rollout_control
         SET cost_accounting_started_at = ?, circuit_open = 1,
             reason = 'VERIFICATION_FAILED', opened_at = ?`,
      )
      .run(now - 4 * 3_600_000, now + 1);
    await expect(
      rotateStagingAccountingEpoch({
        accountId,
        databaseId,
        apiToken: "d1-token",
        releaseReportSha256,
        now: now + 2,
        mode: "public-admission-rearm",
        fetchImpl,
      }),
    ).rejects.toThrow(/guard|converge/i);
  });

  it("rejects a new-release rotation when guarded state did not converge", async () => {
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if ("batch" in body) return response([result([], 0), result([], 0)]);
      return response([
        result([
          {
            accountingEpoch: "b".repeat(32),
            accountingStartedAt: now,
            circuitOpen: 1,
            reason: "DELETION_OVERDUE",
            openedAt: now,
            manualResetAt: null,
            lastSealedHourKey: null,
            releaseMarker: null,
            activeReleaseCount: 1,
            nonterminalJobCount: 0,
            deletionOverdueCount: 1,
          },
        ]),
      ]);
    };

    await expect(
      rotateStagingAccountingEpoch({
        accountId,
        databaseId,
        apiToken: "d1-token",
        releaseReportSha256,
        now,
        fetchImpl,
      }),
    ).rejects.toThrow(/guard|converge/i);
  });
});
