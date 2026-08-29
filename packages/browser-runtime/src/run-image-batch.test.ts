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

function fakeFile(name: string, bytes = Uint8Array.of(1, 2, 3)): File {
  return new File([bytes], name, { type: "image/png" });
}

function result(byteLength = 12): ImagePipelineResult {
  return {
    bytes: new ArrayBuffer(byteLength),
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

interface PostedRequest {
  request: WorkerRequest;
  transfer: readonly Transferable[];
}

class CompletingWorker {
  static instances = 0;
  static created: CompletingWorker[] = [];
  readonly posts: PostedRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    CompletingWorker.instances += 1;
    CompletingWorker.created.push(this);
  }

  postMessage(request: WorkerRequest, transfer: readonly Transferable[] = []): void {
    this.posts.push({ request, transfer });
    if (request.type !== "run") return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: { protocol: 1, type: "complete", jobId: request.jobId, result: result() },
      } as MessageEvent<WorkerEvent>);
    });
  }

  terminate(): void {}
}

class ControlledWorker {
  static created: ControlledWorker[] = [];
  readonly posts: PostedRequest[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminateCount = 0;

  constructor() {
    ControlledWorker.created.push(this);
  }

  postMessage(request: WorkerRequest, transfer: readonly Transferable[] = []): void {
    this.posts.push({ request, transfer });
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: event } as MessageEvent<unknown>);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

function postedRun(worker: ControlledWorker, index = 0): Extract<WorkerRequest, { type: "run" }> {
  const request = worker.posts.filter(({ request }) => request.type === "run")[index]?.request;
  if (request?.type !== "run") throw new Error("Expected a run request.");
  return request;
}

function complete(
  worker: ControlledWorker,
  request: Extract<WorkerRequest, { type: "run" }>,
): void {
  worker.emit({ protocol: 1, type: "complete", jobId: request.jobId, result: result() });
}

function installRuntime(
  worker: typeof CompletingWorker | typeof ControlledWorker,
  navigatorProperties: { deviceMemory?: number } = { deviceMemory: 8 },
): void {
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", () => undefined);
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, ...navigatorProperties });
}

afterEach(() => {
  CompletingWorker.instances = 0;
  CompletingWorker.created = [];
  ControlledWorker.created = [];
  vi.unstubAllGlobals();
});

