import type {
  ImagePipelineResult,
  ImagePipelineSpec,
  ToolErrorPayload,
} from "@hereisit/tool-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMocks = vi.hoisted(() => ({
  process: vi.fn(),
  PipelineError: class extends Error {
    constructor(
      readonly code: ToolErrorPayload["code"],
      message: string,
      readonly retryable = false,
    ) {
      super(message);
    }
  },
}));

vi.mock("./image-pipeline", () => ({
  processImagePipeline: pipelineMocks.process,
  ImagePipelineError: pipelineMocks.PipelineError,
}));

const MEBIBYTE = 1024 * 1024;
const spec: ImagePipelineSpec = {
  version: 2,
  resize: { kind: "none" },
  output: { format: "png", compression: { mode: "lossless" } },
  metadata: "strip",
  sizeGoal: { mode: "allow-growth" },
  autoOrient: true,
};

class StubWorkerScope {
  readonly posts: Array<{ event: unknown; transfer: readonly Transferable[] }> = [];
  onmessage: ((message: MessageEvent<unknown>) => void) | null = null;

  postMessage(event: unknown, transfer: readonly Transferable[] = []): void {
    this.posts.push({ event, transfer });
  }

  dispatch(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function result(): ImagePipelineResult {
  return {
    bytes: Uint8Array.of(9, 8, 7).buffer,
    suggestedName: "output.png",
    mime: "image/png",
    width: 1,
    height: 1,
    byteLength: 3,
    warnings: [],
    timing: {
      inspectMs: 1,
      decodeMs: 1,
      transformMs: 1,
      encodeMs: 1,
      totalMs: 4,
      encodeAttempts: 1,
    },
  };
}

function runRequest(
  file = new File([Uint8Array.of(1, 2, 3)], "photo.png", { type: "image/png" }),
): Record<string, unknown> {
  return {
    protocol: 1,
    type: "run",
    jobId: "job-1",
    tool: "image.pipeline",
    toolVersion: 2,
    input: { name: file.name, mimeHint: file.type, byteLength: file.size, file },
    spec,
  };
}

function terminalPosts(scope: StubWorkerScope, jobId?: string) {
  return scope.posts.filter(({ event }) => {
    if (typeof event !== "object" || event === null) return false;
    const candidate = event as { type?: unknown; jobId?: unknown };
    return (
      (jobId === undefined || candidate.jobId === jobId) &&
      (candidate.type === "complete" || candidate.type === "failed")
    );
  });
}

function failure(scope: StubWorkerScope, jobId?: string): ToolErrorPayload | undefined {
  const event = terminalPosts(scope, jobId).at(-1)?.event as
    | { error?: ToolErrorPayload }
    | undefined;
  return event?.error;
}

async function loadWorker(): Promise<StubWorkerScope> {
  const scope = new StubWorkerScope();
  vi.stubGlobal("self", scope);
  await import("./image.worker");
  return scope;
}

beforeEach(() => {
  vi.resetModules();
  pipelineMocks.process.mockReset();
  pipelineMocks.process.mockResolvedValue(result());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image Worker file input", () => {
  it("reads a native File into an ordinary ArrayBuffer before invoking the pipeline", async () => {
    const pipelineResult = result();
    pipelineMocks.process.mockResolvedValueOnce(pipelineResult);
    const scope = await loadWorker();
    scope.dispatch(runRequest());

    await vi.waitFor(() => expect(pipelineMocks.process).toHaveBeenCalledOnce());
    const input = pipelineMocks.process.mock.calls[0]?.[0] as {
      bytes: ArrayBuffer;
      byteLength: number;
    };
    expect([...new Uint8Array(input.bytes)]).toEqual([1, 2, 3]);
    expect(input.byteLength).toBe(3);
    expect(Object.getPrototypeOf(input.bytes)).toBe(ArrayBuffer.prototype);
    expect(Reflect.ownKeys(input.bytes)).toEqual([]);
    expect(terminalPosts(scope)).toEqual([
      {
        event: { protocol: 1, type: "complete", jobId: "job-1", result: pipelineResult },
        transfer: [pipelineResult.bytes],
      },
    ]);
  });

  it("rejects malformed and hostile request envelopes without invoking the pipeline", async () => {
    const scope = await loadWorker();
    const native = new File([Uint8Array.of(1)], "photo.png", { type: "image/png" });
    const requests: unknown[] = [
      {
        ...runRequest(),
        input: { name: native.name, mimeHint: native.type, byteLength: 1, file: {} },
      },
      { ...runRequest(), extra: true },
      {
        ...runRequest(),
        input: {
          name: native.name,
          mimeHint: native.type,
          byteLength: 1,
          file: native,
          extra: true,
        },
      },
      Object.assign(Object.create({}), runRequest()),
    ];
    const getterRequest = runRequest();
    Object.defineProperty(getterRequest, "spec", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_GETTER_FAILURE");
      },
    });
    requests.push(getterRequest);

    for (const request of requests) scope.dispatch(request);

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(requests.length));
    expect(pipelineMocks.process).not.toHaveBeenCalled();
    for (const { event } of terminalPosts(scope)) {
      expect(event).toMatchObject({
        type: "failed",
        error: { code: "INVALID_SPEC", retryable: false },
      });
      expect(JSON.stringify(event)).not.toContain("PRIVATE_GETTER_FAILURE");
    }
  });

