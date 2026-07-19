import { describe, expect, it, vi } from "vitest";
import { providerUsageContractSha256, queryContainerUsageHour } from "./container-provider-usage";

const accountId = "a".repeat(32);
const token = "analytics-read-token";
const applicationId = "123e4567-e89b-42d3-a456-426614174000";
const instanceId = "123e4567-e89b-42d3-a456-426614174001";
const hourKey = 495_672;

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function usageBody(overrides = ""): string {
  return `{
    "data":{"viewer":{"accounts":[{"containersUsageAdaptiveGroups":[{
      "dimensions":{
        "datetimeHour":"2026-07-19T00:00:00.000Z",
        "applicationId":"${applicationId}",
        "instanceId":"${instanceId}",
        "region":"enam"
      },
      "sum":{
        "cpuTimeSec":1.234567,
        "allocatedMemory":6442450944,
        "allocatedDisk":12000000000,
        "txBytes":123${overrides}
      }
    }]}]}},
    "errors":null
  }`;
}

async function validInput() {
  return {
    accountId,
    token,
    applicationId,
    hourKey,
    expectedSchemaSha256: await providerUsageContractSha256(),
  };
}

describe("Cloudflare Container provider usage", () => {
  it("queries the exact hour and converts provider decimals without floating-point arithmetic", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(usageBody()),
    );

    await expect(queryContainerUsageHour(fetcher, await validInput())).resolves.toEqual({
      cpuMicroseconds: "1234567",
      allocatedMemoryByteMilliseconds: "6442450944000",
      allocatedDiskByteMilliseconds: "12000000000000",
      transmittedBytes: "123",
      transmittedBytesByRegion: [{ region: "enam", transmittedBytes: "123" }],
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    const request = JSON.parse(String(init?.body));
    expect(request.query).toContain("containersUsageAdaptiveGroups(limit: 257");
    expect(request.query).not.toContain("instanceId: $instanceId");
    expect(request.variables).toEqual({
      accountTag: accountId,
      datetimeStart: "2026-07-19T00:00:00.000Z",
      datetimeEnd: "2026-07-19T01:00:00.000Z",
      applicationId,
    });
  });

  it("returns exact zeroes when the authoritative hour has no usage row", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(
        JSON.stringify({
          data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [] }] } },
          errors: null,
        }),
      ),
    );

    await expect(queryContainerUsageHour(fetcher, await validInput())).resolves.toEqual({
      cpuMicroseconds: "0",
      allocatedMemoryByteMilliseconds: "0",
      allocatedDiskByteMilliseconds: "0",
      transmittedBytes: "0",
      transmittedBytesByRegion: [],
    });
  });

  it("sums every application instance and preserves exact regional transmission totals", async () => {
    const first = usageBody();
    const secondRow = `{
      "dimensions":{
        "datetimeHour":"2026-07-19T00:00:00Z",
        "applicationId":"${applicationId}",
        "instanceId":"123e4567-e89b-42d3-a456-426614174002",
        "region":"enam"
      },
      "sum":{
        "cpuTimeSec":0.000001,
        "allocatedMemory":1,
        "allocatedDisk":2,
        "txBytes":7
      }
    }`;
    const body = first.replace("]}]}},", `,${secondRow}]}]}},`);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(body));

    await expect(queryContainerUsageHour(fetcher, await validInput())).resolves.toEqual({
      cpuMicroseconds: "1234568",
      allocatedMemoryByteMilliseconds: "6442450945000",
      allocatedDiskByteMilliseconds: "12000000002000",
      transmittedBytes: "130",
      transmittedBytesByRegion: [{ region: "enam", transmittedBytes: "130" }],
    });
  });

  it("refuses a configured provider schema hash mismatch before making a request", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(usageBody()),
    );
    const input = await validInput();

    await expect(
      queryContainerUsageHour(fetcher, { ...input, expectedSchemaSha256: "0".repeat(64) }),
    ).rejects.toThrow(/schema/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects GraphQL errors and a row outside the exact application envelope", async () => {
    const graphqlError = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response('{"data":null,"errors":[{"message":"unavailable"}]}'),
    );
    await expect(queryContainerUsageHour(graphqlError, await validInput())).rejects.toThrow(
      /GraphQL/i,
    );

    const wrongApplication = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(usageBody().replace(applicationId, "123e4567-e89b-42d3-a456-426614174002")),
    );
    await expect(queryContainerUsageHour(wrongApplication, await validInput())).rejects.toThrow(
      /resource/i,
    );
  });

  it("rejects precision that cannot be represented in the target integer unit", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(usageBody().replace("1.234567", "1.2345671")),
    );

    await expect(queryContainerUsageHour(fetcher, await validInput())).rejects.toThrow(
      /precision/i,
    );
  });
});
