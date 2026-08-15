import { describe, expect, it } from "vitest";
import { providerUsageContractSha256 } from "../apps/api-worker/src/container-provider-usage";
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
  it("projects only bounded provider completion evidence", async () => {
    const schemaSha256 = await providerUsageContractSha256();
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
      logpush: { reachable: false },
      analytics: { reachable: false },
      container: { reachable: false },
    });
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
      analytics: { reachable: false, httpStatus: 200, failure: "schema" },
      container: { reachable: false, httpStatus: 200, failure: "provider-error" },
    });
  });
});
