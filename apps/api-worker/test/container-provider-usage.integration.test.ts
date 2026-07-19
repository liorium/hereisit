import { describe, expect, it, vi } from "vitest";
import {
  providerUsageContractSha256,
  queryContainerUsageHour,
} from "../src/container-provider-usage";

describe("Container provider usage in workerd", () => {
  it("preserves provider number source text in the production runtime", async () => {
    const applicationId = "123e4567-e89b-42d3-a456-426614174000";
    const instanceId = "123e4567-e89b-42d3-a456-426614174001";
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          `{"data":{"viewer":{"accounts":[{"containersUsageAdaptiveGroups":[{"dimensions":{"datetimeHour":"2026-07-19T00:00:00Z","applicationId":"${applicationId}","instanceId":"${instanceId}","region":"weur"},"sum":{"cpuTimeSec":0.000001,"allocatedMemory":23192823398400,"allocatedDisk":43200000000000,"txBytes":9007199254740991}}]}]}},"errors":null}`,
          { headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      queryContainerUsageHour(fetcher, {
        accountId: "a".repeat(32),
        token: "analytics-read-token",
        applicationId,
        hourKey: 495_672,
        expectedSchemaSha256: await providerUsageContractSha256(),
      }),
    ).resolves.toEqual({
      cpuMicroseconds: "1",
      allocatedMemoryByteMilliseconds: "23192823398400000",
      allocatedDiskByteMilliseconds: "43200000000000000",
      transmittedBytes: "9007199254740991",
      transmittedBytesByRegion: [{ region: "weur", transmittedBytes: "9007199254740991" }],
    });
  });
});
