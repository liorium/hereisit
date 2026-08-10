import type {
  ImageOptimizeLosslessResult,
  ImageOptimizeWorkerRequest,
} from "@hereisit/tool-contracts/image-optimize";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectImageOptimizeFiles,
  runLosslessImageOptimizeBatch,
  supportsBrowserImageOptimizeRuntime,
} from "./run-image-optimize-batch";

function file(name: string, bytes = Uint8Array.of(1, 2, 3)): File {
  return new File([bytes], name, { type: "image/png" });
}

class ControlledWorker {
  static created: ControlledWorker[] = [];
  readonly posts: ImageOptimizeWorkerRequest[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminateCount = 0;

  constructor() {
    ControlledWorker.created.push(this);
  }

  postMessage(request: ImageOptimizeWorkerRequest): void {
    this.posts.push(request);
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: event } as MessageEvent<unknown>);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  crash(): void {
    this.onerror?.();
  }

  messageError(): void {
    this.onmessageerror?.();
  }
}

function request(
  worker: ControlledWorker,
  index = 0,
): Exclude<ImageOptimizeWorkerRequest, { type: "cancel" }> {
  const posted = worker.posts.filter((entry) => entry.type !== "cancel")[index];
  if (posted === undefined) throw new Error("Expected a job request.");
  return posted;
}

function result(byteLength = 3): ImageOptimizeLosslessResult {
  return {
    bytes: new ArrayBuffer(byteLength),
    byteLength,
    mime: "image/png",
    width: 1,
    height: 1,
    warnings: [],
  };
}

function installRuntime(): void {
  vi.stubGlobal("Worker", ControlledWorker);
}

