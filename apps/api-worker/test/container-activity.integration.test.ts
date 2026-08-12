import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { recordContainerActivity } from "../src/container-activity";

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM container_activity_segments"),
    env.DB.prepare("DELETE FROM operational_counter_hourly"),
  ]);
});

describe("container activity ledger", () => {
  it("merges overlapping billing tails and preserves a real idle gap", async () => {
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000001",
      contactedAt: 1_000,
      engineIdentity: "image:slot-0",
    });
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000002",
      contactedAt: 50_000,
      engineIdentity: "image:slot-0",
    });
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000003",
      contactedAt: 120_001,
      engineIdentity: "image:slot-0",
    });

    await expect(
      env.DB.prepare(
        "SELECT engine_identity, started_at, billed_until_at FROM container_activity_segments ORDER BY started_at",
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { engine_identity: "image:slot-0", started_at: 1_000, billed_until_at: 110_000 },
        { engine_identity: "image:slot-0", started_at: 120_001, billed_until_at: 180_001 },
      ],
    });
    await expect(
      env.DB.prepare(
        `SELECT SUM(durable_object_requests) AS durable_object_requests,
                SUM(d1_rows_read) AS d1_rows_read,
                SUM(d1_rows_written) AS d1_rows_written
         FROM operational_counter_hourly`,
      ).first(),
    ).resolves.toEqual({ durable_object_requests: 3, d1_rows_read: 30, d1_rows_written: 12 });
  });

  it("merges overlaps within one engine but preserves simultaneous independent engines", async () => {
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000011",
      contactedAt: 1_000,
      engineIdentity: "image:slot-0",
    });
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000012",
      contactedAt: 20_000,
      engineIdentity: "image:slot-0",
    });
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000013",
      contactedAt: 1_000,
      engineIdentity: "pdf:slot-0",
    });

    await expect(
      env.DB.prepare(
        `SELECT engine_identity, started_at, billed_until_at
         FROM container_activity_segments ORDER BY engine_identity`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { engine_identity: "image:slot-0", started_at: 1_000, billed_until_at: 80_000 },
        { engine_identity: "pdf:slot-0", started_at: 1_000, billed_until_at: 61_000 },
      ],
    });
  });

  it("rejects replay of a segment identifier instead of losing an activity touch", async () => {
    const segmentId = "00000000-0000-4000-8000-000000000004";
    await recordContainerActivity(env.DB, {
      segmentId,
      contactedAt: 1_000,
      engineIdentity: "image:slot-0",
    });

    await expect(
      recordContainerActivity(env.DB, {
        segmentId,
        contactedAt: 2_000,
        engineIdentity: "image:slot-0",
      }),
    ).rejects.toThrow();
  });
});
