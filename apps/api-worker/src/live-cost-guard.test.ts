import { describe, expect, it } from "vitest";
import { evaluateLiveCostWindow, type LiveCostHour } from "./live-cost-guard";

const epoch = "a".repeat(32);
const hash = "b".repeat(64);
const hour = 500_000;
const rows = (): LiveCostHour[] =>
  Array.from({ length: 24 }, (_, i) => ({
    hourKey: hour + i,
    epoch,
    releaseReportSha256: hash,
    liveCostModelSha256: hash,
    complete: true,
    totalCostMicrousd: i === 0 ? "100000" : "0",
    admittedJobs: i === 0 ? "1000" : "0",
  }));
const input = () => ({
  now: (hour + 25) * 3_600_000,
  epoch,
  releaseReportSha256: hash,
  liveCostModelSha256: hash,
  maximumLiveCostPer1000Microusd: 100000,
  maximumProjectedMonthlyCostMicrousd: 3000000,
  rows: rows(),
});
describe("verified live cost window", () => {
  it("complete_window_boundary", () => {
    expect(evaluateLiveCostWindow(input())).toEqual({
      kind: "within-limit",
      endHourKey: hour + 23,
      costPer1000Microusd: "100000",
      projectedMonthlyCostMicrousd: "3000000",
    });
    expect(evaluateLiveCostWindow({ ...input(), maximumLiveCostPer1000Microusd: 99999 }).kind).toBe(
      "breach",
    );
    expect(
      evaluateLiveCostWindow({ ...input(), maximumProjectedMonthlyCostMicrousd: 2999999 }).kind,
    ).toBe("breach");
  });
  it("zero_jobs", () =>
    expect(
      evaluateLiveCostWindow({
        ...input(),
        rows: rows().map((r) => ({ ...r, admittedJobs: "0" })),
      }),
    ).toMatchObject({
      kind: "within-limit",
      costPer1000Microusd: null,
      projectedMonthlyCostMicrousd: "3000000",
    }));
  it("stale_duplicate_future_or_mixed_window", () => {
    for (const mutate of [
      (r: LiveCostHour[]) => r.slice(1),
      (r: LiveCostHour[]) => [...r.slice(0, 1), ...r.slice(0, 23)],
      (r: LiveCostHour[]) => r.map((v, i) => (i ? v : { ...v, complete: false })),
      (r: LiveCostHour[]) => r.map((v, i) => (i ? v : { ...v, epoch: "c".repeat(32) })),
      (r: LiveCostHour[]) =>
        r.map((v, i) => (i ? v : { ...v, releaseReportSha256: "c".repeat(64) })),
      (r: LiveCostHour[]) => r.map((v) => ({ ...v, hourKey: v.hourKey + 2 })),
    ])
      expect(evaluateLiveCostWindow({ ...input(), rows: mutate(rows()) })).toEqual({
        kind: "unavailable",
      });
    expect(evaluateLiveCostWindow({ ...input(), now: (hour + 26) * 3_600_000 + 1 })).toEqual({
      kind: "unavailable",
    });
  });
  it("rounds up using exact integer arithmetic above Number precision", () => {
    const exactRows = rows().map((row, i) => ({
      ...row,
      totalCostMicrousd: i === 0 ? "9007199254740993" : "0",
      admittedJobs: i === 0 ? "9007199254740992" : "0",
    }));
    expect(evaluateLiveCostWindow({ ...input(), rows: exactRows })).toMatchObject({
      kind: "breach",
      costPer1000Microusd: "1001",
      projectedMonthlyCostMicrousd: "270215977642229790",
    });
  });
  it("overflow_is_not_zero", () => {
    for (const value of ["-1", "01", "9223372036854775808", "307445734561825861"])
      expect(() =>
        evaluateLiveCostWindow({
          ...input(),
          rows: rows().map((r, i) => (i ? r : { ...r, totalCostMicrousd: value })),
        }),
      ).toThrow();
  });
});
