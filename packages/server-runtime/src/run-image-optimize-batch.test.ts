import type {
  ImageOptimizePolicyResponseV1,
  ImageOptimizeStatusResponseV1,
} from "@hereisit/tool-contracts/image-optimize";
import { describe, expect, it, vi } from "vitest";
import {
  type RemoteImageOptimizeItem,
  runRemoteImageOptimizeBatch,
} from "./run-image-optimize-batch";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const policy: ImageOptimizePolicyResponseV1 = {
  contract: "tool-job@1",
  toolContract: "image.optimize@1",
  execution: "server",
  reason: null,
  maintainer: false,
  disclosure: {
    upload: true,
    inputDeletion: "terminal",
    resultDeletion: {
      mode: "server-temporary",
      acknowledged: "immediate-delete-attempt",
      unacknowledgedDueSeconds: 1800,
      applicationSloSeconds: 2100,
      lifecycleExpirationDays: 1,
      exceptionalDelayPossible: true,
    },
  },
  limits: { maxFiles: 20, maxBytesPerFile: 31_457_280, maxPixelsPerFile: 40_000_000 },
};

function item(itemId: string): RemoteImageOptimizeItem {
  return {
    itemId,
    file: new File([Uint8Array.of(1, 2, 3)], `${itemId}.jpg`, { type: "image/jpeg" }),
    width: 1,
    height: 1,
    spec: {
      version: 1,
      mode: "smart",
      preset: "balanced",
      output: "same-format",
      metadata: "strip",
      orientation: "apply",
      colorSpace: "srgb",
      minimumSavingsPercent: 1,
    },
  };
}