  it.each([
    ["a 128-character job ID", "complete", () => ({ ...runRequest(), jobId: "j".repeat(128) })],
    ["a 129-character job ID", "ignore", () => ({ ...runRequest(), jobId: "j".repeat(129) })],
    [
      "a 512-character filename",
      "complete",
      () =>
        runRequest(new File([Uint8Array.of(1)], `${"n".repeat(508)}.png`, { type: "image/png" })),
    ],
    [
      "a 513-character filename",
      "invalid",
      () =>
        runRequest(new File([Uint8Array.of(1)], `${"n".repeat(509)}.png`, { type: "image/png" })),
    ],
    [
      "a 100-character MIME hint",
      "complete",
      () =>
        runRequest(
          new File([Uint8Array.of(1)], "photo.png", {
            type: `image/${"x".repeat(94)}`,
          }),
        ),
    ],
    [
      "a 101-character MIME hint",
      "invalid",
      () =>
        runRequest(
          new File([Uint8Array.of(1)], "photo.png", {
            type: `image/${"x".repeat(95)}`,
          }),
        ),
    ],
  ])("handles %s at its boundary", async (_label, outcome, makeRequest) => {
    const scope = await loadWorker();
    scope.dispatch(makeRequest());

    if (outcome === "ignore") {
      await Promise.resolve();
      expect(terminalPosts(scope)).toEqual([]);
      expect(pipelineMocks.process).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    if (outcome === "complete") {
      expect(terminalPosts(scope)[0]?.event).toMatchObject({ type: "complete" });
      expect(pipelineMocks.process).toHaveBeenCalledOnce();
    } else {
      expect(failure(scope)).toMatchObject({ code: "INVALID_SPEC", retryable: false });
      expect(pipelineMocks.process).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      "name",
      (request: Record<string, unknown>) => ({
        ...request,
        input: { ...(request.input as object), name: "other.png" },
      }),
    ],
    [
      "MIME",
      (request: Record<string, unknown>) => ({
        ...request,
        input: { ...(request.input as object), mimeHint: "image/jpeg" },
      }),
    ],
    [
      "declared size",
      (request: Record<string, unknown>) => ({
        ...request,
        input: { ...(request.input as object), byteLength: 2 },
      }),
    ],
    [
      "zero size",
      (request: Record<string, unknown>) => ({
        ...request,
        input: { ...(request.input as object), byteLength: 0 },
      }),
    ],
    [
      "over-limit size",
      (request: Record<string, unknown>) => ({
        ...request,
        input: { ...(request.input as object), byteLength: 50 * MEBIBYTE + 1 },
      }),
    ],
  ])("rejects a %s metadata mismatch before the pipeline runs", async (_name, change) => {
    const scope = await loadWorker();
    scope.dispatch(change(runRequest()));

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toMatchObject({ code: "INVALID_SPEC", retryable: false });
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("reports MEMORY_LIMIT for an empty File with matching metadata before reading it", async () => {
    const scope = await loadWorker();
    const file = new File([], "empty.png", { type: "image/png" });
    const read = vi.spyOn(file, "arrayBuffer");

    scope.dispatch(runRequest(file));

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toEqual({
      code: "MEMORY_LIMIT",
      message: "파일은 50MB 이하만 처리할 수 있습니다.",
      retryable: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("reports MEMORY_LIMIT for a File over the input limit with matching metadata before reading it", async () => {
    const scope = await loadWorker();
    let read: ReturnType<typeof vi.spyOn>;
    {
      const file = new File([new Uint8Array(50 * MEBIBYTE + 1)], "large.png", {
        type: "image/png",
      });
      read = vi.spyOn(file, "arrayBuffer");
      scope.dispatch(runRequest(file));
    }

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toEqual({
      code: "MEMORY_LIMIT",
      message: "파일은 50MB 이하만 처리할 수 있습니다.",
      retryable: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("sanitizes an unexpected pipeline rejection", async () => {
    pipelineMocks.process.mockRejectedValueOnce(new Error("PRIVATE_PIPELINE_FAILURE"));
    const scope = await loadWorker();

    scope.dispatch(runRequest());

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toEqual({
      code: "WORKER_CRASH",
      message: "이미지를 처리하는 중 오류가 발생했습니다.",
      retryable: true,
    });
    expect(JSON.stringify(terminalPosts(scope))).not.toContain("PRIVATE_PIPELINE_FAILURE");
  });

  it("sanitizes a File read error", async () => {
    const scope = await loadWorker();
    const unreadable = new File([Uint8Array.of(1)], "private.png", { type: "image/png" });
    Object.defineProperty(unreadable, "arrayBuffer", {
      value: vi.fn().mockRejectedValue(new Error("PRIVATE_READ_FAILURE")),
    });

    scope.dispatch(runRequest(unreadable));

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toEqual({
      code: "CORRUPT_INPUT",
      message: "이미지 파일을 읽지 못했습니다.",
      retryable: true,
    });
    expect(JSON.stringify(terminalPosts(scope))).not.toContain("PRIVATE_READ_FAILURE");
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects a prototype-null ArrayBuffer returned by a native File", async () => {
    const scope = await loadWorker();
    const prototypeNull = new File([Uint8Array.of(1)], "prototype-null.png", { type: "image/png" });
    const nullBuffer = new ArrayBuffer(1);
    Object.setPrototypeOf(nullBuffer, null);
    Object.defineProperty(prototypeNull, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(nullBuffer),
    });
    scope.dispatch(runRequest(prototypeNull));

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toEqual({
      code: "CORRUPT_INPUT",
      message: "이미지 파일 크기를 확인하지 못했습니다.",
      retryable: false,
    });
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects a valid ArrayBuffer whose length changed", async () => {
    const scope = await loadWorker();
    const wrongLength = new File([Uint8Array.of(1)], "wrong-length.png", { type: "image/png" });
    Object.defineProperty(wrongLength, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new ArrayBuffer(2)),
    });

    scope.dispatch(runRequest(wrongLength));

    await vi.waitFor(() => expect(terminalPosts(scope)).toHaveLength(1));
    expect(failure(scope)).toEqual({
      code: "CORRUPT_INPUT",
      message: "이미지 파일 크기를 확인하지 못했습니다.",
      retryable: false,
    });
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects a second run while a File read is pending", async () => {
    const scope = await loadWorker();
    const pending = deferred<ArrayBuffer>();
    const file = new File([Uint8Array.of(1)], "pending.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: vi.fn().mockReturnValue(pending.promise) });

    scope.dispatch(runRequest(file));
    await vi.waitFor(() => expect(file.arrayBuffer).toHaveBeenCalledOnce());
    scope.dispatch({ ...runRequest(), jobId: "job-2" });
    await vi.waitFor(() => expect(terminalPosts(scope, "job-2")).toHaveLength(1));
    expect(failure(scope, "job-2")).toMatchObject({ code: "WORKER_CRASH", retryable: true });
    expect(pipelineMocks.process).not.toHaveBeenCalled();

    pending.resolve(Uint8Array.of(1).buffer);
    await vi.waitFor(() => expect(terminalPosts(scope, "job-1")).toHaveLength(1));
    expect(terminalPosts(scope, "job-1")[0]?.event).toMatchObject({ type: "complete" });
    expect(pipelineMocks.process).toHaveBeenCalledOnce();

    scope.dispatch({ ...runRequest(), jobId: "job-3" });
    await vi.waitFor(() => expect(terminalPosts(scope, "job-3")).toHaveLength(1));
    expect(terminalPosts(scope, "job-3")[0]?.event).toMatchObject({ type: "complete" });
    expect(pipelineMocks.process).toHaveBeenCalledTimes(2);
  });

  it("cancels before a pending File read resolves without running the pipeline", async () => {
    const scope = await loadWorker();
    const pending = deferred<ArrayBuffer>();
    const file = new File([Uint8Array.of(1)], "pending.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: vi.fn().mockReturnValue(pending.promise) });

    scope.dispatch(runRequest(file));
    await vi.waitFor(() => expect(file.arrayBuffer).toHaveBeenCalledOnce());

    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    pending.resolve(Uint8Array.of(1).buffer);
    await vi.waitFor(() => expect(terminalPosts(scope, "job-1")).toHaveLength(1));
    expect(failure(scope, "job-1")).toEqual({
      code: "CANCELLED",
      message: "작업을 중단했습니다.",
      retryable: false,
    });
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });
});
