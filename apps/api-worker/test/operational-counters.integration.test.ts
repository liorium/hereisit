import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareOperationalCounter } from "../src/operational-counters";

const epoch = "e".repeat(32);
const now = 1_784_419_200_123;
const hourKey = Math.floor(now / 3_600_000);

beforeEach(async () => {
  await env.DB.prepare("UPDATE rollout_control SET cost_accounting_epoch = ? WHERE id = 1")
    .bind(epoch)
    .run();
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM operational_counter_hourly").run();
});

describe("operational cost counters", () => {
  it("adds content-free counters under the active accounting epoch", async () => {
    await env.DB.batch([
      prepareOperationalCounter(env.DB, {
        recordedAt: now,
        admittedJobs: 1,
        durableObjectRequests: 2,
        queueOperations: 3,
        d1RowsRead: 4,
        d1RowsWritten: 5,
        r2ClassAOperations: 6,
        r2ClassBOperations: 7,
        observabilityLogEvents: 8,
      }),
      prepareOperationalCounter(env.DB, { recordedAt: now, d1RowsRead: 10 }),
    ]);

    await expect(
      env.DB.prepare(
        `SELECT accounting_epoch, hour_key, admitted_jobs, durable_object_requests,
                queue_operations, d1_rows_read, d1_rows_written,
                r2_class_a_operations, r2_class_b_operations, observability_log_events
         FROM operational_counter_hourly`,
      ).first(),
    ).resolves.toEqual({
      accounting_epoch: epoch,
      hour_key: hourKey,
      admitted_jobs: 1,
      durable_object_requests: 2,
      queue_operations: 3,
      d1_rows_read: 14,
      d1_rows_written: 5,
      r2_class_a_operations: 6,
      r2_class_b_operations: 7,
      observability_log_events: 8,
    });
  });

  it("rolls the counter back when another statement in its batch fails", async () => {
    await expect(
      env.DB.batch([
        prepareOperationalCounter(env.DB, { recordedAt: now, queueOperations: 1 }),
        env.DB.prepare("INSERT INTO rollout_control (id) VALUES (1)"),
      ]),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM operational_counter_hourly").first("count"),
    ).resolves.toBe(0);
  });
});
