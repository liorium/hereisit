import { describe, expect, it, vi } from "vitest";
import {
  type CostAccountingScheduleDependencies,
  runCostAccountingSchedule,
} from "./cost-accounting-scheduler";

const hourKey = 495_672;
const hourEnd = (hourKey + 1) * 3_600_000;

function dependencies(): CostAccountingScheduleDependencies {
  return {
    targetHour: vi.fn(async () => hourKey),
    importUsageLogs: vi.fn(async () => "complete" as const),
    observeUsageHour: vi.fn(async () => "stable" as const),
    reconcileWorker: vi.fn(async () => "verified" as const),
    reconcileContainer: vi.fn(async () => "verified" as const),
    sealHour: vi.fn(async () => "sealed" as const),
  };
}

describe("cost accounting schedule", () => {
  it("does not observe an hour until every current import page is consumed", async () => {
    const deps = dependencies();
    vi.mocked(deps.importUsageLogs).mockResolvedValueOnce("partial");

    await expect(runCostAccountingSchedule(hourEnd + 35 * 60_000, deps)).resolves.toEqual({
      kind: "importing",
      hourKey,
    });
    expect(deps.observeUsageHour).not.toHaveBeenCalled();
  });

  it("waits for provider delivery and a stable two-pass object set", async () => {
    const deps = dependencies();
    await expect(runCostAccountingSchedule(hourEnd + 29 * 60_000, deps)).resolves.toEqual({
      kind: "provider-delay",
      hourKey,
    });
    expect(deps.observeUsageHour).not.toHaveBeenCalled();

    vi.mocked(deps.observeUsageHour).mockResolvedValueOnce("observed");
    await expect(runCostAccountingSchedule(hourEnd + 35 * 60_000, deps)).resolves.toEqual({
      kind: "observing",
      hourKey,
    });
    expect(deps.reconcileWorker).not.toHaveBeenCalled();
  });

  it("verifies both providers in order before sealing exactly one hour", async () => {
    const deps = dependencies();
    const result = await runCostAccountingSchedule(hourEnd + 45 * 60_000, deps);

    expect(result).toEqual({ kind: "sealed", hourKey });
    expect(deps.reconcileWorker).toHaveBeenCalledWith(hourKey, hourEnd + 45 * 60_000);
    expect(deps.reconcileContainer).toHaveBeenCalledWith(hourKey, hourEnd + 45 * 60_000);
    expect(deps.sealHour).toHaveBeenCalledWith(hourEnd + 45 * 60_000);
    expect(vi.mocked(deps.reconcileWorker).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.reconcileContainer).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops before Container reconciliation when Worker evidence is incomplete", async () => {
    const deps = dependencies();
    vi.mocked(deps.reconcileWorker).mockResolvedValueOnce("incomplete");

    await expect(runCostAccountingSchedule(hourEnd + 45 * 60_000, deps)).resolves.toEqual({
      kind: "worker-incomplete",
      hourKey,
    });
    expect(deps.reconcileContainer).not.toHaveBeenCalled();
    expect(deps.sealHour).not.toHaveBeenCalled();
  });

  it("forces the sealer to open the circuit at the one-hour completeness deadline", async () => {
    const deps = dependencies();
    vi.mocked(deps.reconcileWorker).mockResolvedValueOnce("incomplete");
    vi.mocked(deps.sealHour).mockResolvedValueOnce("conflict");

    await expect(runCostAccountingSchedule(hourEnd + 60 * 60_000, deps)).resolves.toEqual({
      kind: "conflict",
      hourKey,
    });
    expect(deps.sealHour).toHaveBeenCalledOnce();
  });
});
