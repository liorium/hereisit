import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { recordContainerActivity } from "../src/container-activity";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM container_activity_segments").run();
});

describe("container activity ledger", () => {
  it("merges overlapping billing tails and preserves a real idle gap", async () => {
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000001",
      contactedAt: 1_000,
    });
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000002",
      contactedAt: 50_000,
    });
    await recordContainerActivity(env.DB, {
      segmentId: "00000000-0000-4000-8000-000000000003",
      contactedAt: 120_001,
    });

    await expect(
      env.DB.prepare(
        "SELECT started_at, billed_until_at FROM container_activity_segments ORDER BY started_at",
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { started_at: 1_000, billed_until_at: 110_000 },
        { started_at: 120_001, billed_until_at: 180_001 },
      ],
    });
  });

  it("rejects replay of a segment identifier instead of losing an activity touch", async () => {
    const segmentId = "00000000-0000-4000-8000-000000000004";
    await recordContainerActivity(env.DB, { segmentId, contactedAt: 1_000 });

    await expect(
      recordContainerActivity(env.DB, { segmentId, contactedAt: 2_000 }),
    ).rejects.toThrow();
  });
});
