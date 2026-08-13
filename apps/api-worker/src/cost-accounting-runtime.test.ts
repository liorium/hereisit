import { describe, expect, it } from "vitest";
import {
  PROCESSING_USAGE_LOG_ENTRYPOINTS,
  parseCostAccountingRuntimeConfig,
} from "./cost-accounting-runtime";
import type { LiveCostModelV1 } from "./env";

const operational = {
  environment: "staging" as const,
  liveCostModel: {} as LiveCostModelV1,
  liveCostModelSha256: "a".repeat(64),
  providerUsageSchemaSha256: "b".repeat(64),
  releaseReportSha256: "c".repeat(64),
};

const settings = {
  COST_ACCOUNTING_MODE: "active",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  LOGPUSH_JOB_ID: "123",
  CONTAINER_APPLICATION_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  WORKER_SCRIPT_NAME: "hereisit-processing-staging",
  USAGE_LOG_PREFIX: "workers-trace-events/staging/",
  USAGE_ANALYTICS_DATASET_NAME: "hereisit_processing_usage_staging",
};

describe("cost accounting runtime configuration", () => {
  it("allows only the Worker plus both processing container entrypoints", () => {
    expect([...PROCESSING_USAGE_LOG_ENTRYPOINTS]).toEqual([
      "",
      "ImageEngineContainer",
      "PdfEngineContainer",
    ]);
  });

  it("parses environment-bound provider identifiers", () => {
    expect(parseCostAccountingRuntimeConfig(settings, operational)).toMatchObject({
      accountId: settings.CLOUDFLARE_ACCOUNT_ID,
      logpushJobId: 123,
      containerApplicationId: settings.CONTAINER_APPLICATION_ID,
      workerScriptName: settings.WORKER_SCRIPT_NAME,
      usageLogPrefix: settings.USAGE_LOG_PREFIX,
      analyticsDatasetName: settings.USAGE_ANALYTICS_DATASET_NAME,
    });
  });

  it("rejects runtime construction while provider reconciliation is in bootstrap mode", () => {
    expect(() =>
      parseCostAccountingRuntimeConfig(
        { ...settings, COST_ACCOUNTING_MODE: "bootstrap" },
        operational,
      ),
    ).toThrow(/bootstrap/i);
  });

  it.each([
    ["non-canonical job id", { LOGPUSH_JOB_ID: "0123" }],
    ["zero job id", { LOGPUSH_JOB_ID: "0" }],
    ["wrong prefix environment", { USAGE_LOG_PREFIX: "workers-trace-events/production/" }],
    ["wrong script environment", { WORKER_SCRIPT_NAME: "hereisit-processing-production" }],
    ["invalid account", { CLOUDFLARE_ACCOUNT_ID: "local-account" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      parseCostAccountingRuntimeConfig({ ...settings, ...override }, operational),
    ).toThrow();
  });
});