afterEach(() => {
  ControlledWorker.created = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("image optimize Worker batches", () => {
  it("uses one Worker, preserves inspection order, and leaves source reads in the Worker", async () => {
    installRuntime();
    const first = file("first.png");
    const second = file("second.png");
    const firstRead = vi.spyOn(first, "arrayBuffer");
    const secondRead = vi.spyOn(second, "arrayBuffer");
    const handle = inspectImageOptimizeFiles([
      { itemId: "first", file: first },
      { itemId: "second", file: second },
    ]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const firstRequest = request(worker);

    expect(firstRequest).toMatchObject({
      type: "inspect",
      input: { name: "first.png", mimeHint: "image/png", byteLength: 3, file: first },
    });
    expect(Reflect.ownKeys(firstRequest)).toEqual(["protocol", "type", "jobId", "input"]);
    expect(Reflect.ownKeys(firstRequest.input)).toEqual(["name", "mimeHint", "byteLength", "file"]);
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
    worker.emit({
      protocol: 1,
      type: "inspected",
      jobId: firstRequest.jobId,
      result: { mime: "image/png", width: 1, height: 1, animated: false },
    });
    const secondRequest = request(worker, 1);
    expect(secondRequest.input.file).toBe(second);
    worker.emit({
      protocol: 1,
      type: "inspected",
      jobId: secondRequest.jobId,
      result: { mime: "image/png", width: 2, height: 1, animated: false },
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled", value: { width: 1 } },
      { itemId: "second", status: "fulfilled", value: { width: 2 } },
    ]);
    expect(ControlledWorker.created).toHaveLength(1);
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
  });

  it("accepts the positive 20-item batch bound sequentially", async () => {
    installRuntime();
    const items = Array.from({ length: 20 }, (_, index) => ({
      itemId: `item-${index}`,
      file: file(`item-${index}.png`, Uint8Array.of(index)),
    }));
    const handle = inspectImageOptimizeFiles(items);
    const worker = ControlledWorker.created[0] as ControlledWorker;

    for (let index = 0; index < items.length; index += 1) {
      const posted = request(worker, index);
      worker.emit({
        protocol: 1,
        type: "inspected",
        jobId: posted.jobId,
        result: { mime: "image/png", width: 1, height: 1, animated: false },
      });
    }

    await expect(handle.result).resolves.toHaveLength(20);
    expect(ControlledWorker.created).toHaveLength(1);
  });

  it("preserves lossless progress and validates an ordinary transferred result", async () => {
    installRuntime();
    const events: unknown[] = [];
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }], {
      onEvent: (event) => events.push(event),
    });
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: posted.jobId,
      sequence: 0,
      phase: "optimizing",
      fraction: null,
    });
    worker.emit({ protocol: 1, type: "complete", jobId: posted.jobId, result: result() });

    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
    expect(events).toContainEqual({
      type: "item-progress",
      itemId: "one",
      phase: "optimizing",
      fraction: null,
    });
  });

  it("preserves multiple monotonic progress events in order", async () => {
    installRuntime();
    const phases: string[] = [];
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }], {
      onEvent: (event) => {
        if (event.type === "item-progress") phases.push(event.phase);
      },
    });
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);

    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: posted.jobId,
      sequence: 0,
      phase: "inspecting",
      fraction: null,
    });
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: posted.jobId,
      sequence: 1,
      phase: "optimizing",
      fraction: null,
    });
    worker.emit({ protocol: 1, type: "complete", jobId: posted.jobId, result: result() });

    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
    expect(phases).toEqual(["inspecting", "optimizing"]);
  });

  it.each([
    0, -1,
  ])("rejects duplicate or regressive progress sequence %i", async (secondSequence) => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: posted.jobId,
      sequence: 0,
      phase: "inspecting",
      fraction: null,
    });
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: posted.jobId,
      sequence: secondSequence,
      phase: "optimizing",
      fraction: null,
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
  });

  it("rejects a Worker result that exceeds its source envelope", async () => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);

    worker.emit({ protocol: 1, type: "complete", jobId: posted.jobId, result: result(4) });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
  });

  it("contains hostile Worker events and settles the active item", async () => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);
    const hostileResult = { ...result() };
    Object.defineProperty(hostileResult, "byteLength", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_WORKER_DETAIL");
      },
    });

    expect(() =>
      worker.emit({ protocol: 1, type: "complete", jobId: posted.jobId, result: hostileResult }),
    ).not.toThrow();
    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
  });

  it("ignores malformed stale events before parsing and keeps the current item running", async () => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);
    const stale = { protocol: 1, type: "complete", jobId: "stale", result: {} };
    Object.defineProperty(stale.result, "bytes", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_STALE_DETAIL");
      },
    });

    expect(() => worker.emit(stale)).not.toThrow();
    worker.emit({ protocol: 1, type: "complete", jobId: posted.jobId, result: result() });

    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
  });

  it.each([
    "missing",
    "accessor",
    "unsafe",
  ] as const)("fails the active item immediately for a %s Worker job ID", async (kind) => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const event: Record<string, unknown> = { protocol: 1, type: "complete", result: result() };
    if (kind === "accessor") {
      Object.defineProperty(event, "jobId", {
        enumerable: true,
        get() {
          throw new Error("PRIVATE_JOB_ID");
        },
      });
    } else if (kind === "unsafe") {
      event.jobId = "\u0000unsafe";
    }

    expect(() => worker.emit(event)).not.toThrow();
    expect(worker.terminateCount).toBe(1);
    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
  });

  it.each([
    "crash",
    "messageError",
  ] as const)("settles the batch when the Worker signals %s", async (signal) => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;

    worker[signal]();

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
  });

  it("settles the active item when the 180-second watchdog expires", async () => {
    vi.useFakeTimers();
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;

    await vi.advanceTimersByTimeAsync(180_000);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
    expect(worker.terminateCount).toBe(1);
  });

  it("maps Worker error messages to fixed public Korean text", async () => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);

    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: posted.jobId,
      error: { code: "CORRUPT_INPUT", message: "PRIVATE_WORKER_ERROR", retryable: false },
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "이미지를 확인할 수 없습니다." },
    ]);
  });

  it("rejects a lossless result that exceeds the per-axis dimension limit", async () => {
    installRuntime();
    const handle = runLosslessImageOptimizeBatch([{ itemId: "one", file: file("one.png") }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;
    const posted = request(worker);
    const oversized = { ...result(), width: 32_769 };

    worker.emit({ protocol: 1, type: "complete", jobId: posted.jobId, result: oversized });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", message: "브라우저 작업기가 중단되었습니다." },
    ]);
  });

  it("rejects oversized items and batches before creating a Worker", async () => {
    installRuntime();
    const oversized = new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    const items = Array.from({ length: 21 }, (_, index) => ({
      itemId: `${index}`,
      file: oversized,
    }));
    const handle = runLosslessImageOptimizeBatch(items);

    await expect(handle.result).resolves.toHaveLength(21);
    expect(ControlledWorker.created).toEqual([]);
  });

  it("rejects a real per-item file above 30MiB within the 20-item batch bound", async () => {
    installRuntime();
    const oversized = new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    const handle = runLosslessImageOptimizeBatch([{ itemId: "large", file: oversized }]);
    const worker = ControlledWorker.created[0] as ControlledWorker;

    await expect(handle.result).resolves.toEqual([
      { itemId: "large", status: "rejected", message: "파일은 30MB 이하만 처리할 수 있습니다." },
    ]);
    expect(worker.posts).toEqual([]);
  });

  it("isolates observers and settles every pending item exactly once on cancellation", async () => {
    installRuntime();
    const events: unknown[] = [];
    const handle = runLosslessImageOptimizeBatch(
      [
        { itemId: "first", file: file("first.png") },
        { itemId: "second", file: file("second.png") },
      ],
      {
        onEvent: (event) => {
          events.push(event);
          throw new Error("observer failure");
        },
      },
    );
    const worker = ControlledWorker.created[0] as ControlledWorker;
    handle.cancel();

    await expect(handle.result).resolves.toEqual([
      { itemId: "first", status: "cancelled" },
      { itemId: "second", status: "cancelled" },
    ]);
    expect(worker.terminateCount).toBe(1);
    expect(events).toHaveLength(4);
  });

  it("reports false when the native Worker runtime is unavailable", () => {
    expect(supportsBrowserImageOptimizeRuntime()).toBe(false);
  });
});
