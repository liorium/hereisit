import { describe, expect, it } from "vitest";
import type { LiveCostModelV1 } from "./env";
import { calculateHourlyCosts } from "./hourly-cost";

function model(): LiveCostModelV1 {
  return {
    version: 1,
    containerVcpuSecondMicrousd: 1_000_000,
    containerGibSecondMicrousd: 1_000_000,
    containerDiskGbSecondMicrousd: 1_000_000,
    containerEgressGbMicrousd: 4_000_000,
    containerEgressRegionPricesMicrousd: { ENAM: 2_000_000, WEUR: 3_000_000 },
    containerEgressRegionPricesSha256: "a".repeat(64),
    containerInstanceVcpu: 1,
    containerInstanceMemoryGib: 6,
    containerInstanceDiskGb: 12,
    containerSleepAfterSeconds: 60,
    workersMillionRequestsMicrousd: 1_000_000,
    workersMillionCpuMsMicrousd: 1_000_000,
    durableObjectMillionRequestsMicrousd: 1_000_000,
    durableObjectGibSecondMicrousd: 1_000_000,
    durableObjectStorageGbMonthMicrousd: 1_000_000,
    r2StorageGbMonthMicrousd: 1_000_000,
    r2ClassAMillionMicrousd: 1_000_000,
    r2ClassBMillionMicrousd: 1_000_000,
    queueMillionOperationsMicrousd: 1_000_000,
    d1MillionRowsReadMicrousd: 1_000_000,
    d1MillionRowsWrittenMicrousd: 1_000_000,
    d1StorageGbMonthMicrousd: 1_000_000,
    observabilityMillionLogEventsMicrousd: 1_000_000,
    workersLogpushMillionEventsMicrousd: 1_000_000,
    analyticsEngineMillionDataPointsMicrousd: 1_000_000,
    analyticsEngineMillionReadQueriesMicrousd: 1_000_000,
    monthlyFixedMicrousd: 720,
    projectedMonthlyJobs: 10_000,
    routeCpuBenchmarkSha256: "b".repeat(64),
    routeCpuEnvelopeMs: {
      policy: 1,
      create: 1,
      upload: 1,
      read: 1,
      result: 1,
      maintenance: 1,
      queue: 1,
    },
    arrivalProjection: {
      algorithm: "arrival-union-tail-v1",
      steadyHourlyJobs: Array(24).fill(1),
      burstyHourlyJobs: Array(24).fill(1),
      sparseHourlyJobs: Array(24).fill(1),
      scenariosSha256: "c".repeat(64),
    },
  };
}

const gibByteMilliseconds = (1_073_741_824n * 1_000n).toString();
const gbByteMilliseconds = (1_000_000_000n * 1_000n).toString();
const gbMonthByteMilliseconds = (1_000_000_000n * 30n * 24n * 3_600n * 1_000n).toString();

describe("hourly live cost calculation", () => {
  it("prices every observed source with exact integer denominators", () => {
    expect(
      calculateHourlyCosts(model(), {
        workerRequests: "1",
        workerCpuMs: "1",
        containerCpuMicroseconds: "1000000",
        containerAllocatedMemoryByteMilliseconds: gibByteMilliseconds,
        containerAllocatedDiskByteMilliseconds: gbByteMilliseconds,
        containerTransmittedBytesByRegion: [
          { region: "enam", transmittedBytes: "1000000000" },
          { region: "weur", transmittedBytes: "1000000000" },
        ],
        durableObjectActiveMilliseconds: "8000",
        durableObjectRequests: "1",
        durableObjectStorageByteMilliseconds: gbMonthByteMilliseconds,
        queueOperations: "1",
        d1RowsRead: "1",
        d1RowsWritten: "1",
        d1StorageByteMilliseconds: gbMonthByteMilliseconds,
        r2ClassAOperations: "1",
        r2ClassBOperations: "1",
        r2StorageByteMilliseconds: gbMonthByteMilliseconds,
        analyticsEngineDataPoints: "1",
        analyticsEngineReadQueries: "1",
        observabilityLogEvents: "1",
        workersLogpushEvents: "1",
      }),
    ).toEqual({
      workerCostMicrousd: "2",
      containerCostMicrousd: "8000000",
      durableObjectCostMicrousd: "2000001",
      queueCostMicrousd: "1",
      d1CostMicrousd: "1000002",
      r2CostMicrousd: "1000002",
      analyticsEngineCostMicrousd: "2",
      observabilityCostMicrousd: "2",
      fixedCostMicrousd: "1",
      totalCostMicrousd: "12000013",
    });
  });

  it("rounds each billable component upward and rejects an unknown egress region", () => {
    const zeroUsage = {
      workerRequests: "1",
      workerCpuMs: "0",
      containerCpuMicroseconds: "1",
      containerAllocatedMemoryByteMilliseconds: "1",
      containerAllocatedDiskByteMilliseconds: "1",
      containerTransmittedBytesByRegion: [{ region: "enam", transmittedBytes: "1" }],
      durableObjectActiveMilliseconds: "1",
      durableObjectRequests: "0",
      durableObjectStorageByteMilliseconds: "0",
      queueOperations: "0",
      d1RowsRead: "0",
      d1RowsWritten: "0",
      d1StorageByteMilliseconds: "0",
      r2ClassAOperations: "0",
      r2ClassBOperations: "0",
      r2StorageByteMilliseconds: "0",
      analyticsEngineDataPoints: "0",
      analyticsEngineReadQueries: "0",
      observabilityLogEvents: "0",
      workersLogpushEvents: "0",
    } as const;
    expect(calculateHourlyCosts(model(), zeroUsage)).toMatchObject({
      workerCostMicrousd: "1",
      containerCostMicrousd: "4",
      durableObjectCostMicrousd: "125",
    });
    expect(() =>
      calculateHourlyCosts(model(), {
        ...zeroUsage,
        containerTransmittedBytesByRegion: [{ region: "unknown", transmittedBytes: "1" }],
      }),
    ).toThrow(/region/i);
  });
});
