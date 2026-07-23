import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createLiveCostModel,
  liveCostInputFromReleaseDocument,
  liveCostModelSha256,
  validateLiveCostModelDocument,
} from "../scripts/create-live-cost-model.mjs";
import { createProcessingReleaseInputs } from "../scripts/create-processing-release-inputs.mjs";

const routes = Object.fromEntries(
  ["policy", "create", "upload", "read", "result", "maintenance", "queue"].map((route, index) => [
    route,
    { p99Ms: index + 1, samples: 100 },
  ]),
);

const input = {
  version: 1,
  pricesUsd: {
    containerVcpuSecond: "0.000020",
    containerGibSecond: "0.000003",
    containerDiskGbSecond: "0.000001",
    containerEgressRegion: { APAC: "0.12", EU: "0.09", US: "0.08" },
    workersMillionRequests: "0.30",
    workersMillionCpuMs: "0.02",
    durableObjectMillionRequests: "0.15",
    durableObjectGibSecond: "0.000013",
    durableObjectStorageGbMonth: "0.20",
    r2StorageGbMonth: "0.015",
    r2ClassAMillion: "4.50",
    r2ClassBMillion: "0.36",
    queueMillionOperations: "0.40",
    d1MillionRowsRead: "0.001",
    d1MillionRowsWritten: "1.00",
    d1StorageGbMonth: "0.75",
    observabilityMillionLogEvents: "1.00",
    workersLogpushMillionEvents: "0.50",
    analyticsEngineMillionDataPoints: "0.25",
    analyticsEngineMillionReadQueries: "1.00",
    monthlyFixed: "0",
  },
  resources: {
    containerInstanceVcpu: 2,
    containerInstanceMemoryGib: 6,
    containerInstanceDiskGb: 12,
  },
  routeCpuBenchmark: {
    version: 1,
    sourceModuleSha256: "a".repeat(64),
    toolchain: "workerd-test@1",
    margin: { kind: "p99-plus-percent", percent: 25 },
    routes,
  },
  projectedMonthlyJobs: 10_000,
  arrivalTraces: {
    steady: Array(24).fill(417),
    bursty: [5000, 2000, ...Array(22).fill(137)],
    sparse: Array.from({ length: 24 }, (_, index) => (index % 6 === 0 ? 1 : 0)),
  },
};

describe("canonical live-cost model", () => {
  it("converts every explicit decimal price and conservatively selects maximum regional egress", () => {
    const model = createLiveCostModel(input);
    expect(model.containerEgressGbMicrousd).toBe(120_000);
    expect(model.containerSleepAfterSeconds).toBe(60);
    expect(model.routeCpuEnvelopeMs.policy).toBe(2);
    expect(model.arrivalProjection.steadyHourlyJobs).toHaveLength(24);
    expect(model.arrivalProjection.scenariosSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [
      "missing coefficient",
      () => ({ ...input, pricesUsd: { ...input.pricesUsd, r2ClassAMillion: undefined } }),
    ],
    [
      "negative coefficient",
      () => ({ ...input, pricesUsd: { ...input.pricesUsd, r2ClassAMillion: "-1" } }),
    ],
    [
      "precision loss",
      () => ({ ...input, pricesUsd: { ...input.pricesUsd, r2ClassAMillion: "0.0000001" } }),
    ],
    [
      "obsolete trace price",
      () => ({ ...input, pricesUsd: { ...input.pricesUsd, traceSpan: "1" } }),
    ],
    [
      "incomplete arrival trace",
      () => ({ ...input, arrivalTraces: { ...input.arrivalTraces, steady: [1] } }),
    ],
    [
      "missing route",
      () => ({
        ...input,
        routeCpuBenchmark: { ...input.routeCpuBenchmark, routes: { ...routes, queue: undefined } },
      }),
    ],
    ["unknown top-level field", () => ({ ...input, surprise: true })],
  ])("rejects %s", (_, mutate) => {
    expect(() => createLiveCostModel(mutate())).toThrow();
  });

  it("is canonical across input key order and hashes the exact emitted bytes", () => {
    const first = createLiveCostModel(input);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const second = createLiveCostModel(reordered);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(liveCostModelSha256(first)).toBe(liveCostModelSha256(second));
  });

  it("recreates identical bytes from an immutable production release input", () => {
    const { routeCpuBenchmark, ...modelInput } = input;
    const release = createProcessingReleaseInputs({
      version: 1,
      releaseId: "2026-07-16.1",
      baseSourceSha256: "a".repeat(64),
      reviewedAt: "2026-07-16T00:00:00.000Z",
      reviewerIdHash: "b".repeat(64),
      pricesAndResources: { version: 1, artifactSha256: "c".repeat(64), modelInput },
      ceilings: {
        maxCostPer1000JobsMicrousd: 500_000,
        maxLiveMedianOutputRatioBps: 8_000,
        maxLiveP95WeightedUnits: 12_000,
        maxLiveOriginalRetainedRateBps: 2_500,
        maxProjectedMonthlyCostMicrousd: 5_000_000,
      },
      routeCpuBenchmark: { artifactSha256: "d".repeat(64), ...routeCpuBenchmark },
    });
    expect(canonicalJson(createLiveCostModel(liveCostInputFromReleaseDocument(release)))).toBe(
      canonicalJson(createLiveCostModel(input)),
    );
  });

  it("rejects tampered arrival hashes and non-conservative regional egress", () => {
    const model = createLiveCostModel(input);
    expect(() =>
      validateLiveCostModelDocument({
        ...model,
        arrivalProjection: { ...model.arrivalProjection, scenariosSha256: "f".repeat(64) },
      }),
    ).toThrow("arrival scenario hash mismatch");
    expect(() => validateLiveCostModelDocument({ ...model, containerEgressGbMicrousd: 1 })).toThrow(
      "regional container egress price binding",
    );
  });
});
