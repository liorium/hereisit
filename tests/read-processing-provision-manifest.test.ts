import { describe, expect, it } from "vitest";
import { buildProcessingProvisionManifest } from "../scripts/ensure-cloudflare-processing-resources.mjs";
import {
  readProcessingProvisionField,
  validateProcessingProvisionManifest,
} from "../scripts/read-processing-provision-manifest.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const config = {
  phase: "provision",
  environment: "staging",
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
const inventory = {
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
    },
    { id: "2".repeat(32), accountId, name: config.dlqName, deliveryPaused: true, consumerCount: 0 },
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

describe("processing provision manifest reader", () => {
  it("validates the sealed coordinates and exposes only allowlisted fields", () => {
    const manifest = buildProcessingProvisionManifest({
      config,
      inventory,
      verifiedAt: "2026-07-19T11:00:00.000Z",
    });

    expect(validateProcessingProvisionManifest(manifest)).toBe(manifest);
    expect(readProcessingProvisionField(manifest, "d1.databaseId")).toBe(inventory.d1[0]?.id);
    expect(readProcessingProvisionField(manifest, "logpush.jobId")).toBe(41);
    expect(() => readProcessingProvisionField(manifest, "logpush.destination")).toThrow();
  });

  it("rejects a modified manifest even when a field remains well-formed", () => {
    const manifest = buildProcessingProvisionManifest({
      config,
      inventory,
      verifiedAt: "2026-07-19T11:00:00.000Z",
    });
    const modified = { ...manifest, accountId: "f".repeat(32) };
    expect(() => validateProcessingProvisionManifest(modified)).toThrow(/hash/i);
  });
});
