import { describe, expect, it } from "vitest";
import { providerUsageContractSha256 } from "../apps/api-worker/src/container-provider-usage";
import { CANONICAL_PROVIDER_USAGE_SCHEMA_SHA256 } from "../scripts/generate-processing-wrangler.mjs";
import { inspectProcessingCostProviders } from "../scripts/inspect-processing-cost-providers.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const activeVersionId = "00000000-0000-0000-0000-000000000007";
const targetHourKey = 496247;

function workerVersion(providerUsageSchemaSha256: string) {
  return {
    id: activeVersionId,
    resources: {
      bindings: [
        { name: "LOGPUSH_JOB_ID", type: "plain_text", text: "41" },
        {
          name: "CONTAINER_APPLICATION_ID",
          type: "plain_text",
          text: "11111111-2222-4333-8444-555555555555",
        },
        {
          name: "USAGE_ANALYTICS_DATASET_NAME",
          type: "plain_text",
          text: "hereisit_processing_usage_production",
        },
        {
          name: "PROVIDER_USAGE_SCHEMA_SHA256",
          type: "plain_text",
          text: providerUsageSchemaSha256,
        },
        { name: "LOGPUSH_STATUS_TOKEN", type: "secret_text" },
      ],
    },
  };
}

describe("processing cost provider inspection", () => {
  it("compares narrower queries after sampling without accepting estimates or leaking groups", async () => {
    const queries: string[] = [];
    const result = await inspectProcessingCostProviders({
      state: { activeVersionId, targetHourKey },
      workerVersion: workerVersion(await providerUsageContractSha256()),
      accountId,
      analyticsReadToken: "analytics-token",
      logpushStatusToken: "logpush-token",
      fetchImpl: async (input, init) => {
        if (!String(input).endsWith("/analytics_engine/sql")) throw new Error("private");
        const query = String(init?.body);
        queries.push(query);
        const interval = query.includes("timestamp >=") ? 1 : 10;
        return Response.json({
          meta: [],
          rows: 1,
          data: [
            {
              event_type: "fetch",
              entrypoint: "default",
              version_id: "123e4567-e89b-42d3-a456-426614174000",
              release_report_sha256: "a".repeat(64),
              point_count: 3,
              minimum_sample_interval: interval,
              maximum_sample_interval: interval,
            },
          ],
        });
      },
    });
    expect(result.analytics).toEqual({ reachable: false, httpStatus: 200, failure: "sampled" });
    expect(result.analyticsQueryComparison).toEqual({
      indexed: { reachable: false, httpStatus: 200, failure: "sampled" },
      indexedSinceHour: { reachable: true, handlerInvocationCount: 3, groupCount: 1 },
    });
    expect(queries).toHaveLength(3);
    expect(queries[1]).toContain("index1 = 'production:usage-v1'");
    expect(queries[1]).not.toContain("timestamp >=");
    expect(queries[2]).toContain("index1 = 'production:usage-v1'");
    expect(queries[2]).toContain("timestamp >= toDateTime('2026-08-11 23:00:00')");
    expect(queries[2]).not.toMatch(/timestamp\s*</);
    expect(JSON.stringify(result)).not.toMatch(/123e4567|aaaaaa|analytics-token|private/);
  });

  it.each([
    [
      "sub-unit usage",
      "0.0000001",
      "application/json",
      { reachable: true, hasUsage: true, regionCount: 1 },
    ],
    [
      "overflow",
      "9223372036854775808",
      "application/json",
      { reachable: false, httpStatus: 200, failure: "numeric-overflow" },
    ],
    [
      "content type",
      "0",
      "text/plain",
      { reachable: false, httpStatus: 200, failure: "content-type" },
    ],
  ])("reports container %s without exposing response values", async (_label, cpuTimeSec, contentType, expected) => {
    const result = await inspectProcessingCostProviders({
      state: { activeVersionId, targetHourKey },
      workerVersion: workerVersion(await providerUsageContractSha256()),
      accountId,
      analyticsReadToken: "analytics-token",
      logpushStatusToken: "logpush-token",
      fetchImpl: async (input) => {
        if (!String(input).endsWith("/graphql")) throw new Error("private provider response");
        return new Response(
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    containersUsageAdaptiveGroups: [
                      {
                        dimensions: {
                          datetimeHour: new Date(targetHourKey * 3_600_000).toISOString(),
                          applicationId: "11111111-2222-4333-8444-555555555555",
                          instanceId: "private-instance",
                          region: "enam",
                        },
                        sum: {
                          cpuTimeSec: "numeric-placeholder",
                          allocatedMemory: 0,
                          allocatedDisk: 0,
                          txBytes: 0,
                        },
                      },
                    ],
                  },
                ],
              },
            },
            errors: null,
          }).replace('"numeric-placeholder"', cpuTimeSec),
          { headers: { "content-type": contentType } },
        );
      },
    });
    expect(result.container).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private|analytics-token|logpush-token/);
  });

  it("projects only bounded provider completion evidence", async () => {
    const schemaSha256 = CANONICAL_PROVIDER_USAGE_SCHEMA_SHA256;
    const hourEnd = new Date((targetHourKey + 1) * 3_600_000).toISOString();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/logpush/jobs/41")) {
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            id: 41,
            dataset: "workers_trace_events",
            enabled: true,
            last_complete: hourEnd,
            last_error: null,
            error_message: null,
          },
        });
      }
      if (url.includes("/analytics_engine/sql")) {
        return Response.json({ meta: [], data: [], rows: 0 });
      }
      if (url.endsWith("/graphql")) {
        return Response.json({
          data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [] }] } },
          errors: null,
        });
      }
      throw new Error("unexpected provider request");
    };

    await expect(
      inspectProcessingCostProviders({
        state: { activeVersionId, targetHourKey },
        workerVersion: workerVersion(schemaSha256),
        accountId,
        analyticsReadToken: "analytics-token",
        logpushStatusToken: "logpush-token",
        fetchImpl,
      }),
    ).resolves.toEqual({
      targetHourKey,
      logpush: {
        reachable: true,
        complete: true,
        lastCompleteMilliseconds: Date.parse(hourEnd),
      },
      analytics: { reachable: true, handlerInvocationCount: 0, groupCount: 0 },
      container: { reachable: true, hasUsage: false, regionCount: 0 },
    });
  });

  it("fails closed without exposing provider errors", async () => {
    const schemaSha256 = await providerUsageContractSha256();
    await expect(
      inspectProcessingCostProviders({
        state: { activeVersionId, targetHourKey },
        workerVersion: workerVersion(schemaSha256),
        accountId,
        analyticsReadToken: "analytics-token",
        logpushStatusToken: "logpush-token",
        fetchImpl: async () => {
          throw new Error("private provider response");
        },
      }),
    ).resolves.toEqual({
      targetHourKey,
      logpush: { reachable: false, failure: "no-response" },
      analytics: { reachable: false, failure: "no-response" },
      container: { reachable: false, failure: "no-response" },
    });
  });

  it("distinguishes a contract mismatch before any container request from missing responses", async () => {
    const requests: string[] = [];
    const result = await inspectProcessingCostProviders({
      state: { activeVersionId, targetHourKey },
      workerVersion: workerVersion("0".repeat(64)),
      accountId,
      analyticsReadToken: "analytics-token",
      logpushStatusToken: "logpush-token",
      fetchImpl: async (input) => {
        requests.push(String(input));
        throw new Error("private provider response");
      },
    });

    expect(result.container).toEqual({ reachable: false, failure: "contract-mismatch" });
    expect(result.analytics).toEqual({ reachable: false, failure: "no-response" });
    expect(requests.some((url) => url.endsWith("/graphql"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private provider response");
  });

  it("reports only the bounded HTTP status of rejected provider responses", async () => {
    const schemaSha256 = await providerUsageContractSha256();
    await expect(
      inspectProcessingCostProviders({
        state: { activeVersionId, targetHourKey },
        workerVersion: workerVersion(schemaSha256),
        accountId,
        analyticsReadToken: "analytics-token",
        logpushStatusToken: "logpush-token",
        fetchImpl: async (input) =>
          new Response(String(input).includes("/graphql") ? "private response" : null, {
            status: String(input).includes("/graphql") ? 403 : 401,
            headers: { "content-type": "text/plain" },
          }),
      }),
    ).resolves.toEqual({
      targetHourKey,
      logpush: { reachable: false, httpStatus: 401, failure: "http-error" },
      analytics: { reachable: false, httpStatus: 401, failure: "http-error" },
      container: { reachable: false, httpStatus: 403, failure: "http-error" },
    });
  });

  it("classifies successful but rejected envelopes without exposing their contents", async () => {
    const schemaSha256 = await providerUsageContractSha256();
    const hourEnd = new Date((targetHourKey + 1) * 3_600_000).toISOString();
    await expect(
      inspectProcessingCostProviders({
        state: { activeVersionId, targetHourKey },
        workerVersion: workerVersion(schemaSha256),
        accountId,
        analyticsReadToken: "analytics-token",
        logpushStatusToken: "logpush-token",
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/logpush/jobs/41")) {
            return Response.json({
              success: true,
              errors: [],
              messages: [],
              result: {
                id: 41,
                dataset: "workers_trace_events",
                enabled: true,
                last_complete: hourEnd,
                last_error: null,
                error_message: null,
              },
            });
          }
          if (url.includes("/analytics_engine/sql")) return Response.json({ private: true });
          if (url.endsWith("/graphql")) {
            return Response.json({ data: null, errors: [{ private: true }] });
          }
          throw new Error("unexpected provider request");
        },
      }),
    ).resolves.toEqual({
      targetHourKey,
      logpush: {
        reachable: true,
        complete: true,
        lastCompleteMilliseconds: Date.parse(hourEnd),
      },
      analytics: {
        reachable: false,
        httpStatus: 200,
        failure: "schema",
        schemaIssues: ["invalid_type:meta", "invalid_type:data", "invalid_type:rows"],
      },
      container: { reachable: false, httpStatus: 200, failure: "provider-error" },
    });
  });
});
