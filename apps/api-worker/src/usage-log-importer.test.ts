import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  importUsageLogPage,
  type UsageLogBucket,
  type UsageLogImporterDependencies,
} from "./usage-log-importer";
import type { StreamingDigest } from "./usage-log-parser";

const versionId = "123e4567-e89b-42d3-a456-426614174000";
const observedAt = Date.parse("2026-07-19T10:00:00.000Z");

function nodeDigest(): StreamingDigest {
  const digest = createHash("sha256");
  return {
    update: async (chunk) => {
      digest.update(chunk);
    },
    finish: async () => digest.digest("hex"),
  };
}

function traceRecord(overrides: Record<string, unknown> = {}) {
  return {
    CPUTimeMs: 7,
    Entrypoint: "default",
    EventTimestampMs: observedAt - 3_600_000,
    EventType: "fetch",
    Outcome: "ok",
    ScriptName: "hereisit-processing-staging",
    ScriptVersion: { id: versionId, message: null, tag: null },
    ...overrides,
  };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function objectMetadata(overrides: Partial<R2Object> = {}): R2Object {
  return {
    key: "logs/date=2026-07-19/hour=09/trace.ndjson.gz",
    version: "version-1",
    size: 128,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(observedAt - 30 * 60_000),
    storageClass: "Standard",
    writeHttpMetadata() {},
    ...overrides,
  } as R2Object;
}

function completeList(objects: R2Object[]): R2Objects {
  return { objects, delimitedPrefixes: [], truncated: false };
}

function dependencies(overrides: Partial<UsageLogImporterDependencies> = {}) {
  const metadata = objectMetadata();
  const compressed = gzipSync(`${JSON.stringify(traceRecord())}\n`);
  const bucket: UsageLogBucket = {
    list: vi.fn(async () => completeList([metadata])),
    get: vi.fn(async () => ({ ...metadata, body: stream(compressed) }) as R2ObjectBody),
  };
  return {
    bucket,
    database: {} as D1Database,
    parserOptions: {
      scriptName: "hereisit-processing-staging",
      handlerEntrypoints: new Set(["default"]),
      allowedVersionIds: new Set([versionId]),
      createDigest: nodeDigest,
    },
    record: vi.fn(async () => ({
      kind: "recorded" as const,
      state: "parsed" as const,
      stableObservationCount: 1,
      circuitOpen: false,
    })),
    openCircuit: vi.fn(async () => undefined),
    ...overrides,
  } satisfies UsageLogImporterDependencies;
}

describe("private R2 usage-log importer", () => {
  it("conditionally streams one gzip page into the exactly-once ledger", async () => {
    const deps = dependencies();

    await expect(
      importUsageLogPage(deps, { observedAt, prefix: "logs/", maximumObjects: 64 }),
    ).resolves.toEqual({
      kind: "complete",
      importedObjects: 1,
      replayedObjects: 0,
    });

    expect(deps.bucket.list).toHaveBeenCalledWith({ prefix: "logs/", limit: 64 });
    expect(deps.bucket.get).toHaveBeenCalledWith(expect.any(String), {
      onlyIf: { etagMatches: "etag-1" },
    });
    expect(deps.record).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({
        etag: "etag-1",
        observedAt,
        parsed: expect.objectContaining({ invocationCount: 1 }),
      }),
    );
    expect(deps.openCircuit).not.toHaveBeenCalled();
  });

  it("ignores Cloudflare's documented R2 ownership challenge object", async () => {
    const challenge = objectMetadata({
      key: "logs/20260729/test.txt.gz",
      size: 41,
    });
    const deps = dependencies({
      bucket: {
        list: vi.fn(async () => completeList([challenge])),
        get: vi.fn(),
      },
    });

    await expect(importUsageLogPage(deps, { observedAt, prefix: "logs/" })).resolves.toEqual({
      kind: "complete",
      importedObjects: 0,
      replayedObjects: 0,
    });
    expect(deps.bucket.get).not.toHaveBeenCalled();
    expect(deps.openCircuit).not.toHaveBeenCalled();
  });

  it("fails closed before GET when the compressed object exceeds its bound", async () => {
    const metadata = objectMetadata({ size: 64 * 1024 * 1024 + 1 });
    const deps = dependencies({
      bucket: {
        list: vi.fn(async () => completeList([metadata])),
        get: vi.fn(),
      },
    });

    await expect(importUsageLogPage(deps, { observedAt, prefix: "logs/" })).resolves.toEqual({
      kind: "failed-closed",
      importedObjects: 0,
      replayedObjects: 0,
    });
    expect(deps.bucket.get).not.toHaveBeenCalled();
    expect(deps.openCircuit).toHaveBeenCalledWith(
      deps.database,
      observedAt,
      "USAGE_LOG_IMPORT_INVALID",
    );
  });

  it("opens the circuit when the object changes between LIST and conditional GET", async () => {
    const metadata = objectMetadata();
    const deps = dependencies({
      bucket: {
        list: vi.fn(async () => completeList([metadata])),
        get: vi.fn(async () => metadata),
      },
    });

    await expect(importUsageLogPage(deps, { observedAt, prefix: "logs/" })).resolves.toMatchObject({
      kind: "failed-closed",
      importedObjects: 0,
    });
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.openCircuit).toHaveBeenCalledWith(
      deps.database,
      observedAt,
      "USAGE_LOG_OBJECT_CHANGED",
    );
  });

  it("opens the circuit without exposing the object key when gzip content is malformed", async () => {
    const metadata = objectMetadata();
    const deps = dependencies({
      bucket: {
        list: vi.fn(async () => completeList([metadata])),
        get: vi.fn(
          async () => ({ ...metadata, body: stream(new Uint8Array([1, 2, 3])) }) as R2ObjectBody,
        ),
      },
    });

    const result = await importUsageLogPage(deps, { observedAt, prefix: "logs/" });

    expect(result).toMatchObject({ kind: "failed-closed", importedObjects: 0 });
    expect(JSON.stringify(result)).not.toContain(metadata.key);
    expect(deps.openCircuit).toHaveBeenCalledWith(
      deps.database,
      observedAt,
      "USAGE_LOG_IMPORT_INVALID",
    );
  });
});
