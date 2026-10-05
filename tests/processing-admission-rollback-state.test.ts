import { describe, expect, it } from "vitest";
import {
  createProcessingAdmissionRollbackBatch,
  restoreProcessingAdmissionRollbackState,
} from "../scripts/processing-admission-rollback-state.mjs";

const snapshot = {
  schema: "hereisit-processing-admission-rollback@2",
  state: {
    safetyGeneration: 0,
    circuitOpen: 0,
    circuitReason: null,
    openedAt: null,
    versionId: "00000000-0000-4000-8000-000000000001",
    workerModuleSha256: "a".repeat(64),
    generatedConfigSha256: "b".repeat(64),
    releaseReportSha256: "c".repeat(64),
    publicAdmissionAllowed: 1,
    observedAt: 100,
  },
};

function response(results: unknown[], changes = results.map(() => 1)) {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: results.map((rows, index) => ({
        success: true,
        results: rows,
        meta: { changes: changes[index], served_by_primary: true },
      })),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("processing admission rollback state", () => {
  it("restores the exact prior active policy/config binding and circuit values", () => {
    const batch = createProcessingAdmissionRollbackBatch(snapshot, 200);
    expect(batch).toHaveLength(3);
    expect(batch[0].sql).toContain("EXISTS");
    expect(batch[1].sql).toContain("worker_module_sha256 = ?");
    expect(batch[1].sql).toContain("generated_config_sha256 = ?");
    expect(batch[1].sql).toContain("release_report_sha256 = ?");
    expect(batch[0].sql).toContain("rollout_control WHERE id = 1");
    expect(batch[1].sql).toContain("rollout_control WHERE id = 1");
    expect(batch[0].params).toEqual([
      "retired",
      200,
      "active",
      snapshot.state.versionId,
      snapshot.state.versionId,
      snapshot.state.workerModuleSha256,
      snapshot.state.generatedConfigSha256,
      snapshot.state.releaseReportSha256,
    ]);
    expect(batch[2].params).toEqual([
      0,
      null,
      null,
      snapshot.state.safetyGeneration,
      snapshot.state.circuitReason,
      snapshot.state.versionId,
      snapshot.state.workerModuleSha256,
      snapshot.state.generatedConfigSha256,
      snapshot.state.releaseReportSha256,
    ]);
  });

  it("fails closed unless a primary read proves the exact prior state was restored", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? response([[], [], []], [1, 1, 1])
        : response([[{ ...snapshot.state, generatedConfigSha256: "d".repeat(64) }]]);
    };
    await expect(
      restoreProcessingAdmissionRollbackState({
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000001",
        apiToken: "private",
        snapshot,
        now: 200,
        fetchImpl,
      }),
    ).rejects.toThrow(/not restored exactly/i);
    expect(calls).toBe(2);
  });

  it("atomically aborts with no partial retirement when the exact prior tuple is absent", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response([[], [], []], [0, 0, 0]);
    };
    await expect(
      restoreProcessingAdmissionRollbackState({
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000001",
        apiToken: "private",
        snapshot,
        now: 200,
        fetchImpl,
      }),
    ).rejects.toThrow(/exact prior tuple|prerequisite/i);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ batch: expect.any(Array) });
    expect((bodies[0] as { batch: Array<{ sql: string }> }).batch).toHaveLength(3);
    expect((bodies[0] as { batch: Array<{ sql: string }> }).batch[0].sql).toContain("EXISTS");
  });
});

it("rollback_keeps_newer_hard_stop", () => {
  const batch = createProcessingAdmissionRollbackBatch(snapshot, 200);
  expect(batch[2].sql).toContain("safety_generation = ?");
  expect(batch[2].sql).toContain("reason IS ?");
});

