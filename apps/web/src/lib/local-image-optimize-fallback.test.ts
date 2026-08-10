import type { BatchItemResult } from "@hereisit/tool-contracts";
import type { ImageOptimizeSpecV1 } from "@hereisit/tool-contracts/image-optimize";
import { describe, expect, it, vi } from "vitest";
import {
  type LocalFallbackOptions,
  type LocalImageOptimizeBatchHandle,
  runLocalImageOptimizeFallback,
} from "./local-image-optimize-fallback";

const losslessSpec: ImageOptimizeSpecV1 = {
  version: 1,
  mode: "lossless",
  preset: "balanced",
  output: "same-format",
  metadata: "strip",
  orientation: "apply",
  colorSpace: "srgb",
  minimumSavingsPercent: 1,
};

function item(itemId: string, mime: "image/jpeg" | "image/png" = "image/jpeg") {
  const file = new File([Uint8Array.of(1)], `${itemId}.jpg`, { type: mime });
  file.arrayBuffer = vi.fn(async () => {
    throw new Error("UI realm must not read files");
  });
  return { itemId, file, mime };
}

function handle(
  result: LocalImageOptimizeBatchHandle["result"],
  cancel = vi.fn(),
): LocalImageOptimizeBatchHandle {
  return { result, cancel };
}

function smartHandle(result: Promise<readonly BatchItemResult[]>, cancel = vi.fn()) {
  return { result, cancel };
}

describe("local image optimize fallback", () => {
  it("submits one byte-free smart batch with source-preserving version 2 specs", async () => {
    const first = item("first");
    const second = item("second", "image/png");
    const third = item("third");
    const runSmart = vi.fn<NonNullable<LocalFallbackOptions["runSmart"]>>(() =>
      smartHandle(
        Promise.resolve([
          {
            status: "fulfilled" as const,
            itemId: first.itemId,
            value: {
              mime: "image/jpeg" as const,
              bytes: new ArrayBuffer(1),
              byteLength: 1,
              width: 1,
              height: 1,
              warnings: [],
              suggestedName: "first.jpg",
              timing: {
                inspectMs: 0,
                decodeMs: 0,
                transformMs: 0,
                encodeMs: 0,
                totalMs: 0,
                encodeAttempts: 1,
              },
            },
          },
          {
            status: "rejected" as const,
            itemId: second.itemId,
            error: { code: "NO_SIZE_REDUCTION", message: "too small", retryable: false },
          },
          {
            status: "rejected" as const,
            itemId: third.itemId,
            error: { code: "ENCODE_FAILED", message: "encode failed", retryable: false },
          },
        ]),
      ),
    );

    await expect(
      runLocalImageOptimizeFallback(
        [first, second, third],
        { ...losslessSpec, mode: "smart" },
        { runSmart },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ status: "fulfilled", itemId: "first" }),
      {
        status: "original-retained",
        itemId: "second",
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
      },
      { status: "rejected", itemId: "third", message: "encode failed" },
    ]);
    expect(runSmart).toHaveBeenCalledTimes(1);
    expect(runSmart).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          itemId: "first",
          file: first.file,
          spec: {
            version: 2,
            resize: { kind: "none" },
            sizeGoal: {
              mode: "smaller-only",
              minSavingsPercent: 1,
              minQuality: 35,
              maxAttempts: 3,
            },
            autoOrient: true,
            metadata: "strip",
            output: { format: "source", compression: { mode: "quality", quality: 82 } },
          },
        }),
        expect.objectContaining({
          itemId: "second",
          file: second.file,
          spec: expect.objectContaining({
            output: { format: "source", compression: { mode: "quality", quality: 82 } },
          }),
        }),
        expect.objectContaining({
          itemId: "third",
          file: third.file,
          spec: expect.objectContaining({
            output: { format: "source", compression: { mode: "quality", quality: 82 } },
          }),
        }),
      ],
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(first.file.arrayBuffer).not.toHaveBeenCalled();
    expect(second.file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("uses the smallest quality for every smart item and preserves the PNG warning", async () => {
    const png = item("png", "image/png");
    const runSmart = vi.fn<NonNullable<LocalFallbackOptions["runSmart"]>>(() =>
      smartHandle(
        Promise.resolve([
          {
            status: "fulfilled" as const,
            itemId: png.itemId,
            value: {
              mime: "image/png" as const,
              bytes: new ArrayBuffer(1),
              byteLength: 1,
              width: 1,
              height: 1,
              warnings: [],
              suggestedName: "png.png",
              timing: {
                inspectMs: 0,
                decodeMs: 0,
                transformMs: 0,
                encodeMs: 0,
                totalMs: 0,
                encodeAttempts: 1,
              },
            },
          },
        ]),
      ),
    );

    await expect(
      runLocalImageOptimizeFallback(
        [png],
        { ...losslessSpec, mode: "smart", preset: "smallest" },
        { runSmart },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "fulfilled",
        warnings: ["SMART_PNG_FELL_BACK_TO_LOSSLESS"],
      }),
    ]);
    expect(runSmart.mock.calls[0]?.[0][0]?.spec.output).toEqual({
      format: "source",
      compression: { mode: "quality", quality: 72 },
    });
  });

  it("uses one lossless batch and forwards its progress and outcomes", async () => {
    const source = item("source");
    const onEvent = vi.fn();
    const runLossless = vi.fn((_items, options) => {
      options.onEvent?.({
        type: "item-progress",
        itemId: source.itemId,
        phase: "optimizing",
        fraction: null,
      });
      return handle(
        Promise.resolve([
          { status: "unsupported", itemId: source.itemId, reason: "LOSSLESS_SERVER_REQUIRED" },
        ]),
      );
    });

    await expect(
      runLocalImageOptimizeFallback([source], losslessSpec, { runLossless, onEvent }),
    ).resolves.toEqual([
      { status: "unsupported", itemId: "source", reason: "LOSSLESS_SERVER_REQUIRED" },
    ]);
    expect(runLossless).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "item-progress",
      itemId: "source",
      phase: "optimizing",
      fraction: null,
    });
    expect(source.file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels the active smart batch exactly once when aborted", async () => {
    const source = item("source");
    const controller = new AbortController();
    let resolve!: (value: readonly never[]) => void;
    const cancel = vi.fn();
    const runSmart = vi.fn<NonNullable<LocalFallbackOptions["runSmart"]>>(() =>
      smartHandle(
        new Promise((done) => {
          resolve = done;
        }),
        cancel,
      ),
    );
    const pending = runLocalImageOptimizeFallback(
      [source],
      { ...losslessSpec, mode: "smart" },
      {
        signal: controller.signal,
        runSmart,
      },
    );

    controller.abort();
    controller.abort();
    resolve([]);
    await expect(pending).resolves.toEqual([{ status: "cancelled", itemId: "source" }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
