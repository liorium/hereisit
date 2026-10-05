import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  closeFailedLegacyRecoveryInD1,
  legacyRecoveryAcknowledgement,
  recoverLegacyAccountingCircuitInD1,
} from "../scripts/processing-legacy-recovery.mjs";
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
  db.function("unixepoch", () => Math.floor(now / 1000));
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

function legacyFixture() {
  const { db, input } = fixture();
  db.exec("UPDATE rollout_control SET safety_history_started_at=0,deletion_sweep_generation=1");
  db.prepare(
    "INSERT INTO maintenance_cursors(task,cursor,updated_at) VALUES ('empty-state-audit',?,?)",
  ).run(
    JSON.stringify({
      versionId: version,
      releaseReportSha256: report,
      epoch,
      safetyGeneration: 0,
      auditGeneration: 1,
      startedAt: now - 500,
      completedAt: now - 100,
      historicalSafetyUnknown: true,
    }),
    now - 100,
  );
  return {
    db,
    input: {
      ...input,
      maximumLiveCostPer1000Microusd: 100,
      maximumProjectedMonthlyCostMicrousd: 1000,
      authorization: {
        acknowledgement: legacyRecoveryAcknowledgement,
        eventName: "workflow_dispatch",
        repository: "liorium/hereisit",
        environment: "processing-production",
        sourceSha: "c".repeat(40),
        runId: "123",
        runAttempt: "1",
        actor: "operator",
        expiresAt: new Date(now + 3600000).toISOString(),
      },
    },
  };
}
describe("explicit one-time legacy recovery policy", () => {
  it("requires explicit unknown safety AND cost acceptance, records it once, and preserves gaps and quotas", async () => {
    const { db, input } = legacyFixture();
    db.exec("INSERT INTO account_usage VALUES ('day',0,123,0,0,0)");
    const health = db.prepare("SELECT * FROM accounting_health").get();
    await expect(recoverLegacyAccountingCircuitInD1(input)).resolves.toEqual({
      recovered: true,
      historicalSafetyUnknown: true,
      historicalCostUnknown: true,
      legacyStorageWritesUnknown: true,
    });
    expect(
      db
        .prepare(
          "SELECT safety_history_started_at,cost_accounting_epoch,cost_breach_count FROM rollout_control",
        )
        .get(),
    ).toEqual({ safety_history_started_at: 0, cost_accounting_epoch: epoch, cost_breach_count: 0 });
    expect(db.prepare("SELECT settled_units FROM account_usage").get()).toEqual({
      settled_units: 123,
    });
    expect(
      db.prepare("SELECT unresolved_since_hour_key,reason FROM accounting_health").get(),
    ).toMatchObject({
      unresolved_since_hour_key: health?.unresolved_since_hour_key,
      reason: "HISTORICAL_GAP",
    });
    const record = db
      .prepare("SELECT cursor FROM maintenance_cursors WHERE task='legacy-accounting-recovery'")
      .get();
    expect(JSON.parse(String(record?.cursor))).toMatchObject({
      historicalSafetyUnknown: true,
      historicalCostUnknown: true,
      legacyStorageWritesUnknown: true,
      authorization: input.authorization,
    });
    db.exec(
      "UPDATE rollout_control SET circuit_open=1,reason='COST_ACCOUNTING_INCOMPLETE',opened_at=1",
    );
    await expect(recoverLegacyAccountingCircuitInD1(input)).rejects.toThrow(/blocked/);
    db.close();
  });
  it.each([
    ["missing audit", "DELETE FROM maintenance_cursors WHERE task='empty-state-audit'"],
    ["stale audit", `UPDATE rollout_control SET deletion_sweep_started_at=${now - 3600000}`],
    ["wrong epoch", `UPDATE rollout_control SET cost_accounting_epoch='${"e".repeat(32)}'`],
    ["known cost breach", "UPDATE rollout_control SET cost_breach_count=1"],
    [
      "stale known expensive cost",
      "UPDATE rollout_control SET last_projected_monthly_cost_microusd=1001",
    ],
    [
      "stale known expensive per-job cost",
      "UPDATE rollout_control SET last_cost_per_1000_microusd=101",
    ],
    [
      "hard incident",
      "UPDATE rollout_control SET safety_generation=1,reason='VERIFICATION_FAILED'",
    ],
    ["operator stop", "UPDATE rollout_control SET reason='OPERATOR_DISABLED'"],
    ["unsettled quota", "INSERT INTO account_usage VALUES ('day',1,0,0,0,0)"],
    ["fractional quota", "INSERT INTO account_usage VALUES ('day',0,1.5,0,0,0)"],
    ["text quota", "INSERT INTO account_usage VALUES ('day',0,'broken',0,0,0)"],
    ["unsafe quota", "INSERT INTO account_usage VALUES ('day',0,9007199254740992,0,0,0)"],
    ["safety conflict", "UPDATE accounting_health SET reason='SAFETY_CONFLICT'"],
  ])("refuses %s without consuming authority", async (_label, sql) => {
    const { db, input } = legacyFixture();
    db.exec(sql);
    await expect(recoverLegacyAccountingCircuitInD1(input)).rejects.toThrow();
    expect(db.prepare("SELECT circuit_open FROM rollout_control").get()).toEqual({
      circuit_open: 1,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM maintenance_cursors WHERE task='legacy-accounting-recovery'",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });
  it.each([
    "missing acknowledgement",
    "automatic workflow",
    "expired approval",
  ])("rejects %s", async (condition) => {
    const { db, input } = legacyFixture();
    if (condition === "missing acknowledgement") input.authorization.acknowledgement = "";
    if (condition === "automatic workflow") input.authorization.eventName = "workflow_run";
    if (condition === "expired approval")
      input.authorization.expiresAt = new Date(now).toISOString();
    await expect(recoverLegacyAccountingCircuitInD1(input)).rejects.toThrow(/authorization/);
    db.close();
  });
  it("lets a newly observed hard incident win between inspection and the transaction", async () => {
    const { db, input } = legacyFixture();
    const original = input.fetchImpl;
    input.fetchImpl = async (url, init) => {
      if (JSON.parse(String(init.body)).batch)
        db.exec("UPDATE rollout_control SET safety_generation=1,reason='DELETION_OVERDUE'");
      return original(url, init);
    };
    await expect(recoverLegacyAccountingCircuitInD1(input)).rejects.toThrow(/blocked/);
    expect(db.prepare("SELECT circuit_open,reason FROM rollout_control").get()).toEqual({
      circuit_open: 1,
      reason: "DELETION_OVERDUE",
    });
    db.close();
  });
});

it("refuses an approval expiring during the D1 inspection", async () => {
  const { db, input } = legacyFixture();
  const original = input.fetchImpl;
  input.fetchImpl = async (url, init) => {
    if (JSON.parse(String(init.body)).batch)
      db.function("unixepoch", () => Math.floor(Date.parse(input.authorization.expiresAt) / 1000));
    return original(url, init);
  };
  await expect(recoverLegacyAccountingCircuitInD1(input)).rejects.toThrow(/blocked/);
  expect(db.prepare("SELECT circuit_open FROM rollout_control").get()).toEqual({ circuit_open: 1 });
  db.close();
});

it.each([
  1, 2,
])("closes a committed recovery and preserves newer hard incidents with D1 change count %i", async (changeCount) => {
  const { db, input } = legacyFixture();
  const cleanup = {
    ...input,
    runId: input.authorization.runId,
    runAttempt: input.authorization.runAttempt,
    fetchImpl: async (url: string, init: RequestInit) => {
      const response = await input.fetchImpl(url, init);
      const body = await response.json();
      // D1 includes the safety-incident trigger insert in its change count.
      if (body.result[0].meta.changes === 1) body.result[0].meta.changes = changeCount;
      return Response.json(body);
    },
  };
  await expect(closeFailedLegacyRecoveryInD1(cleanup)).resolves.toEqual({ closed: false });
  await recoverLegacyAccountingCircuitInD1(input);
  await expect(closeFailedLegacyRecoveryInD1({ ...cleanup, runId: "other" })).rejects.toThrow();
  await expect(closeFailedLegacyRecoveryInD1({ ...cleanup, runId: "456" })).resolves.toEqual({
    closed: false,
  });
  await expect(closeFailedLegacyRecoveryInD1(cleanup)).resolves.toEqual({ closed: true });
  expect(db.prepare("SELECT reason,safety_generation FROM rollout_control").get()).toEqual({
    reason: "OPERATOR_DISABLED",
    safety_generation: 1,
  });
  db.exec("UPDATE rollout_control SET reason='DELETION_OVERDUE'");
  await expect(closeFailedLegacyRecoveryInD1(cleanup)).resolves.toEqual({ closed: false });
  expect(db.prepare("SELECT reason,safety_generation FROM rollout_control").get()).toEqual({
    reason: "DELETION_OVERDUE",
    safety_generation: 1,
  });
  db.close();
});