it.each([
  [1, "VERIFICATION_FAILED"],
  [0, "COST_ACCOUNTING_HASH_MISMATCH"],
])("keeps a newer safety stop during real SQL rollback (generation %s)", async (generation, reason) => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE rollout_control (id INTEGER PRIMARY KEY, circuit_open INTEGER, reason TEXT, opened_at INTEGER, safety_generation INTEGER);
    CREATE TABLE worker_version_attestations (version_id TEXT PRIMARY KEY, worker_module_sha256 TEXT, generated_config_sha256 TEXT, release_report_sha256 TEXT, kind TEXT, public_admission_allowed INTEGER, observed_at INTEGER, retired_at INTEGER);`);
  db.prepare("INSERT INTO rollout_control VALUES (1,1,?,150,?)").run(reason, generation);
  db.prepare("INSERT INTO worker_version_attestations VALUES (?,?,?,?, 'retired', 0,100,150)").run(
    snapshot.state.versionId,
    snapshot.state.workerModuleSha256,
    snapshot.state.generatedConfigSha256,
    snapshot.state.releaseReportSha256,
  );
  db.exec("BEGIN IMMEDIATE");
  const batch = createProcessingAdmissionRollbackBatch(snapshot, 200);
  const changes = batch.map(
    ({ sql, params }: { sql: string; params: (string | number | null)[] }) =>
      Number(db.prepare(sql).run(...params).changes),
  );
  db.exec("COMMIT");
  expect(changes[2]).toBe(0);
  expect(
    db.prepare("SELECT circuit_open,reason,safety_generation FROM rollout_control").get(),
  ).toEqual({ circuit_open: 1, reason, safety_generation: generation });
  db.close();
});

it.each([
  [false, false],
  [true, false],
  [true, true],
])("captures pre-0011 state and rolls back closed (migrated: %s; new hard stop: %s)", async (migrated, newHardStop) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { captureProcessingAdmissionRollbackState } = await import(
    "../scripts/processing-admission-rollback-state.mjs"
  );
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync("apps/api-worker/migrations")
    .filter((name) => name.endsWith(".sql") && name < "0011")
    .sort())
    db.exec(readFileSync(`apps/api-worker/migrations/${name}`, "utf8"));
  db.prepare(
    "INSERT INTO worker_version_attestations(version_id,worker_module_sha256,generated_config_sha256,release_report_sha256,kind,public_admission_allowed,observed_at) VALUES (?,?,?,?,'active',1,100)",
  ).run(
    snapshot.state.versionId,
    snapshot.state.workerModuleSha256,
    snapshot.state.generatedConfigSha256,
    snapshot.state.releaseReportSha256,
  );
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = (body.batch ?? [body]).map(
        ({ sql, params }: { sql: string; params: (string | number | null)[] }) => {
          const statement = db.prepare(sql);
          const rows = statement.columns().length ? statement.all(...params) : [];
          const changes = statement.columns().length ? 0 : Number(statement.run(...params).changes);
          return { success: true, results: rows, meta: { served_by_primary: true, changes } };
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
  const directory = await mkdtemp(join(tmpdir(), "legacy-admission-"));
  const input = {
    accountId: "a".repeat(32),
    databaseId: snapshot.state.versionId,
    apiToken: "private",
    fetchImpl,
  };
  try {
    const legacy = await captureProcessingAdmissionRollbackState({
      ...input,
      output: join(directory, "snapshot.json"),
    });
    expect(legacy.state.safetyGeneration).toBeNull();
    expect(db.prepare("SELECT circuit_open FROM rollout_control").get()).toEqual({
      circuit_open: 0,
    });
    if (migrated)
      db.exec(readFileSync("apps/api-worker/migrations/0011_accounting_health.sql", "utf8"));
    if (newHardStop)
      db.exec(
        "UPDATE rollout_control SET circuit_open=1,reason='VERIFICATION_FAILED',opened_at=150,safety_generation=1",
      );
    await expect(
      restoreProcessingAdmissionRollbackState({ ...input, snapshot: legacy, now: 200 }),
    ).resolves.toMatchObject({ restored: true, versionId: snapshot.state.versionId });
    expect(
      db
        .prepare(
          migrated
            ? "SELECT circuit_open,reason,safety_generation FROM rollout_control"
            : "SELECT circuit_open,reason,NULL AS safety_generation FROM rollout_control",
        )
        .get(),
    ).toEqual({
      circuit_open: 1,
      reason: newHardStop ? "VERIFICATION_FAILED" : "OPERATOR_DISABLED",
      safety_generation: migrated ? 1 : null,
    });
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
