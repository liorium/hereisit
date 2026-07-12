import type {
  PdfToImagesErrorPayload,
  PdfToImagesProgress,
  PdfToImagesResult,
  PdfToImagesRunRequest,
  PdfToImagesSpecV1,
} from "@hereisit/tool-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMocks = vi.hoisted(() => ({
  run: vi.fn(),
  toErrorPayload: vi.fn(),
}));

vi.mock("./pdf-to-images-pipeline", () => ({
  runPdfToImagesPipeline: pipelineMocks.run,
  toPdfToImagesErrorPayload: pipelineMocks.toErrorPayload,
}));

const validSpec: PdfToImagesSpecV1 = {
  version: 1,
  selection: { mode: "every-page" },
  output: { format: "png", background: "#ffffff" },
  dpi: 96,
};

interface WorkerPipelineOptions {
  onProgress?: (progress: PdfToImagesProgress) => void;
  signal?: AbortSignal;
}

interface ScopePost {
  event: unknown;
  transfer: readonly Transferable[];
}

class StubWorkerScope {
  readonly posts: ScopePost[] = [];
  onmessage: ((message: MessageEvent<unknown>) => void) | null = null;

  postMessage(event: unknown, transfer: readonly Transferable[] = []): void {
    this.posts.push({ event, transfer });
  }

  dispatch(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

class WorkerProbeCanvas {
  static instances: WorkerProbeCanvas[] = [];

  constructor(
    public width: number,
    public height: number,
  ) {
    WorkerProbeCanvas.instances.push(this);
  }

  getContext(contextId: string): object | null {
    return contextId === "2d" ? {} : null;
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function result(bytes = Uint8Array.of(1, 2, 3).buffer): PdfToImagesResult {
  return {
    bytes,
    suggestedName: "report-page-001.png",
    mime: "image/png",
    byteLength: bytes.byteLength,
    sourcePageCount: 1,
    outputPageCount: 1,
    outputFileCount: 1,
    format: "png",
    warnings: ["PDF_PAGE_RASTERIZED", "COLOR_PROFILE_NORMALIZED"],
    timing: { loadMs: 1, renderMs: 2, encodeMs: 3, archiveMs: 0, totalMs: 6 },
  };
}

function runRequest(jobId = "job-1", overrides: Record<string, unknown> = {}): unknown {
  const bytes = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer;
  return {
    protocol: 1,
    type: "run",
    jobId,
    tool: "pdf.to-images",
    toolVersion: 1,
    input: {
      name: "report.pdf",
      mimeHint: "application/pdf",
      byteLength: bytes.byteLength,
      bytes,
    },
    spec: validSpec,
    ...overrides,
  };
}

function terminalPosts(scope: StubWorkerScope, jobId: string): ScopePost[] {
  return scope.posts.filter(({ event }) => {
    if (typeof event !== "object" || event === null) return false;
    if (!("jobId" in event) || event.jobId !== jobId || !("type" in event)) return false;
    return event.type === "complete" || event.type === "failed";
  });
}

async function loadWorker(offscreenCanvas: unknown = WorkerProbeCanvas): Promise<StubWorkerScope> {
  const scope = new StubWorkerScope();
  vi.stubGlobal("self", scope);
  vi.stubGlobal("OffscreenCanvas", offscreenCanvas);
  await import("./pdf-to-images.worker");
  return scope;
}

async function flushWorker(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  pipelineMocks.run.mockReset();
  pipelineMocks.toErrorPayload.mockReset();
  pipelineMocks.toErrorPayload.mockReturnValue({
    code: "WORKER_CRASH",
    message: "PDF 이미지 변환 작업을 완료하지 못했어요.",
    retryable: true,
  } satisfies PdfToImagesErrorPayload);
  WorkerProbeCanvas.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pdf-to-images Worker readiness", () => {
  it("advertises exact capabilities after a full 1x1 canvas probe and releases the canvas", async () => {
    const scope = await loadWorker();

    expect(scope.posts).toHaveLength(1);
    expect(scope.posts[0]).toEqual({
      event: {
        protocol: 1,
        type: "ready",
        capabilities: { offscreenCanvas: true, formats: ["jpeg", "png"] },
      },
      transfer: [],
    });
    expect(WorkerProbeCanvas.instances).toHaveLength(1);
    expect(WorkerProbeCanvas.instances[0]).toMatchObject({ width: 0, height: 0 });
    expect(pipelineMocks.run).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "noncallable",
  ] as const)("reports OffscreenCanvas unavailable with a non-null 2D context and %s convertToBlob", async (convertToBlob) => {
    class UnsupportedCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}

      getContext(): object {
        return {};
      }
    }

    if (convertToBlob === "noncallable") {
      Object.defineProperty(UnsupportedCanvas.prototype, "convertToBlob", {
        configurable: true,
        value: "not-a-function",
      });
    }
    const scope = await loadWorker(UnsupportedCanvas);

    expect(scope.posts[0]).toMatchObject({
      event: { type: "ready", capabilities: { offscreenCanvas: false } },
    });
  });
});

describe("pdf-to-images Worker request validation", () => {
  it.each([
    null,
    {},
    { protocol: 2, type: "run", jobId: "job-1" },
    { protocol: 1, type: "run", jobId: "" },
    runRequest("job-1", { input: null }),
    runRequest("job-1", {
      input: {
        name: "report.pdf",
        mimeHint: "application/pdf",
        byteLength: 1,
        bytes: new ArrayBuffer(2),
      },
    }),
  ])("ignores a structurally malformed request without running the pipeline", async (request) => {
    const scope = await loadWorker();

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(scope.posts).toHaveLength(1);
  });

  it.each([
    runRequest("wrong-tool", { tool: "pdf.merge" }),
    runRequest("wrong-version", { toolVersion: 2 }),
    runRequest("wrong-spec", { spec: { ...validSpec, dpi: 72 } }),
  ])("rejects an exact tool/version/spec mismatch without running", async (request) => {
    const scope = await loadWorker();
    const jobId = (request as { jobId: string }).jobId;

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(terminalPosts(scope, jobId)).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId,
          error: expect.objectContaining({ code: "INVALID_SPEC", retryable: false }),
        },
        transfer: [],
      },
    ]);
  });

  it("rejects a second active run without interrupting the first", async () => {
    const first = deferred<PdfToImagesResult>();
    pipelineMocks.run.mockReturnValueOnce(first.promise);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    scope.dispatch(runRequest("job-2"));

    expect(pipelineMocks.run).toHaveBeenCalledTimes(1);
    expect(terminalPosts(scope, "job-2")).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "job-2",
          error: expect.objectContaining({ code: "INVALID_SPEC", retryable: false }),
        },
        transfer: [],
      },
    ]);
    const firstOptions = pipelineMocks.run.mock.calls[0]?.[2] as WorkerPipelineOptions;
    expect(firstOptions.signal?.aborted).toBe(false);

    first.resolve(result());
    await flushWorker();
    expect(terminalPosts(scope, "job-1")).toHaveLength(1);
  });

  it("ignores a duplicate active run with the same job ID and lets the first complete", async () => {
    const first = deferred<PdfToImagesResult>();
    const output = result();
    pipelineMocks.run.mockReturnValueOnce(first.promise);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    scope.dispatch(runRequest("job-1"));

    expect(pipelineMocks.run).toHaveBeenCalledTimes(1);
    const firstOptions = pipelineMocks.run.mock.calls[0]?.[2] as WorkerPipelineOptions;
    expect(firstOptions.signal?.aborted).toBe(false);

    first.resolve(output);
    await flushWorker();
    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: { protocol: 1, type: "complete", jobId: "job-1", result: output },
        transfer: [output.bytes],
      },
    ]);
  });
});

