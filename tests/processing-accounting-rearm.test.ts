import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  disableProcessingAdmissionInD1,
  rearmAccountingOnlyCircuitInD1,
} from "../scripts/verify-processing-admission-state.mjs";

const now = Date.parse("2026-10-05T12:00:00Z");
const version = "00000000-0000-4000-8000-000000000001";
const epoch = "a".repeat(32);
const report = "b".repeat(64);

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("apps/api-worker/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(`apps/api-worker/migrations/${file}`, "utf8"));
  }
  db.prepare(
    `INSERT INTO worker_version_attestations (version_id,worker_module_sha256,generated_config_sha256,release_report_sha256,kind,public_admission_allowed,observed_at) VALUES (?, ?, ?, ?, 'active', 1, ?)`,
  ).run(version, report, report, report, now - 1000);
  db.prepare(
    `UPDATE rollout_control SET circuit_open=1, reason='COST_ACCOUNTING_INCOMPLETE', opened_at=?, cost_accounting_epoch=?, safety_history_started_at=?, deletion_sweep_started_at=?, deletion_sweep_completed_at=?`,
  ).run(now - 1000, epoch, now - 2000, now - 500, now - 100);
  db.prepare(
    `UPDATE accounting_health SET epoch=?, status='degraded', reason='PROVIDER_UNAVAILABLE', evaluated_at=?, pending_hour_key=1, unresolved_since_hour_key=1`,
  ).run(epoch, now - 1000);
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const statements = body.batch ?? [body];
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(
        ({ sql, params }: { sql: string; params: (string | number | null)[] }) => {
          const statement = db.prepare(sql);
          const rows = statement.columns().length ? statement.all(...params) : [];
          const changes = statement.columns().length ? 0 : Number(statement.run(...params).changes);
          return { success: true, results: rows, meta: { changes, served_by_primary: true } };
        },
      );
      db.exec("COMMIT");
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const input = {
    accountId: "a".repeat(32),
    databaseId: version,
    apiToken: "test",
    expectedVersionId: version,
    expectedReleaseReportSha256: report,
    expectedEpoch: epoch,
    expectedSafetyGeneration: 0,
    now,
    fetchImpl,
  };
  return { db, input };
}

function addJob(db: DatabaseSync, status: string) {
  db.exec(
    "INSERT INTO anonymous_usage(session_hash,day_key,created_at,updated_at) VALUES ('session','day',0,0)",
  );
  db.prepare(`INSERT INTO jobs (id, client_request_id, token_hash, session_hash, day_key, status, phase,
    contract_id, spec_json, spec_hash, declared_bytes, declared_mime, declared_width, declared_height,
    input_key, reserved_units, actual_units, resource_class, queue_epoch, upload_expires_at, created_at, updated_at, finished_at, settlement_state)
    VALUES ('job','request','token','session','day',?,'done','image.optimize@1','{}','hash',1,'image/png',1,1,
      'input',1,1,'image-standard-v1','queue',1,0,1,1,'settled')`).run(status);
  db.exec("INSERT INTO usage_ledger VALUES ('job','session',NULL,'day',1,1,'succeeded',1,0)");
}

