import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { readAccountingHealth, recordAccountingHealth } from "../src/accounting-health";
import { evaluateCircuitBreaker } from "../src/circuit-breaker";

const epoch = "a".repeat(32);
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM safety_incidents"),
    env.DB.prepare(
      "UPDATE rollout_control SET cost_accounting_epoch=?, circuit_open=1, reason='COST_ACCOUNTING_INCOMPLETE', opened_at=1, safety_generation=0, deletion_overdue_count=0 WHERE id=1",
    ).bind(epoch),
    env.DB.prepare(
      "UPDATE accounting_health SET epoch=?, status='unknown', reason=NULL, evaluated_at=0, pending_hour_key=NULL, unresolved_since_hour_key=NULL WHERE id=1",
    ).bind(epoch),
  ]);
});
it("migration_keeps_open_circuit and records strictly ordered health", async () => {
  expect(
    (await env.DB.prepare("SELECT circuit_open FROM rollout_control WHERE id=1").first())
      ?.circuit_open,
  ).toBe(1);
  const next = {
    epoch,
    status: "degraded" as const,
    reason: "PROVIDER_UNAVAILABLE" as const,
    evaluatedAt: 100,
    pendingHourKey: 0,
    unresolvedSinceHourKey: 0,
  };
  expect(await recordAccountingHealth(env.DB, next)).toBe("updated");
  expect(
    await recordAccountingHealth(env.DB, {
      ...next,
      evaluatedAt: 99,
      status: "healthy",
      reason: null,
      pendingHourKey: null,
      unresolvedSinceHourKey: null,
    }),
  ).toBe("stale");
  expect(
    await recordAccountingHealth(env.DB, { ...next, epoch: "b".repeat(32), evaluatedAt: 101 }),
  ).toBe("stale");
  expect(await readAccountingHealth(env.DB)).toMatchObject(next);
});
it("hard_reason_replaces_legacy_incomplete and records incident once", async () => {
  await env.DB.prepare("UPDATE rollout_control SET deletion_overdue_count=1 WHERE id=1").run();
  await evaluateCircuitBreaker(env.DB, { now: 100, maximumQueuedAgeSeconds: 600 });
  await evaluateCircuitBreaker(env.DB, { now: 101, maximumQueuedAgeSeconds: 600 });
  expect(
    await env.DB.prepare(
      "SELECT circuit_open,reason,safety_generation FROM rollout_control WHERE id=1",
    ).first(),
  ).toMatchObject({ circuit_open: 1, reason: "DELETION_OVERDUE", safety_generation: 1 });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM safety_incidents").first())?.n).toBe(1);
});
it("equal-time conflicts cannot recover health", async () => {
  const next = {
    epoch,
    status: "degraded" as const,
    reason: "PROVIDER_UNAVAILABLE" as const,
    evaluatedAt: 100,
    pendingHourKey: 0,
    unresolvedSinceHourKey: 0,
  };
  await recordAccountingHealth(env.DB, next);
  expect(
    await recordAccountingHealth(env.DB, {
      ...next,
      status: "healthy",
      reason: null,
      pendingHourKey: null,
      unresolvedSinceHourKey: null,
    }),
  ).toBe("stale");
});

it("does not claim writer history coverage from schema migration alone", async () => {
  expect(
    (
      await env.DB.prepare(
        "SELECT safety_history_started_at FROM rollout_control WHERE id=1",
      ).first()
    )?.safety_history_started_at,
  ).toBe(0);
});