describe("pdf-to-images Worker execution", () => {
  it("passes its AbortSignal to the pipeline and suppresses the cancelled outcome", async () => {
    const pending = deferred<PdfToImagesResult>();
    pipelineMocks.run.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    const options = pipelineMocks.run.mock.calls[0]?.[2] as WorkerPipelineOptions;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);

    scope.dispatch({ protocol: 1, type: "cancel", jobId: "another-job" });
    expect(options.signal?.aborted).toBe(false);
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    expect(options.signal?.aborted).toBe(true);
    options.onProgress?.({ phase: "loading", fraction: 0.05 });

    pending.resolve(result());
    await flushWorker();
    expect(terminalPosts(scope, "job-1")).toHaveLength(0);
    expect(
      scope.posts.some(
        ({ event }) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "progress",
      ),
    ).toBe(false);
    expect(pipelineMocks.toErrorPayload).not.toHaveBeenCalled();
  });

  it("forwards exact progress with monotonically increasing sequence numbers from zero", async () => {
    const output = result();
    pipelineMocks.run.mockImplementation(
      async (_input: unknown, _spec: unknown, options: WorkerPipelineOptions) => {
        options.onProgress?.({ phase: "loading", fraction: 0.05 });
        options.onProgress?.({
          phase: "rendering",
          fraction: 0.4,
          completedPages: 1,
          totalPages: 2,
        });
        return output;
      },
    );
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(scope.posts.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: "ready" }),
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 0,
        phase: "loading",
        fraction: 0.05,
      },
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 1,
        phase: "rendering",
        fraction: 0.4,
        completedPages: 1,
        totalPages: 2,
      },
      expect.objectContaining({ type: "complete", jobId: "job-1" }),
    ]);
  });

  it("passes the validated input/spec and Worker-owned options to the pipeline", async () => {
    const output = result();
    pipelineMocks.run.mockResolvedValueOnce(output);
    const scope = await loadWorker();
    const request = runRequest("job-1") as PdfToImagesRunRequest;

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).toHaveBeenCalledOnce();
    expect(pipelineMocks.run).toHaveBeenCalledWith(
      request.input,
      validSpec,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
  });

  it("sanitizes a structured failure without posting raw exception or source data", async () => {
    const rawError = Object.assign(new Error("secret parser detail"), {
      source: "/Users/private/report.pdf",
    });
    pipelineMocks.run.mockRejectedValueOnce(rawError);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(pipelineMocks.toErrorPayload).toHaveBeenCalledWith(rawError);
    const failed = terminalPosts(scope, "job-1");
    expect(failed).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "job-1",
          error: {
            code: "WORKER_CRASH",
            message: "PDF 이미지 변환 작업을 완료하지 못했어요.",
            retryable: true,
          },
        },
        transfer: [],
      },
    ]);
    expect(JSON.stringify(failed)).not.toContain("secret parser detail");
    expect(JSON.stringify(failed)).not.toContain("/Users/private/report.pdf");
  });

  it("transfers exactly the completed result bytes", async () => {
    const bytes = Uint8Array.of(9, 8, 7).buffer;
    const output = result(bytes);
    pipelineMocks.run.mockResolvedValueOnce(output);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: { protocol: 1, type: "complete", jobId: "job-1", result: output },
        transfer: [bytes],
      },
    ]);
  });
});
