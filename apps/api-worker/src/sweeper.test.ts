import { describe, expect, it, vi } from "vitest";
import {
  nextArtifactCursor,
  resultDeletionDue,
  runScheduledMaintenanceWithDependencies,
} from "./sweeper";

const now = Date.parse("2026-07-16T12:00:00.000Z");

describe("scheduled maintenance policy", () => {
  it("keeps an active download lease across result expiry, then deletes after lease expiry", () => {
    expect(
      resultDeletionDue(
        {
          resultExpiresAt: now - 1,
          downloadAcknowledgedAt: null,
          downloadLeaseExpiresAt: now + 1,
        },
        now,
      ),
    ).toBe(false);
    expect(
      resultDeletionDue(
        {
          resultExpiresAt: now - 1,
          downloadAcknowledgedAt: null,
          downloadLeaseExpiresAt: now,
        },
        now,
      ),
    ).toBe(true);
    expect(
      resultDeletionDue(
        {
          resultExpiresAt: now + 60_000,
          downloadAcknowledgedAt: now - 1,
          downloadLeaseExpiresAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it("advances a saved R2 cursor only from an explicit truncated page", () => {
    expect(nextArtifactCursor({ truncated: true, cursor: "next" })).toBe("next");
    expect(nextArtifactCursor({ truncated: false })).toBeNull();
    expect(() => nextArtifactCursor({ truncated: true })).toThrow();
    expect(nextArtifactCursor({ truncated: false, cursor: "ignored" })).toBeNull();
  });

  it("runs outbox, recovery, expiry, and orphan work in the required order", async () => {
    const calls: string[] = [];
    const dependencies = {
      dispatchPendingOutbox: vi.fn(async () => {
        calls.push("outbox");
      }),
      recoverStale: vi.fn(async () => {
        calls.push("recovery");
      }),
      sweepExpired: vi.fn(async () => {
        calls.push("expiry");
      }),
      sweepOrphans: vi.fn(async (_env: unknown, olderThan: number) => {
        expect(olderThan).toBe(now - 10 * 60_000);
        calls.push("orphans");
      }),
    };

    await runScheduledMaintenanceWithDependencies({} as never, now, dependencies);

    expect(calls).toEqual(["outbox", "recovery", "expiry", "orphans"]);
    expect(dependencies.dispatchPendingOutbox).toHaveBeenCalledWith(expect.anything(), now, 100);
    expect(dependencies.recoverStale).toHaveBeenCalledWith(expect.anything(), now, 100);
    expect(dependencies.sweepExpired).toHaveBeenCalledWith(expect.anything(), now, 100);
    expect(dependencies.sweepOrphans).toHaveBeenCalledWith(
      expect.anything(),
      now - 10 * 60_000,
      100,
    );
  });
});
