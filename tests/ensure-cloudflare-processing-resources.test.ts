import { describe, expect, it } from "vitest";
import { planProcessingResources } from "../scripts/ensure-cloudflare-processing-resources.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const config = {
  phase: "provision" as const,
  environment: "staging" as const,
  accountId,
  location: "apac",
  workerScriptName: "hereisit-processing-staging",
  databaseName: "hereisit-processing-staging",
  bucketName: "hereisit-processing-staging",
  usageLogBucketName: "hereisit-processing-usage-staging",
  usageAnalyticsDatasetName: "hereisit_processing_usage_staging",
  queueName: "hereisit-image-jobs-staging",
  dlqName: "hereisit-image-jobs-dlq-staging",
};

function resources() {
  return {
    d1: [
      {
        id: "11111111-2222-3333-4444-555555555555",
        accountId,
        name: config.databaseName,
        location: "apac",
      },
    ],
    r2: [
      {
        accountId,
        name: config.bucketName,
        lifecycleDays: 1,
        cors: [],
        customDomains: [],
        r2DevEnabled: false,
        sippyEnabled: false,
      },
      {
        accountId,
        name: config.usageLogBucketName,
        lifecycleDays: 3,
        cors: [],
        customDomains: [],
        r2DevEnabled: false,
        sippyEnabled: false,
      },
    ],
    queues: [
      {
        id: "1".repeat(32),
        accountId,
        name: config.queueName,
        deliveryPaused: true,
        deadLetterQueueName: config.dlqName,
      },
      {
        id: "2".repeat(32),
        accountId,
        name: config.dlqName,
        deliveryPaused: true,
        deadLetterQueueName: null,
      },
    ],
    logpush: [
      {
        id: 41,
        accountId,
        enabled: true,
        dataset: "workers_trace_events",
        workerScriptName: config.workerScriptName,
        fields: [
          "CPUTimeMs",
          "Entrypoint",
          "EventTimestampMs",
          "EventType",
          "Outcome",
          "ScriptName",
          "ScriptVersion",
        ],
        samplingRate: null,
      },
    ],
  };
}

describe("Cloudflare processing resource planner", () => {
  it("plans every missing private resource from an empty inventory", () => {
    const result = planProcessingResources({
      config,
      inventory: { d1: [], r2: [], queues: [], logpush: [] },
    });

    expect(result).toEqual({
      version: 1,
      phase: "provision",
      environment: "staging",
      analyticsDataset: "hereisit_processing_usage_staging",
      actions: [
        { type: "create-d1", name: config.databaseName, location: "apac" },
        { type: "create-r2", name: config.bucketName, lifecycleDays: 1 },
        { type: "create-r2", name: config.usageLogBucketName, lifecycleDays: 3 },
        {
          type: "create-queue",
          name: config.dlqName,
          deadLetterQueueName: null,
          deliveryPaused: true,
        },
        {
          type: "create-queue",
          name: config.queueName,
          deadLetterQueueName: config.dlqName,
          deliveryPaused: true,
        },
        {
          type: "create-logpush",
          dataset: "workers_trace_events",
          workerScriptName: config.workerScriptName,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/token|secret|destination/i);
  });

  it("plans only missing resources from a partial inventory", () => {
    const complete = resources();
    const result = planProcessingResources({
      config,
      inventory: { ...complete, r2: complete.r2.slice(0, 1), logpush: [] },
    });

    expect(result.actions).toEqual([
      { type: "create-r2", name: config.usageLogBucketName, lifecycleDays: 3 },
      {
        type: "create-logpush",
        dataset: "workers_trace_events",
        workerScriptName: config.workerScriptName,
      },
    ]);
  });

  it("is idempotent for a complete matching inventory", () => {
    expect(planProcessingResources({ config, inventory: resources() }).actions).toEqual([]);
  });

  it.each([
    ["wrong account", "d1", { accountId: "f".repeat(32) }],
    ["wrong D1 location", "d1", { location: "wnam" }],
    ["public R2", "r2", { r2DevEnabled: true }],
    ["R2 CORS", "r2", { cors: [{ origins: ["*"] }] }],
    ["wrong lifecycle", "r2", { lifecycleDays: 30 }],
    ["active Queue", "queues", { deliveryPaused: false }],
    ["wrong DLQ", "queues", { deadLetterQueueName: null }],
    ["Logpush logs", "logpush", { fields: ["Logs"] }],
    ["Logpush sampling", "logpush", { samplingRate: 0.1 }],
  ])("rejects %s instead of rebinding it", (_label, collection, override) => {
    const inventory = resources();
    const entries = inventory[collection as keyof typeof inventory] as Array<
      Record<string, unknown>
    >;
    entries[0] = { ...entries[0], ...override };

    expect(() => planProcessingResources({ config, inventory })).toThrow();
  });

  it("rejects duplicate exact-name resources", () => {
    const inventory = resources();
    inventory.r2.push({ ...inventory.r2[0] });
    expect(() => planProcessingResources({ config, inventory })).toThrow(/duplicate/i);
  });
});