describe("runImageBatch", () => {
  it("posts the native source File without reading it in the UI realm", async () => {
    installRuntime(CompletingWorker);
    const file = fakeFile("private.png");
    const read = vi.spyOn(file, "arrayBuffer");
    const handle = runImageBatch([{ itemId: "one", file, spec }], { concurrency: 1 });
    const worker = CompletingWorker.created[0] as CompletingWorker;
    const posted = worker.posts.find(({ request }) => request.type === "run");

    expect(read).not.toHaveBeenCalled();
    expect(posted?.transfer).toEqual([]);
    expect(posted?.request).toMatchObject({
      type: "run",
      input: { name: "private.png", mimeHint: "image/png", byteLength: 3, file },
    });
    handle.cancel();
    await handle.result;
  });

  it("keeps source reads out of the UI while reusing a single worker", async () => {
    installRuntime(ControlledWorker);
    const first = fakeFile("first.png");
    const second = fakeFile("second.png");
    const firstRead = vi.spyOn(first, "arrayBuffer");
    const secondRead = vi.spyOn(second, "arrayBuffer");
    const handle = runImageBatch(
      [
        { itemId: "first", file: first, spec },
        { itemId: "second", file: second, spec },
      ],
      { concurrency: 1 },
    );
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const firstRequest = postedRun(worker);

    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
    complete(worker, firstRequest);
    const secondRequest = postedRun(worker, 1);
    complete(worker, secondRequest);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled" },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(worker.posts.filter(({ request }) => request.type === "run")).toHaveLength(2);
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
  });

  it("keeps an unsafe public item ID out of the internal worker correlation ID", async () => {
    installRuntime(ControlledWorker);
    const itemId = `\u0000${"x".repeat(128)}`;
    const handle = runImageBatch([{ itemId, file: fakeFile("one.png"), spec }], {
      concurrency: 1,
    });
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const request = postedRun(worker);

    expect(request.jobId).not.toContain(itemId);
    expect(request.jobId.length).toBeLessThanOrEqual(128);
    complete(worker, request);

    await expect(handle.result).resolves.toMatchObject([{ itemId, status: "fulfilled" }]);
  });

  it("settles cancellation once and ignores a late completion", async () => {
    installRuntime(ControlledWorker);
    const events: unknown[] = [];
    const handle = runImageBatch([{ itemId: "one", file: fakeFile("one.png"), spec }], {
      concurrency: 1,
      onEvent: (event) => events.push(event),
    });
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const request = postedRun(worker);

    handle.cancel();
    complete(worker, request);

    await expect(handle.result).resolves.toEqual([{ itemId: "one", status: "cancelled" }]);
    expect(events.filter((event) => (event as { type: string }).type === "item-complete")).toEqual(
      [],
    );
  });

  it.each([
    ["a non-ordinary buffer", () => Object.setPrototypeOf(new ArrayBuffer(12), null)],
    ["a declared result length that differs from its buffer", () => new ArrayBuffer(11)],
    ["an invalid output MIME", () => new ArrayBuffer(12), { mime: "image/avif" }],
    ["an unsafe suggested name", () => new ArrayBuffer(12), { suggestedName: " bad.webp" }],
    ["an invalid warning", () => new ArrayBuffer(12), { warnings: ["PRIVATE_WARNING"] }],
    [
      "negative timing",
      () => new ArrayBuffer(12),
      { timing: { ...result().timing, decodeMs: -1 } },
    ],
  ])("rejects %s from the active worker and replaces its slot", async (_label, bytes, overrides: Record<
    string,
    unknown
  > = {}) => {
    installRuntime(ControlledWorker);
    const handle = runImageBatch(
      [
        { itemId: "first", file: fakeFile("first.png"), spec },
        { itemId: "second", file: fakeFile("second.png"), spec },
      ],
      { concurrency: 1 },
    );
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const request = postedRun(worker);
    const malformed = { ...result(), bytes: bytes(), ...overrides };
    worker.emit({ protocol: 1, type: "complete", jobId: request.jobId, result: malformed });

    const replacement = ControlledWorker.created[1] as ControlledWorker;
    const secondRequest = postedRun(replacement);
    complete(replacement, secondRequest);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects regressive progress from the active worker and replaces its slot", async () => {
    installRuntime(ControlledWorker);
    const handle = runImageBatch(
      [
        { itemId: "first", file: fakeFile("first.png"), spec },
        { itemId: "second", file: fakeFile("second.png"), spec },
      ],
      { concurrency: 1 },
    );
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const request = postedRun(worker);
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: request.jobId,
      sequence: 1,
      phase: "decoding",
      fraction: 0.5,
    });
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: request.jobId,
      sequence: 0,
      phase: "validating",
      fraction: 0.2,
    });

    const replacement = ControlledWorker.created[1] as ControlledWorker;
    complete(replacement, postedRun(replacement));
    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
  });

  it("rejects an invalid public worker failure payload and replaces its slot", async () => {
    installRuntime(ControlledWorker);
    const handle = runImageBatch(
      [
        { itemId: "first", file: fakeFile("first.png"), spec },
        { itemId: "second", file: fakeFile("second.png"), spec },
      ],
      { concurrency: 1 },
    );
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const request = postedRun(worker);
    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: request.jobId,
      error: { code: "CORRUPT_INPUT", message: "private\nmessage", retryable: true },
    });

    const replacement = ControlledWorker.created[1] as ControlledWorker;
    complete(replacement, postedRun(replacement));
    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
  });

  it("rejects a well-formed output over 100MiB with the public memory limit", async () => {
    installRuntime(ControlledWorker);
    const handle = runImageBatch([{ itemId: "one", file: fakeFile("one.png"), spec }], {
      concurrency: 1,
    });
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const request = postedRun(worker);
    const byteLength = 100 * 1024 * 1024 + 1;
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: request.jobId,
      result: result(byteLength),
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", error: { code: "MEMORY_LIMIT" } },
    ]);
  });

  it("preserves the 500MiB aggregate output limit", async () => {
    installRuntime(ControlledWorker);
    const handle = runImageBatch(
      Array.from({ length: 6 }, (_, index) => ({
        itemId: `item-${index + 1}`,
        file: fakeFile(`item-${index + 1}.png`),
        spec,
      })),
      { concurrency: 1 },
    );
    const worker = ControlledWorker.created[0];
    if (worker === undefined) throw new Error("Expected a worker.");
    const maximum = 100 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      const request = postedRun(worker, index);
      worker.emit({
        protocol: 1,
        type: "complete",
        jobId: request.jobId,
        result: result(maximum),
      });
    }
    const finalRequest = postedRun(worker, 5);
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: finalRequest.jobId,
      result: { ...result(1), bytes: new ArrayBuffer(1) },
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "item-1", status: "fulfilled" },
      { itemId: "item-2", status: "fulfilled" },
      { itemId: "item-3", status: "fulfilled" },
      { itemId: "item-4", status: "fulfilled" },
      { itemId: "item-5", status: "fulfilled" },
      { itemId: "item-6", status: "rejected", error: { code: "MEMORY_LIMIT" } },
    ]);
  });

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
