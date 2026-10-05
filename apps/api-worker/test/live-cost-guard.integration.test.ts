import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { OperationalConfig } from "../src/env";
import { applyLiveCostGuard } from "../src/live-cost-guard";

const epoch = "a".repeat(32),
  hash = "b".repeat(64),
  hour = 500_000,
  now = (hour + 25) * 3_600_000;
const config = {
  releaseReportSha256: hash,
  liveCostModelSha256: hash,
  maximumLiveCostPer1000Microusd: 99_999,
  maximumProjectedMonthlyCostMicrousd: 3_000_000,
} as OperationalConfig;
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operational_cost_hourly"),
    env.DB.prepare("DELETE FROM safety_incidents"),
    env.DB.prepare("DELETE FROM worker_version_attestations"),
    env.DB.prepare(
      "UPDATE rollout_control SET cost_accounting_epoch=?,last_sealed_hour_key=?,last_cost_evaluated_hour_key=NULL,circuit_open=0,reason=NULL,safety_generation=0,cost_breach_count=0 WHERE id=1",
    ).bind(epoch, hour + 23),
    env.DB.prepare(
      `INSERT INTO worker_version_attestations(version_id,worker_module_sha256,generated_config_sha256,release_report_sha256,kind,observed_at) VALUES ('00000000-0000-4000-8000-000000000001',?,?,?,'active',?)`,
    ).bind(hash, hash, hash, now),
    ...Array.from({ length: 24 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO operational_cost_hourly(accounting_epoch,hour_key,live_cost_model_sha256,provider_usage_schema_sha256,release_report_sha256,admitted_jobs,total_cost_microusd,complete,updated_at) VALUES(?,?,?,?,?,?,?,1,?)`,
      ).bind(epoch, hour + i, hash, hash, hash, i === 0 ? 1000 : 0, i === 0 ? 100000 : 0, now),
    ),
  ]);
});
describe("live cost guard application", () => {
  it("applies a verified breach exactly once", async () => {
    expect((await applyLiveCostGuard(env.DB, config, now)).kind).toBe("breach");
    expect((await applyLiveCostGuard(env.DB, config, now)).kind).toBe("breach");
    expect(
      await env.DB.prepare(
        "SELECT circuit_open,reason,safety_generation,cost_breach_count,last_cost_evaluated_hour_key FROM rollout_control WHERE id=1",
      ).first(),
    ).toEqual({
      circuit_open: 1,
      reason: "LIVE_COST_LIMIT_EXCEEDED",
      safety_generation: 1,
      cost_breach_count: 1,
      last_cost_evaluated_hour_key: hour + 23,
    });
  });
  it("a safe window never closes an existing circuit", async () => {
    await env.DB.prepare(
      "UPDATE rollout_control SET circuit_open=1,reason='DELETION_OVERDUE' WHERE id=1",
    ).run();
    expect(
      (await applyLiveCostGuard(env.DB, { ...config, maximumLiveCostPer1000Microusd: 100000 }, now))
        .kind,
    ).toBe("within-limit");
    expect(
      await env.DB.prepare("SELECT circuit_open,reason FROM rollout_control WHERE id=1").first(),
    ).toEqual({ circuit_open: 1, reason: "DELETION_OVERDUE" });
  });
  it("missing evidence retains last verified values without claiming availability", async () => {
    await applyLiveCostGuard(env.DB, config, now);
    await env.DB.prepare("DELETE FROM operational_cost_hourly WHERE hour_key=?").bind(hour).run();
    expect(await applyLiveCostGuard(env.DB, config, now)).toEqual({ kind: "unavailable" });
    expect(
      await env.DB.prepare(
        "SELECT last_cost_per_1000_microusd FROM rollout_control WHERE id=1",
      ).first(),
    ).toEqual({ last_cost_per_1000_microusd: 100000 });
  });
  it("corrupt cost evidence opens the hard safety circuit", async () => {
    await env.DB.prepare(
      "UPDATE operational_cost_hourly SET total_cost_microusd=CAST('9223372036854775807' AS INTEGER) WHERE hour_key=?",
    )
      .bind(hour)
      .run();
    await expect(applyLiveCostGuard(env.DB, config, now)).rejects.toThrow("overflow");
    expect(
      await env.DB.prepare("SELECT circuit_open,reason FROM rollout_control WHERE id=1").first(),
    ).toEqual({ circuit_open: 1, reason: "ACCOUNTING_STATE_INVALID" });
    expect(
      await env.DB.prepare(
        "SELECT reason,recorded_at FROM safety_incidents WHERE generation=1",
      ).first(),
    ).toEqual({ reason: "ACCOUNTING_STATE_INVALID", recorded_at: expect.any(Number) });
  });
  it("epoch race refuses the old decision", async () => {
    const db = {
      withSession: () => {
        const session = env.DB.withSession("first-primary");
        return {
          prepare: (sql: string) => {
            const statement = session.prepare(sql);
            if (!sql.startsWith("UPDATE rollout_control SET")) return statement;
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  await env.DB.prepare(
                    "UPDATE rollout_control SET cost_accounting_epoch=? WHERE id=1",
                  )
                    .bind("c".repeat(32))
                    .run();
                  return statement.bind(...args).run();
                },
              }),
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(await applyLiveCostGuard(db, config, now)).toEqual({ kind: "unavailable" });
    expect(
      await env.DB.prepare(
        "SELECT circuit_open,last_cost_evaluated_hour_key FROM rollout_control WHERE id=1",
      ).first(),
    ).toEqual({ circuit_open: 0, last_cost_evaluated_hour_key: null });
  });
});
