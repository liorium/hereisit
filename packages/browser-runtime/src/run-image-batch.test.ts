import type { ImagePipelineResult, WorkerEvent, WorkerRequest } from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runImageBatch } from "./run-image-batch";

const spec = {
  version: 1 as const,
  resize: { kind: "none" as const },
  output: { format: "webp" as const, compression: { mode: "quality" as const, quality: 80 } },
  autoOrient: true as const,
  metadata: "strip" as const,
};

function fakeFile(name: string): File {
  const bytes = Uint8Array.of(1, 2, 3);
  return {
    name,
    type: "image/png",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  } as File;
}

function result(byteLength = 12): ImagePipelineResult {
  return {
    bytes: new ArrayBuffer(1),
    suggestedName: "result.webp",
    mime: "image/webp",
    width: 1,
    height: 1,
    byteLength,
    warnings: [],
    timing: {
      inspectMs: 0,
      decodeMs: 0,
      transformMs: 0,
      encodeMs: 0,
      totalMs: 0,
      encodeAttempts: 1,
    },
  };
}

class CompletingWorker {
  static instances = 0;
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    CompletingWorker.instances += 1;
  }

  postMessage(request: WorkerRequest): void {
    if (request.type !== "run") return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: { protocol: 1, type: "complete", jobId: request.jobId, result: result() },
      } as MessageEvent<WorkerEvent>);
    });
  }

  terminate(): void {}
}

function installRuntime(
  worker: typeof CompletingWorker,
  navigatorProperties: { deviceMemory?: number } = { deviceMemory: 8 },
): void {
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", () => undefined);
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, ...navigatorProperties });
}

afterEach(() => {
  CompletingWorker.instances = 0;
  vi.unstubAllGlobals();
});

describe("runImageBatch", () => {
  it("uses one worker when device memory is not reported", async () => {
    installRuntime(CompletingWorker, {});
    const handle = runImageBatch([
      { itemId: "first", file: fakeFile("first.png"), spec },
      { itemId: "second", file: fakeFile("second.png"), spec },
    ]);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled" },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(CompletingWorker.instances).toBe(1);
  });

  it("falls back from NaN concurrency and survives observer exceptions", async () => {
    installRuntime(CompletingWorker);
    const handle = runImageBatch(
      [
        { itemId: "first", file: fakeFile("first.png"), spec },
        { itemId: "second", file: fakeFile("second.png"), spec },
      ],
      {
        concurrency: Number.NaN,
        onEvent: () => {
          throw new Error("observer failure");
        },
      },
    );

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled" },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(CompletingWorker.instances).toBe(1);
  });

  it("turns a synchronous Worker creation failure into rejected item results", async () => {
    class ThrowingWorker extends CompletingWorker {
      constructor() {
        super();
        throw new DOMException("blocked", "SecurityError");
      }
    }
    installRuntime(ThrowingWorker);

    const handle = runImageBatch([{ itemId: "one", file: fakeFile("one.png"), spec }]);
    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", error: { code: "WORKER_CRASH" } },
    ]);
  });
});
