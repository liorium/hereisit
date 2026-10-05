import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendAccountingAlert } from "../src/accounting-alerts";
import type { AccountingHealth } from "../src/accounting-health";

const epoch = "a".repeat(32);
const now = 1_800_000_000_000;
const tick = 300_000;
function health(status: "degraded" | "healthy", time = now): AccountingHealth {
  return {
    epoch,
    status,
    reason: status === "degraded" ? "PROVIDER_UNAVAILABLE" : null,
    evaluatedAt: time,
    pendingHourKey: status === "degraded" ? 500_000 : null,
    unresolvedSinceHourKey: status === "degraded" ? 500_000 : null,
  };
}
async function save(value: AccountingHealth) {
  await env.DB.prepare(
    `UPDATE accounting_health SET epoch=?,status=?,reason=?,evaluated_at=?,pending_hour_key=?,unresolved_since_hour_key=? WHERE id=1`,
  )
    .bind(
      value.epoch,
      value.status,
      value.reason,
      value.evaluatedAt,
      value.pendingHourKey,
      value.unresolvedSinceHourKey,
    )
    .run();
}
function send(
  value = health("degraded"),
  time = value.evaluatedAt,
  deliver = vi.fn(async () => {}),
  db = env.DB,
) {
  return sendAccountingAlert({
    db,
    health: value,
    now: time,
    environment: "production",
    send: deliver,
  });
}
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM operational_alert_state").run();
  await env.DB.prepare(
    "UPDATE rollout_control SET cost_accounting_epoch=?,circuit_open=0,reason=NULL WHERE id=1",
  )
    .bind(epoch)
    .run();
  await save(health("degraded"));
});
describe("accounting alert leases", () => {
  it("alert_on_degrade_and_recovery", async () => {
    expect(await send()).toBe("sent");
    expect(await send()).toBe("not-due");
    const recovered = health("healthy", now + tick);
    await save(recovered);
    expect(await send(recovered)).toBe("sent");
    expect(await send(recovered)).toBe("not-due");
    const degraded = health("degraded", now + 2 * tick);
    await save(degraded);
    expect(await send(degraded)).toBe("sent");
  });
  it("does not invent recovery before degradation", async () => {
    const recovered = health("healthy");
    await save(recovered);
    expect(await send(recovered)).toBe("not-due");
  });
  it("daily_reminder", async () => {
    expect(await send()).toBe("sent");
    const early = health("degraded", now + 86_400_000 - 1);
    await save(early);
    expect(await send(early)).toBe("not-due");
    const due = health("degraded", now + 86_400_000);
    await save(due);
    expect(await send(due)).toBe("sent");
  });
  it("lease_excludes_concurrent_sender", async () => {
    const deliver = vi.fn(async () => {});
    const results = await Promise.all([
      send(undefined, now, deliver),
      send(undefined, now, deliver),
    ]);
    expect(results.sort()).toEqual(["not-due", "sent"]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("failed send retries after the lease and leaves admission unchanged", async () => {
    expect(
      await send(
        undefined,
        now,
        vi.fn(async () => {
          throw Error("mail unavailable");
        }),
      ),
    ).toBe("failed");
    expect(await send(undefined, now + tick - 1)).toBe("not-due");
    expect(
      await env.DB.prepare(
        "SELECT last_sent_at FROM operational_alert_state WHERE kind='accounting-degraded'",
      ).first(),
    ).toEqual({ last_sent_at: null });
    expect(
      await env.DB.prepare("SELECT circuit_open,reason FROM rollout_control WHERE id=1").first(),
    ).toEqual({ circuit_open: 0, reason: null });
    expect(await send(undefined, now + tick)).toBe("sent");
  });
  it("send_then_record_failure retries only after the lease expires", async () => {
    const db = {
      withSession: () => {
        const session = env.DB.withSession("first-primary");
        return {
          batch: session.batch.bind(session),
          prepare: (sql: string) => {
            if (sql.includes("SET last_sent_at")) throw Error("record unavailable");
            return session.prepare(sql);
          },
        };
      },
    } as unknown as D1Database;
    expect(
      await send(
        undefined,
        now,
        vi.fn(async () => {}),
        db,
      ),
    ).toBe("failed");
    expect(await send(undefined, now + tick - 1)).toBe("not-due");
    expect(await send(undefined, now + tick)).toBe("sent");
  });
  it("stale completion cannot acknowledge a new episode", async () => {
    const delivery = vi.fn(async () => {
      const recovered = health("healthy", now + 1);
      await save(recovered);
      await send(recovered);
      const degraded = health("degraded", now + 2);
      await save(degraded);
      await send(
        degraded,
        now + 2,
        vi.fn(async () => {
          throw Error("pending");
        }),
      );
    });
    expect(await send(undefined, now, delivery)).toBe("failed");
    expect(
      await env.DB.prepare(
        "SELECT last_sent_at,event_key FROM operational_alert_state WHERE kind='accounting-degraded'",
      ).first(),
    ).toEqual({ last_sent_at: null, event_key: `${epoch}:${now + 2}` });
  });
});