describe("accounting-only circuit rearm", () => {
  it("only_exact_incomplete_can_rearm without clearing health or counters", async () => {
    const { db, input } = fixture();
    db.exec("UPDATE rollout_control SET cost_breach_count=2");
    const health = db.prepare("SELECT * FROM accounting_health").get();
    await expect(rearmAccountingOnlyCircuitInD1(input)).resolves.toEqual({ rearmed: true });
    expect(
      db
        .prepare(
          "SELECT circuit_open, reason, cost_breach_count, safety_generation FROM rollout_control",
        )
        .get(),
    ).toEqual({ circuit_open: 0, reason: null, cost_breach_count: 2, safety_generation: 0 });
    expect(db.prepare("SELECT * FROM accounting_health").get()).toEqual(health);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM maintenance_cursors WHERE task='accounting-only-rearm'",
        )
        .get(),
    ).toEqual({ count: 1 });
    db.close();
  });

  it.each([
    "COST_ACCOUNTING_HASH_MISMATCH",
    "PROVIDER_USAGE_UNATTESTED_VERSION",
    "OPERATOR_DISABLED",
    "UNKNOWN_REASON",
  ])("rejects %s", async (reason) => {
    const { db, input } = fixture();
    db.prepare("UPDATE rollout_control SET reason=?").run(reason);
    await expect(rearmAccountingOnlyCircuitInD1(input)).rejects.toThrow(/prerequisite|proof/i);
    expect(db.prepare("SELECT circuit_open FROM rollout_control").get()).toEqual({
      circuit_open: 1,
    });
    db.close();
  });

  it.each([
    [
      "hard_incident_after_inspection",
      "UPDATE rollout_control SET safety_generation=1, reason='VERIFICATION_FAILED'",
    ],
    ["missing_evidence_is_not_safe", "UPDATE rollout_control SET safety_history_started_at=0"],
    [
      "history starts after legacy block",
      `UPDATE rollout_control SET safety_history_started_at=${now}`,
    ],
    ["stale epoch", "UPDATE rollout_control SET cost_accounting_epoch='other'"],
    [
      "changed release",
      `UPDATE worker_version_attestations SET release_report_sha256='${"c".repeat(64)}'`,
    ],
    ["missing deletion audit", "UPDATE rollout_control SET deletion_sweep_completed_at=NULL"],
    ["quota inconsistency", "INSERT INTO account_usage VALUES ('2026-10-05',1,0,0,0,0)"],
    [
      "retained hard incident",
      `INSERT INTO safety_incidents VALUES (1,'COST_ACCOUNTING_HASH_MISMATCH',${now - 500})`,
    ],
  ])("rejects %s", async (_label, sql) => {
    const { db, input } = fixture();
    db.exec(sql);
    await expect(rearmAccountingOnlyCircuitInD1(input)).rejects.toThrow(/prerequisite|proof/i);
    expect(db.prepare("SELECT circuit_open FROM rollout_control").get()).toEqual({
      circuit_open: 1,
    });
    db.close();
  });
  it.each([
    "active job",
    "unsent outbox",
    "invalid queue timestamp",
    "inconsistent ledger",
  ])("rejects %s", async (condition) => {
    const { db, input } = fixture();
    addJob(db, condition === "active job" ? "running" : "succeeded");
    if (condition === "unsent outbox")
      db.exec("INSERT INTO job_outbox(job_id,payload,next_attempt_at) VALUES ('job','{}',0)");
    if (condition === "invalid queue timestamp") db.exec("UPDATE jobs SET queued_at=2");
    if (condition === "inconsistent ledger") db.exec("UPDATE usage_ledger SET actual_units=2");
    await expect(rearmAccountingOnlyCircuitInD1(input)).rejects.toThrow(/prerequisite|proof/i);
    expect(db.prepare("SELECT circuit_open FROM rollout_control").get()).toEqual({
      circuit_open: 1,
    });
    db.close();
  });
});

it("operator disable supersedes legacy accounting and records a hard generation", async () => {
  const { db, input } = fixture();
  await expect(disableProcessingAdmissionInD1(input)).resolves.toEqual({
    disabled: true,
    circuitOpen: true,
  });
  expect(
    db.prepare("SELECT circuit_open,reason,safety_generation FROM rollout_control").get(),
  ).toEqual({ circuit_open: 1, reason: "OPERATOR_DISABLED", safety_generation: 1 });
  expect(db.prepare("SELECT reason FROM safety_incidents").get()).toEqual({
    reason: "OPERATOR_DISABLED",
  });
  expect(
    (db.prepare("SELECT recorded_at FROM safety_incidents").get() as { recorded_at: number })
      .recorded_at,
  ).toBeGreaterThanOrEqual(now);
  db.close();
});
