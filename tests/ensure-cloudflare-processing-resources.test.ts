import { describe, expect, it } from "vitest";
import {
  buildProcessingProvisionManifest,
  convergeProcessingResources,
  planProcessingResources,
} from "../scripts/ensure-cloudflare-processing-resources.mjs";

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
        consumerCount: 0,
        consumerScriptNames: [],
      },
      {
        id: "2".repeat(32),
        accountId,
        name: config.dlqName,
        deliveryPaused: true,
        consumerCount: 0,
        consumerScriptNames: [],
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
          deliveryPaused: true,
        },
        {
          type: "create-queue",
          name: config.queueName,
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

  it("resumes provisioning with only the exact processing Worker consumer", () => {
    const inventory = resources();
    inventory.queues = inventory.queues.map((queue) => ({
      ...queue,
      consumerCount: 1,
      consumerScriptNames: [config.workerScriptName],
    }));

    expect(planProcessingResources({ config, inventory }).actions).toEqual([]);
  });

  it("pauses an active exact processing Queue before provisioning", () => {
    const inventory = resources();
    inventory.queues[0] = {
      ...inventory.queues[0],
      deliveryPaused: false,
      consumerCount: 1,
      consumerScriptNames: [config.workerScriptName],
    };

    expect(planProcessingResources({ config, inventory }).actions).toEqual([
      {
        type: "pause-queue",
        id: inventory.queues[0]?.id,
        name: config.queueName,
      },
    ]);
  });

  it("seals a converged, credential-free provisioning manifest", () => {
    const manifest = buildProcessingProvisionManifest({
      config,
      inventory: resources(),
      verifiedAt: "2026-07-19T11:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      schema: "hereisit-processing-resource-provision@1",
      version: 1,
      phase: "provision",
      environment: "staging",
      d1: { databaseId: resources().d1[0]?.id, requestedLocationHint: "apac" },
      analytics: { datasetName: config.usageAnalyticsDatasetName, state: "binding-deferred" },
      logpush: { jobId: 41 },
    });
    expect(manifest.verificationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toMatch(/token|secret|access-key/i);
  });

  it.each([
    ["wrong account", "d1", { accountId: "f".repeat(32) }],
    ["wrong D1 location", "d1", { location: "wnam" }],
    ["public R2", "r2", { r2DevEnabled: true }],
    ["R2 CORS", "r2", { cors: [{ origins: ["*"] }] }],
    ["wrong lifecycle", "r2", { lifecycleDays: 30 }],
    ["foreign consumer", "queues", { consumerCount: 1, consumerScriptNames: ["other-worker"] }],
    ["incomplete consumer inventory", "queues", { consumerCount: 1 }],
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

  it("converges one action at a time and re-verifies the final inventory", async () => {
    let inventory = { d1: [], r2: [], queues: [], logpush: [] } as ReturnType<typeof resources>;
    const applied: string[] = [];
    const finalInventory = resources();

    const result = await convergeProcessingResources({
      config,
      readInventory: async () => inventory,
      applyAction: async (action) => {
        applied.push(action.type);
        inventory = {
          d1: applied.length >= 1 ? finalInventory.d1 : [],
          r2: finalInventory.r2.slice(0, Math.max(0, Math.min(2, applied.length - 1))),
          queues:
            applied.length < 4
              ? []
              : applied.length === 4
                ? [finalInventory.queues[1]]
                : finalInventory.queues,
          logpush: applied.length >= 6 ? finalInventory.logpush : [],
        };
      },
    });

    expect(applied).toEqual([
      "create-d1",
      "create-r2",
      "create-r2",
      "create-queue",
      "create-queue",
      "create-logpush",
    ]);
    expect(result).toEqual({
      version: 1,
      phase: "provision",
      environment: "staging",
      analyticsDataset: config.usageAnalyticsDatasetName,
      inventory: finalInventory,
    });
  });

  it("stops a non-converging or unexpectedly changed resource set", async () => {
    const empty = { d1: [], r2: [], queues: [], logpush: [] };
    await expect(
      convergeProcessingResources({
        config,
        readInventory: async () => empty,
        applyAction: async () => undefined,
      }),
    ).rejects.toThrow(/converge/i);
  });
});