function succeeded(jobId: string): ImageOptimizeStatusResponseV1 {
  return {
    contract: "tool-job@1",
    jobId,
    state: "succeeded",
    phase: "completed",
    phaseFraction: 1,
    sequence: 3,
    attempt: 1,
    result: {
      kind: "download",
      mime: "image/jpeg",
      byteLength: 2,
      width: 1,
      height: 1,
      engineBuildId: "engine",
      codecBuildId: "codec",
      warnings: [],
      timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
      expiresAt: "2026-07-17T00:00:00.000Z",
    },
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

describe("remote image optimization batch", () => {
  it("passes an explicit browser download-handoff acknowledgement into remote handles", async () => {
    const confirmDownloadHandoff = vi.fn(async () => true);
    const createDownloadHandle = vi.fn((input) => ({
      descriptor: input.descriptor,
      download: vi.fn(),
      fetchForArchive: vi.fn(),
      dispose: vi.fn(),
    }));
    const handle = runRemoteImageOptimizeBatch([item("a")], {
      apiOrigin: "https://processing.example",
      anonymousSessionId: sessionId,
      confirmDownloadHandoff,
      dependencies: {
        getPolicy: async () => policy,
        createJob: async () => ({
          contract: "tool-job@1",
          mode: "existing-job",
          jobId: "123e4567-e89b-42d3-a456-426614174001",
          state: "succeeded",
          reservedWeightedUnits: 10,
        }),
        upload: vi.fn(),
        getStatus: async ({ jobId }) => succeeded(jobId),
        createDownloadHandle,
        sleep: async () => undefined,
      },
    });

    await expect(handle.result).resolves.toMatchObject([{ status: "fulfilled" }]);
    expect(createDownloadHandle).toHaveBeenCalledWith(
      expect.objectContaining({ confirmDownloadHandoff }),
    );
  });

  it("runs sequentially, preserves opaque progress, and emits each lazy result immediately", async () => {
    const order: string[] = [];
    let number = 0;
    const events: unknown[] = [];
    const handle = runRemoteImageOptimizeBatch([item("a"), item("b")], {
      apiOrigin: "https://processing.example",
      anonymousSessionId: sessionId,
      onEvent: (event) => events.push(event),
      dependencies: {
        getPolicy: async () => policy,
        createJob: async (request) => {
          number += 1;
          order.push(`create-${number}`);
          expect(JSON.stringify(request)).not.toContain(`${number === 1 ? "a" : "b"}.jpg`);
          const jobId = `123e4567-e89b-42d3-a456-42661417400${number}`;
          return {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              contentType: "image/jpeg",
              byteLength: 3,
              expiresAt: "2026-07-17T00:00:00.000Z",
            },
            reservedWeightedUnits: 10,
          };
        },
        upload: async ({ onProgress }) => onProgress?.(1, 3),
        getStatus: async ({ jobId }) => {
          order.push(`status-${jobId.at(-1)}`);
          return succeeded(jobId);
        },
        createDownloadHandle: (input) => ({
          descriptor: input.descriptor,
          download: vi.fn(),
          fetchForArchive: vi.fn(),
          dispose: vi.fn(),
        }),
        sleep: async () => undefined,
      },
    });
    const result = await handle.result;
    expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(order).toEqual(["create-1", "status-1", "create-2", "status-2"]);
    expect(events).toContainEqual({
      type: "item-progress",
      itemId: "a",
      phase: "uploading",
      fraction: 1 / 3,
      sequence: 0,
    });
  });

  it("does not fetch a result for original-retained and ignores observer failures", async () => {
    const createDownloadHandle = vi.fn();
    const handle = runRemoteImageOptimizeBatch([item("a")], {
      apiOrigin: "https://processing.example",
      anonymousSessionId: sessionId,
      onEvent: () => {
        throw new Error("observer");
      },
      dependencies: {
        getPolicy: async () => policy,
        createJob: async () => ({
          contract: "tool-job@1",
          mode: "existing-job",
          jobId: "123e4567-e89b-42d3-a456-426614174001",
          state: "succeeded",
          reservedWeightedUnits: 10,
        }),
        upload: vi.fn(),
        getStatus: async ({ jobId }) => ({
          ...succeeded(jobId),
          result: {
            kind: "original-retained",
            reason: "NO_SIZE_REDUCTION",
            testedCandidates: 2,
            engineBuildId: "engine",
            codecBuildId: "codec",
            warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
            timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
          },
        }),
        createDownloadHandle,
        sleep: async () => undefined,
      },
    });
    await expect(handle.result).resolves.toMatchObject([{ status: "original-retained" }]);
    expect(createDownloadHandle).not.toHaveBeenCalled();
  });

  it("preserves null native progress and ignores a lower stale terminal sequence", async () => {
    const events: unknown[] = [];
    const jobId = "123e4567-e89b-42d3-a456-426614174001";
    const statuses: ImageOptimizeStatusResponseV1[] = [
      {
        contract: "tool-job@1",
        jobId,
        state: "running",
        phase: "optimizing",
        phaseFraction: null,
        sequence: 2,
        attempt: 1,
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
      {
        contract: "tool-job@1",
        jobId,
        state: "failed",
        phase: "completed",
        phaseFraction: 1,
        sequence: 1,
        attempt: 1,
        error: { code: "ENGINE_CRASH", message: "stale", retryable: true },
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
      succeeded(jobId),
    ];
    const handle = runRemoteImageOptimizeBatch([item("a")], {
      apiOrigin: "https://processing.example",
      anonymousSessionId: sessionId,
      onEvent: (event) => events.push(event),
      dependencies: {
        getPolicy: async () => policy,
        createJob: async () => ({
          contract: "tool-job@1",
          mode: "existing-job",
          jobId,
          state: "running",
          reservedWeightedUnits: 10,
        }),
        upload: vi.fn(),
        getStatus: async () => {
          const status = statuses.shift();
          if (status === undefined) throw new Error("missing status");
          return status;
        },
        createDownloadHandle: (input) => ({
          descriptor: input.descriptor,
          download: vi.fn(),
          fetchForArchive: vi.fn(),
          dispose: vi.fn(),
        }),
        sleep: async () => undefined,
      },
    });
    await expect(handle.result).resolves.toMatchObject([{ status: "fulfilled" }]);
    expect(events).toContainEqual({
      type: "item-progress",
      itemId: "a",
      phase: "optimizing",
      fraction: null,
      sequence: 2,
    });
    expect(events).not.toContainEqual(expect.objectContaining({ sequence: 1 }));
  });

  it("cancels the current server job and returns a cancelled item", async () => {
    let releaseStatus: (() => void) | undefined;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const handle = runRemoteImageOptimizeBatch([item("a")], {
      apiOrigin: "https://processing.example",
      anonymousSessionId: sessionId,
      dependencies: {
        getPolicy: async () => policy,
        createJob: async () => ({
          contract: "tool-job@1",
          mode: "existing-job",
          jobId: "123e4567-e89b-42d3-a456-426614174001",
          state: "queued",
          reservedWeightedUnits: 10,
        }),
        upload: vi.fn(),
        getStatus: async ({ jobId }) => {
          await new Promise<void>((resolve) => {
            releaseStatus = resolve;
          });
          return {
            ...succeeded(jobId),
            state: "cancelled",
            result: undefined,
            error: { code: "CANCELLED", message: "취소", retryable: false },
          };
        },
        cancel,
        remove,
        createDownloadHandle: vi.fn(),
        sleep: async () => undefined,
      },
    });
    await vi.waitFor(() => expect(releaseStatus).toBeTypeOf("function"));
    handle.cancel();
    releaseStatus?.();
    await expect(handle.result).resolves.toMatchObject([{ status: "cancelled" }]);
    expect(cancel).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });
});
