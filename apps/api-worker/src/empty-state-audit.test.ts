import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { auditEmptyProcessingState } from "./empty-state-audit";
import type { Env } from "./env";

const now = Date.parse("2026-10-05T12:00:00Z");
const version = "00000000-0000-4000-8000-000000000001";
const report = "b".repeat(64);
const epoch = "a".repeat(32);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const root = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, root), "utf8"));
  db.prepare(`INSERT INTO worker_version_attestations
    (version_id,worker_module_sha256,generated_config_sha256,release_report_sha256,kind,public_admission_allowed,observed_at)
    VALUES (?,?,?,?, 'active',1,?)`).run(version, report, report, report, now - 20 * 60_000);
  db.prepare(`UPDATE rollout_control SET circuit_open=1,reason='COST_ACCOUNTING_INCOMPLETE',
    opened_at=?,cost_accounting_epoch=?,deletion_overdue_count=2`).run(now - 100, epoch);
  const prepare = (sql: string) => {
    let params: SQLInputValue[] = [];
    return {
      bind(...values: SQLInputValue[]) {
        params = values;
        return this;
      },
      async first() {
        return db.prepare(sql).get(...params) ?? null;
      },
      async run() {
        return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
      },
    };
  };
  const session = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const list = vi.fn(async () => ({ objects: [] as unknown[], truncated: false }));
  const env = {
    DB: { withSession: () => session },
    JOB_OBJECTS: { list },
    WORKER_VERSION: { id: version },
    RELEASE_REPORT_SHA256: report,
    IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
  } as unknown as Env;
  vi.spyOn(Date, "now").mockReturnValue(now + 1);
  return { db, env, list };
}
function addJob(db: DatabaseSync) {
  db.exec(`INSERT INTO anonymous_usage(session_hash,day_key,created_at,updated_at) VALUES ('session','day',0,0);
    INSERT INTO jobs(id,client_request_id,token_hash,session_hash,day_key,status,phase,contract_id,spec_json,spec_hash,
    declared_bytes,declared_mime,declared_width,declared_height,input_key,reserved_units,resource_class,queue_epoch,upload_expires_at,created_at,updated_at)
    VALUES ('job','request','token','session','day','created','created','image.optimize@1','{}','hash',1,'image/png',1,1,'input',1,'image-standard-v1','queue',1,0,0);`);
}
it("records only current empty-state evidence and preserves unknown history, circuit, counters and quotas", async () => {
  const { db, env, list } = fixture();
  db.exec(
    "UPDATE rollout_control SET cost_breach_count=2; INSERT INTO account_usage VALUES ('day',0,123,0,0,0)",
  );
  await expect(auditEmptyProcessingState(env, now)).resolves.toBe(true);
  expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 1 });
  expect(
    db
      .prepare(`SELECT circuit_open,reason,safety_generation,safety_history_started_at,cost_breach_count,
    deletion_overdue_count,deletion_sweep_generation,deletion_sweep_started_at,deletion_sweep_completed_at FROM rollout_control`)
      .get(),
  ).toEqual({
    circuit_open: 1,
    reason: "COST_ACCOUNTING_INCOMPLETE",
    safety_generation: 0,
    safety_history_started_at: 0,
    cost_breach_count: 2,
    deletion_overdue_count: 0,
    deletion_sweep_generation: 1,
    deletion_sweep_started_at: now,
    deletion_sweep_completed_at: now + 1,
  });
  expect(db.prepare("SELECT settled_units FROM account_usage").get()).toEqual({
    settled_units: 123,
  });
  const receipt = db
    .prepare("SELECT cursor FROM maintenance_cursors WHERE task='empty-state-audit'")
    .get();
  expect(JSON.parse(String(receipt?.cursor))).toMatchObject({
    versionId: version,
    epoch,
    historicalSafetyUnknown: true,
  });
});
it.each([
  "nonempty",
  "truncated",
  "listing failure",
  "new job",
  "new generation",
  "new epoch",
  "new release",
  "quota race",
])("does not attest %s", async (condition) => {
  const { db, env, list } = fixture();
  list.mockImplementationOnce(async () => {
    if (condition === "listing failure") throw new Error("storage unavailable");
    if (condition === "new job") addJob(db);
    if (condition === "new generation")
      db.exec("UPDATE rollout_control SET safety_generation=1, reason='VERIFICATION_FAILED'");
    if (condition === "new epoch")
      db.exec(`UPDATE rollout_control SET cost_accounting_epoch='${"c".repeat(32)}'`);
    if (condition === "new release")
      db.exec(`UPDATE worker_version_attestations SET release_report_sha256='${"c".repeat(64)}'`);
    if (condition === "quota race") db.exec("INSERT INTO account_usage VALUES ('day',1,0,1,0,0)");
    return { objects: condition === "nonempty" ? [{}] : [], truncated: condition === "truncated" };
  });
  if (condition === "listing failure")
    await expect(auditEmptyProcessingState(env, now)).rejects.toThrow("storage unavailable");
  else await expect(auditEmptyProcessingState(env, now)).resolves.toBe(false);
  expect(db.prepare("SELECT deletion_sweep_completed_at FROM rollout_control").get()).toEqual({
    deletion_sweep_completed_at: null,
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM maintenance_cursors").get()).toEqual({
    count: 0,
  });
});
it.each([
  "public rollout",
  "open admission",
  "retained job",
  "recent active version",
])("does not inspect storage for %s", async (condition) => {
  const { db, env, list } = fixture();
  if (condition === "public rollout")
    Object.assign(env, { IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "100" });
  if (condition === "open admission") db.exec("UPDATE rollout_control SET circuit_open=0");
  if (condition === "retained job") addJob(db);
  if (condition === "recent active version")
    db.prepare("UPDATE worker_version_attestations SET observed_at=?").run(now - 14 * 60_000);
  await expect(auditEmptyProcessingState(env, now)).resolves.toBe(false);
  expect(list).not.toHaveBeenCalled();
});
