import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { auditEmptyProcessingState } from "../src/empty-state-audit";
import type { Env } from "../src/env";

const version = "00000000-0000-4000-8000-000000000001";
const report = "b".repeat(64);
const epoch = "a".repeat(32);
const runtime = {
  ...env,
  WORKER_VERSION: { id: version },
  RELEASE_REPORT_SHA256: report,
  IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
} as unknown as Env;
beforeEach(async () => {
  const objects = await env.JOB_OBJECTS.list();
  for (const object of objects.objects) await env.JOB_OBJECTS.delete(object.key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM safety_incidents"),
    env.DB.prepare("DELETE FROM maintenance_cursors WHERE task='empty-state-audit'"),
    env.DB.prepare("DELETE FROM worker_version_attestations"),
    env.DB.prepare(`INSERT INTO worker_version_attestations(version_id,worker_module_sha256,generated_config_sha256,release_report_sha256,kind,public_admission_allowed,observed_at)
      VALUES (?,?,?,?,'active',1,0)`).bind(version, report, report, report),
    env.DB.prepare(`UPDATE rollout_control SET circuit_open=1,reason='COST_ACCOUNTING_INCOMPLETE',opened_at=0,
      cost_accounting_epoch=?,safety_generation=0,safety_history_started_at=0,deletion_overdue_count=0,
      deletion_sweep_generation=0,deletion_sweep_started_at=NULL,deletion_sweep_completed_at=NULL WHERE id=1`).bind(
      epoch,
    ),
  ]);
});
it("writes fresh content-free evidence against actual Worker D1 and R2 without reopening admission", async () => {
  await expect(auditEmptyProcessingState(runtime, Date.now())).resolves.toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT circuit_open,safety_history_started_at,deletion_sweep_generation FROM rollout_control WHERE id=1",
    ).first(),
  ).toEqual({ circuit_open: 1, safety_history_started_at: 0, deletion_sweep_generation: 1 });
  expect(
    await env.DB.prepare(
      "SELECT task FROM maintenance_cursors WHERE task='empty-state-audit'",
    ).first(),
  ).toEqual({ task: "empty-state-audit" });
});
it("does not certify a nonempty real bucket", async () => {
  await env.JOB_OBJECTS.put("unknown-object", "test");
  await expect(auditEmptyProcessingState(runtime, Date.now())).resolves.toBe(false);
  expect(
    await env.DB.prepare(
      "SELECT deletion_sweep_completed_at FROM rollout_control WHERE id=1",
    ).first(),
  ).toEqual({ deletion_sweep_completed_at: null });
});
it("a new hard incident during real R2 inspection wins the D1 compare-and-set", async () => {
  const raced = {
    ...runtime,
    JOB_OBJECTS: {
      list: async (options: R2ListOptions) => {
        const result = await env.JOB_OBJECTS.list(options);
        await env.DB.prepare(
          "UPDATE rollout_control SET safety_generation=1,reason='DELETION_OVERDUE' WHERE id=1",
        ).run();
        return result;
      },
    },
  } as unknown as Env;
  await expect(auditEmptyProcessingState(raced, Date.now())).resolves.toBe(false);
  expect(
    await env.DB.prepare(
      "SELECT circuit_open,reason,deletion_sweep_completed_at FROM rollout_control WHERE id=1",
    ).first(),
  ).toEqual({ circuit_open: 1, reason: "DELETION_OVERDUE", deletion_sweep_completed_at: null });
});
