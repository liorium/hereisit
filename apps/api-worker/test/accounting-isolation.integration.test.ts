import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { readAccountingHealth } from "../src/accounting-health";
import { runAccountingHealthCheck } from "../src/cost-accounting-runtime";
import { ProviderUnavailableError } from "../src/provider-usage";

const epoch = "a".repeat(32);
const hour = 495672;
const now = (hour + 2) * 3600000;
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM safety_incidents"),
    env.DB.prepare(
      "UPDATE rollout_control SET cost_accounting_epoch=?,cost_accounting_started_at=?,last_sealed_hour_key=NULL,circuit_open=0,reason=NULL,opened_at=NULL,safety_generation=0 WHERE id=1",
    ).bind(epoch, hour * 3600000),
    env.DB.prepare(
      "UPDATE accounting_health SET epoch=?,status='unknown',reason=NULL,evaluated_at=0,pending_hour_key=NULL,unresolved_since_hour_key=NULL WHERE id=1",
    ).bind(epoch),
  ]);
});
function dependencies() {
  return {
    targetHour: async () => hour,
    importUsageLogs: async () => "complete" as const,
    observeUsageHour: async () => "stable" as const,
    reconcileWorker: async (): Promise<"verified"> => {
      throw new ProviderUnavailableError("HTTP", 403);
    },
    reconcileContainer: async () => "verified" as const,
    sealHour: async () => "incomplete" as const,
  };
}
it("external 403 degrades health without opening admission circuit or sealing missing costs", async () => {
  await runAccountingHealthCheck(env.DB, now, dependencies());
  expect(await readAccountingHealth(env.DB)).toMatchObject({
    status: "degraded",
    reason: "PROVIDER_UNAVAILABLE",
    unresolvedSinceHourKey: hour,
  });
  expect(
    await env.DB.prepare(
      "SELECT circuit_open,last_sealed_hour_key FROM rollout_control WHERE id=1",
    ).first(),
  ).toEqual({ circuit_open: 0, last_sealed_hour_key: null });
});
it("internal state errors open safety and are not swallowed as provider outages", async () => {
  const deps = dependencies();
  deps.reconcileWorker = async () => {
    throw new Error("internal");
  };
  await expect(runAccountingHealthCheck(env.DB, now, deps)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT circuit_open,reason FROM rollout_control WHERE id=1").first(),
  ).toEqual({ circuit_open: 1, reason: "ACCOUNTING_STATE_INVALID" });
});
it("healthy provider checks do not clear an existing safety stop or unresolved hour", async () => {
  await env.DB.prepare(
    "UPDATE rollout_control SET circuit_open=1,reason='DELETION_OVERDUE' WHERE id=1",
  ).run();
  const deps = dependencies();
  deps.reconcileWorker = async () => "verified";
  await runAccountingHealthCheck(env.DB, now, deps);
  expect((await readAccountingHealth(env.DB)).status).toBe("degraded");
  expect(
    (await env.DB.prepare("SELECT reason FROM rollout_control WHERE id=1").first())?.reason,
  ).toBe("DELETION_OVERDUE");
});

it("reports accounting conflicts as degraded before the provider deadline", async () => {
  await env.DB.prepare(
    "UPDATE rollout_control SET last_sealed_hour_key=?,circuit_open=1,reason='PROVIDER_PROOF_CONFLICT' WHERE id=1",
  )
    .bind(hour - 1)
    .run();
  await runAccountingHealthCheck(env.DB, (hour + 1) * 3600000 + 45 * 60000, {
    ...dependencies(),
    observeUsageHour: async () => "conflict",
  });
  expect(await readAccountingHealth(env.DB)).toMatchObject({
    status: "degraded",
    reason: "SAFETY_CONFLICT",
    pendingHourKey: hour,
    unresolvedSinceHourKey: hour,
  });
  expect(
    await env.DB.prepare(
      "SELECT circuit_open,reason,last_sealed_hour_key FROM rollout_control WHERE id=1",
    ).first(),
  ).toEqual({ circuit_open: 1, reason: "PROVIDER_PROOF_CONFLICT", last_sealed_hour_key: hour - 1 });
});
