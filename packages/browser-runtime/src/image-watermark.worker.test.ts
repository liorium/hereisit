import type {
  ImageWatermarkErrorPayload,
  ImageWatermarkInput,
  ImageWatermarkPhase,
  ImageWatermarkResult,
  ImageWatermarkSpecV1,
} from "@hereisit/tool-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedImageWatermarkLogo } from "./image-watermark-pipeline";

const pipelineMocks = vi.hoisted(() => ({
  PipelineError: class extends Error {
    constructor(
      readonly code: ImageWatermarkErrorPayload["code"],
      message: string,
      readonly retryable = false,
    ) {
      super(message);
    }
  },
  closeLogo: vi.fn(),
  prepareLogo: vi.fn(),
  process: vi.fn(),
  toErrorPayload: vi.fn(),
}));

vi.mock("./image-watermark-pipeline", () => ({
  closePreparedImageWatermarkLogo: pipelineMocks.closeLogo,
  ImageWatermarkPipelineError: pipelineMocks.PipelineError,
  prepareImageWatermarkLogo: pipelineMocks.prepareLogo,
  processImageWatermarkPipeline: pipelineMocks.process,
  toImageWatermarkErrorPayload: pipelineMocks.toErrorPayload,
}));

const MEBIBYTE = 1024 * 1024;

const textSpec: ImageWatermarkSpecV1 = {
  version: 1,
  watermark: {
    kind: "text",
    text: "HereIsIt",
    color: "#ffffff",
    sizePercent: 12,
  },
  position: "bottom-right",
  marginPercent: 3,
  opacity: 0.7,
  output: { format: "png" },
  autoOrient: true,
  metadata: "strip",
};

const logoSpec: ImageWatermarkSpecV1 = {
  ...textSpec,
  watermark: { kind: "logo", widthPercent: 20 },
};

interface PipelineCall {
  report: (phase: ImageWatermarkPhase, fraction: number) => void;
  signal: AbortSignal;
}

interface ScopePost {
  event: unknown;
  transfer: readonly Transferable[];
}

class StubWorkerScope {
  readonly posts: ScopePost[] = [];
  onmessage: ((message: MessageEvent<unknown>) => void) | null = null;
  failPost: ((event: unknown, transfer: readonly Transferable[]) => boolean) | undefined;
  onPost: ((event: unknown) => void) | undefined;

  postMessage(event: unknown, transfer: readonly Transferable[] = []): void {
    if (this.failPost?.(event, transfer)) {
      throw new DOMException("transfer rejected", "DataCloneError");
    }
    this.onPost?.(event);
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

function input(bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47).buffer): ImageWatermarkInput {
  return {
    name: "photo.png",
    mimeHint: "image/png",
    byteLength: bytes.byteLength,
    bytes,
  };
}

function workerFileInput(
  file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "photo.png", {
    type: "image/png",
  }),
) {
  return { name: file.name, mimeHint: file.type, byteLength: file.size, file };
}

function runRequest(
  jobId = "job-1",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: 1,
    type: "run",
    jobId,
    tool: "image.watermark",
    toolVersion: 1,
    input: workerFileInput(),
    spec: textSpec,
    ...overrides,
  };
}

function configureRequest(
  assetId = "asset-1",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: 1,
    type: "configure-logo",
    assetId,
    tool: "image.watermark",
    toolVersion: 1,
    input: workerFileInput(),
    ...overrides,
  };
}

function result(bytes = Uint8Array.of(1, 2, 3).buffer): ImageWatermarkResult {
  return {
    bytes,
    suggestedName: "photo-watermarked-hereisit.png",
    mime: "image/png",
    width: 1,
    height: 1,
    sourceByteLength: 4,
    byteLength: bytes.byteLength,
    format: "png",
    warnings: ["COLOR_PROFILE_NORMALIZED"],
    timing: { inspectMs: 1, decodeMs: 2, compositeMs: 3, encodeMs: 4, totalMs: 10 },
  };
}

function preparedLogo(label: string): PreparedImageWatermarkLogo {
  return {
    bitmap: { label } as unknown as ImageBitmap,
    width: 20,
    height: 10,
  };
}

function eventType(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  return Reflect.get(event, "type");
}

function readyPosts(scope: StubWorkerScope): ScopePost[] {
  return scope.posts.filter(({ event }) => eventType(event) === "ready");
}

function terminalPosts(scope: StubWorkerScope, jobId: string): ScopePost[] {
  return scope.posts.filter(({ event }) => {
    if (typeof event !== "object" || event === null) return false;
    const type = Reflect.get(event, "type");
    return Reflect.get(event, "jobId") === jobId && (type === "complete" || type === "failed");
  });
}

function cancelledTerminalPost(jobId: string): ScopePost {
  return {
    event: {
      protocol: 1,
      type: "failed",
      jobId,
      error: {
        code: "CANCELLED",
        message: "이미지 워터마크 작업을 중단했어요.",
        retryable: false,
      },
    },
    transfer: [],
  };
}

function logoTerminalPosts(scope: StubWorkerScope, assetId: string): ScopePost[] {
  return scope.posts.filter(({ event }) => {
    if (typeof event !== "object" || event === null) return false;
    const type = Reflect.get(event, "type");
    return (
      Reflect.get(event, "assetId") === assetId && (type === "logo-ready" || type === "logo-failed")
    );
  });
}

async function loadWorker(
  options: { offscreenCanvas?: unknown; scope?: StubWorkerScope } = {},
): Promise<StubWorkerScope> {
  const scope = options.scope ?? new StubWorkerScope();
  vi.stubGlobal("self", scope);
  vi.stubGlobal(
    "OffscreenCanvas",
    Object.hasOwn(options, "offscreenCanvas") ? options.offscreenCanvas : WorkerProbeCanvas,
  );
  await import("./image-watermark.worker");
  return scope;
}

async function flushWorker(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  pipelineMocks.closeLogo.mockReset();
  pipelineMocks.prepareLogo.mockReset();
  pipelineMocks.process.mockReset();
  pipelineMocks.toErrorPayload.mockReset();
  pipelineMocks.toErrorPayload.mockImplementation((error: unknown) => {
    if (error instanceof pipelineMocks.PipelineError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      code: "WORKER_CRASH",
      message: "이미지 워터마크 작업을 완료하지 못했어요.",
      retryable: true,
    } satisfies ImageWatermarkErrorPayload;
  });
  WorkerProbeCanvas.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image-watermark Worker readiness", () => {
  it("advertises capabilities once after a real 1x1 canvas probe and releases the probe", async () => {
    const scope = await loadWorker();

    expect(readyPosts(scope)).toEqual([
      {
        event: {
          protocol: 1,
          type: "ready",
          capabilities: {
            decode: ["image/jpeg", "image/png", "image/webp"],
            encode: ["image/jpeg", "image/png", "image/webp"],
            offscreenCanvas: true,
          },
        },
        transfer: [],
      },
    ]);
    expect(WorkerProbeCanvas.instances).toHaveLength(1);
    expect(WorkerProbeCanvas.instances[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    {
      name: "missing primitive",
      canvas: undefined,
    },
    {
      name: "null 2D context",
      canvas: class extends WorkerProbeCanvas {
        override getContext(): null {
          return null;
        }
      },
    },
    {
      name: "missing encoder",
      canvas: class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext(): object {
          return {};
        }
      },
    },
    {
      name: "thrown probe",
      canvas: class {
        constructor() {
          throw new Error("PRIVATE_PROBE_FAILURE");
        }
      },
    },
  ])("advertises OffscreenCanvas unavailable without throwing for $name", async ({ canvas }) => {
    const scope = await loadWorker({ offscreenCanvas: canvas });

    expect(readyPosts(scope)).toHaveLength(1);
    expect(readyPosts(scope)[0]?.event).toMatchObject({
      protocol: 1,
      type: "ready",
      capabilities: { offscreenCanvas: false },
    });
    expect(pipelineMocks.process).not.toHaveBeenCalled();
    expect(pipelineMocks.prepareLogo).not.toHaveBeenCalled();
  });
});

describe("image-watermark Worker hostile request boundary", () => {
  it.each([
    [null, 1],
    [{}, 1],
    [{ protocol: 2, type: "run", jobId: "job-1" }, 1],
    [{ protocol: 1, type: "run", jobId: "" }, 1],
    [runRequest("bad-input", { input: null }), 2],
    [
      runRequest("bad-length", {
        input: {
          name: "photo.png",
          mimeHint: "image/png",
          byteLength: 1,
          bytes: new ArrayBuffer(2),
        },
      }),
      2,
    ],
    [{ protocol: 1, type: "cancel", jobId: "stale-job" }, 1],
  ])("contains malformed or stale request %# without invoking a pipeline helper", async (request, posts) => {
    const scope = await loadWorker();

    scope.dispatch(request);
    await flushWorker();

    expect(scope.posts).toHaveLength(posts);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
    expect(pipelineMocks.prepareLogo).not.toHaveBeenCalled();
  });

  it("contains hostile prototypes and throwing getters without escaping the message handler", async () => {
    const hostilePrototype = Object.assign(Object.create({ inherited: true }), runRequest());
    const hostileGetter = runRequest();
    Object.defineProperty(hostileGetter, "protocol", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_GETTER_FAILURE");
      },
    });
    const scope = await loadWorker();

    expect(() => scope.dispatch(hostilePrototype)).not.toThrow();
    expect(() => scope.dispatch(hostileGetter)).not.toThrow();
    await flushWorker();

    expect(scope.posts).toHaveLength(1);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized logo configuration envelopes for valid assets", async () => {
    const oversized = new ArrayBuffer(10 * MEBIBYTE + 1);
    const scope = await loadWorker();

    scope.dispatch(configureRequest("", {}));
    scope.dispatch(configureRequest("asset-null", { input: null }));
    scope.dispatch(
      configureRequest("asset-mismatch", {
        input: { ...input(), byteLength: 1, bytes: new ArrayBuffer(2) },
      }),
    );
    scope.dispatch(configureRequest("asset-large", { input: input(oversized) }));
    await flushWorker();

    expect(scope.posts).toHaveLength(4);
    expect(logoTerminalPosts(scope, "asset-null")).toHaveLength(1);
    expect(logoTerminalPosts(scope, "asset-mismatch")).toHaveLength(1);
    expect(logoTerminalPosts(scope, "asset-large")).toHaveLength(1);
    expect(pipelineMocks.prepareLogo).not.toHaveBeenCalled();
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it.each([
    runRequest("wrong-tool", { tool: "image.pipeline" }),
    runRequest("wrong-version", { toolVersion: 2 }),
    runRequest("wrong-spec", { spec: { ...textSpec, version: 2 } }),
  ])("settles a semantic run mismatch once as a non-retryable failure", async (request) => {
    const scope = await loadWorker();
    const jobId = request.jobId as string;

    scope.dispatch(request);
    await flushWorker();

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
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("settles a semantic logo configuration mismatch once without preparing it", async () => {
    const scope = await loadWorker();

    scope.dispatch(configureRequest("asset-1", { toolVersion: 2 }));
    await flushWorker();

    expect(logoTerminalPosts(scope, "asset-1")).toEqual([
      {
        event: {
          protocol: 1,
          type: "logo-failed",
          assetId: "asset-1",
          error: expect.objectContaining({ code: "INVALID_SPEC", retryable: false }),
        },
        transfer: [],
      },
    ]);
    expect(pipelineMocks.prepareLogo).not.toHaveBeenCalled();
  });

  it("reads and prepares a logo File inside the Worker", async () => {
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "logo.png", { type: "image/png" });
    const read = vi.spyOn(file, "arrayBuffer");
    pipelineMocks.prepareLogo.mockResolvedValue(preparedLogo("logo"));
    const scope = await loadWorker();

    scope.dispatch(configureRequest("asset-file", { input: workerFileInput(file) }));
    await vi.waitFor(() => expect(pipelineMocks.prepareLogo).toHaveBeenCalledOnce());

    expect(read).toHaveBeenCalledOnce();
    expect(new Uint8Array(pipelineMocks.prepareLogo.mock.calls[0]?.[0].bytes)).toEqual(
      Uint8Array.of(1, 2, 3, 4),
    );
    expect(logoTerminalPosts(scope, "asset-file")).toMatchObject([
      { event: { type: "logo-ready" } },
    ]);
  });

  it.each([
    [
      "rejected read",
      () => Promise.reject(new DOMException("read failed", "NotReadableError")),
      true,
    ],
    ["changed length", () => Promise.resolve(new ArrayBuffer(5)), false],
  ])("rejects a logo %s without caching it", async (_label, makeReadResult, retryable) => {
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "logo.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockImplementation(makeReadResult);
    const scope = await loadWorker();

    scope.dispatch(configureRequest("asset-bad", { input: workerFileInput(file) }));
    await vi.waitFor(() => expect(logoTerminalPosts(scope, "asset-bad")).toHaveLength(1));

    expect(logoTerminalPosts(scope, "asset-bad")).toMatchObject([
      { event: { type: "logo-failed", error: { code: "CORRUPT_INPUT", retryable } } },
    ]);
    expect(pipelineMocks.prepareLogo).not.toHaveBeenCalled();
  });

  it("ignores a duplicate active run and rejects a different concurrent run once", async () => {
    const pending = deferred<ImageWatermarkResult>();
    pipelineMocks.process.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    scope.dispatch(runRequest("job-1"));
    scope.dispatch(runRequest("job-2"));
    await flushWorker();

    expect(pipelineMocks.process).toHaveBeenCalledOnce();
    expect(terminalPosts(scope, "job-1")).toHaveLength(0);
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

    pending.resolve(result());
    await flushWorker();
    expect(terminalPosts(scope, "job-1")).toHaveLength(1);
  });

  it("rejects logo-mode runs without the exact configured asset", async () => {
    const logo = preparedLogo("asset-1");
    pipelineMocks.prepareLogo.mockResolvedValueOnce(logo);
    const scope = await loadWorker();
    scope.dispatch(configureRequest("asset-1"));
    await flushWorker();

    scope.dispatch(runRequest("missing-logo", { spec: logoSpec }));
    scope.dispatch(runRequest("wrong-logo", { spec: logoSpec, logoAssetId: "asset-2" }));
    await flushWorker();

    for (const jobId of ["missing-logo", "wrong-logo"]) {
      expect(terminalPosts(scope, jobId)).toEqual([
        {
          event: {
            protocol: 1,
            type: "failed",
            jobId,
            error: expect.objectContaining({ code: "LOGO_REQUIRED", retryable: false }),
          },
          transfer: [],
        },
      ]);
    }
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });
});

describe("image-watermark Worker logo cache", () => {
  it("prepares one logo and reuses the same prepared object for sequential jobs", async () => {
    const logo = preparedLogo("asset-1");
    pipelineMocks.prepareLogo.mockResolvedValueOnce(logo);
    pipelineMocks.process.mockResolvedValue(result());
    const scope = await loadWorker();
    const configuration = configureRequest("asset-1");

    scope.dispatch(configuration);
    await flushWorker();

    expect(pipelineMocks.prepareLogo).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "photo.png",
        mimeHint: "image/png",
        byteLength: 4,
        bytes: expect.any(ArrayBuffer),
      }),
      expect.any(AbortSignal),
    );
    expect(logoTerminalPosts(scope, "asset-1")).toEqual([
      {
        event: { protocol: 1, type: "logo-ready", assetId: "asset-1" },
        transfer: [],
      },
    ]);

    scope.dispatch(runRequest("job-1", { spec: logoSpec, logoAssetId: "asset-1" }));
    await flushWorker();
    scope.dispatch(runRequest("job-2", { spec: logoSpec, logoAssetId: "asset-1" }));
    await flushWorker();

    expect(pipelineMocks.process).toHaveBeenCalledTimes(2);
    expect(pipelineMocks.process.mock.calls[0]?.[2]).toBe(logo);
    expect(pipelineMocks.process.mock.calls[1]?.[2]).toBe(logo);
    expect(pipelineMocks.closeLogo).not.toHaveBeenCalled();
  });

  it("closes a replaced logo exactly once before readiness and removes stale cache on failure", async () => {
    const firstLogo = preparedLogo("asset-1");
    const secondLogo = preparedLogo("asset-2");
    const replacementFailure = new Error("PRIVATE_LOGO_FAILURE");
    pipelineMocks.prepareLogo
      .mockResolvedValueOnce(firstLogo)
      .mockResolvedValueOnce(secondLogo)
      .mockRejectedValueOnce(replacementFailure);
    const scope = await loadWorker();
    const replacementOrder: string[] = [];

    scope.dispatch(configureRequest("asset-1"));
    await flushWorker();
    pipelineMocks.closeLogo.mockImplementationOnce(() => {
      replacementOrder.push("closed");
    });
    scope.onPost = (event) => {
      if (
        typeof event === "object" &&
        event !== null &&
        Reflect.get(event, "type") === "logo-ready" &&
        Reflect.get(event, "assetId") === "asset-2"
      ) {
        replacementOrder.push("ready");
      }
    };
    scope.dispatch(configureRequest("asset-2"));
    await flushWorker();

    expect(pipelineMocks.closeLogo).toHaveBeenCalledExactlyOnceWith(firstLogo);
    expect(logoTerminalPosts(scope, "asset-2")).toEqual([
      {
        event: { protocol: 1, type: "logo-ready", assetId: "asset-2" },
        transfer: [],
      },
    ]);
    expect(replacementOrder).toEqual(["closed", "ready"]);

    scope.dispatch(configureRequest("asset-3"));
    await flushWorker();

    expect(pipelineMocks.closeLogo).toHaveBeenCalledTimes(2);
    expect(pipelineMocks.closeLogo).toHaveBeenLastCalledWith(secondLogo);
    expect(pipelineMocks.toErrorPayload).toHaveBeenCalledWith(replacementFailure);
    expect(logoTerminalPosts(scope, "asset-3")).toHaveLength(1);

    scope.dispatch(runRequest("stale-logo", { spec: logoSpec, logoAssetId: "asset-2" }));
    await flushWorker();
    expect(terminalPosts(scope, "stale-logo")[0]?.event).toMatchObject({
      type: "failed",
      error: { code: "LOGO_REQUIRED", retryable: false },
    });
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("does not replace or close the cached logo while a job is active", async () => {
    const logo = preparedLogo("asset-1");
    const pending = deferred<ImageWatermarkResult>();
    pipelineMocks.prepareLogo.mockResolvedValueOnce(logo);
    pipelineMocks.process.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    scope.dispatch(configureRequest("asset-1"));
    await flushWorker();
    scope.dispatch(runRequest("job-1", { spec: logoSpec, logoAssetId: "asset-1" }));

    scope.dispatch(configureRequest("asset-2"));
    await flushWorker();

    expect(pipelineMocks.prepareLogo).toHaveBeenCalledOnce();
    expect(pipelineMocks.closeLogo).not.toHaveBeenCalled();
    expect(logoTerminalPosts(scope, "asset-2")[0]?.event).toMatchObject({
      type: "logo-failed",
      error: { code: "INVALID_SPEC", retryable: false },
    });

    pending.resolve(result());
    await flushWorker();
  });

  it("never exposes the cached logo to a text job", async () => {
    const logo = preparedLogo("asset-1");
    pipelineMocks.prepareLogo.mockResolvedValueOnce(logo);
    pipelineMocks.process.mockResolvedValueOnce(result());
    const scope = await loadWorker();
    scope.dispatch(configureRequest("asset-1"));
    await flushWorker();

    scope.dispatch(runRequest("text-job", { logoAssetId: "asset-1" }));
    await flushWorker();

    expect(pipelineMocks.process.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("image-watermark Worker terminal lifecycle", () => {
  it("reads a source File inside the Worker before pipeline handoff", async () => {
    const file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "photo.png", {
      type: "image/png",
    });
    const read = vi.spyOn(file, "arrayBuffer");
    pipelineMocks.process.mockResolvedValue(result());
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-file", { input: workerFileInput(file) }));
    await vi.waitFor(() => expect(pipelineMocks.process).toHaveBeenCalledOnce());

    expect(read).toHaveBeenCalledOnce();
    expect(pipelineMocks.process.mock.calls[0]?.[0]).toMatchObject({
      name: "photo.png",
      mimeHint: "image/png",
      byteLength: 4,
    });
    expect(new Uint8Array(pipelineMocks.process.mock.calls[0]?.[0].bytes)).toEqual(
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
    );
  });

  it.each([
    ["name", { name: "other.png" }],
    ["MIME", { mimeHint: "image/jpeg" }],
    ["size", { byteLength: 5 }],
  ])("rejects mismatched source %s metadata", async (_label, override) => {
    const scope = await loadWorker();
    scope.dispatch(
      runRequest("job-mismatch", {
        input: { ...workerFileInput(), ...override },
      }),
    );
    await flushWorker();
    expect(terminalPosts(scope, "job-mismatch")).toMatchObject([
      { event: { type: "failed", error: { code: "INVALID_SPEC" } } },
    ]);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects an exact-shaped source envelope with a non-native File", async () => {
    const scope = await loadWorker();

    scope.dispatch(
      runRequest("job-non-native-file", {
        input: {
          name: "photo.png",
          mimeHint: "image/png",
          byteLength: 4,
          file: {
            name: "photo.png",
            type: "image/png",
            size: 4,
            arrayBuffer: vi.fn(),
          },
        },
      }),
    );
    await flushWorker();

    expect(terminalPosts(scope, "job-non-native-file")).toMatchObject([
      { event: { type: "failed", error: { code: "INVALID_SPEC" } } },
    ]);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("maps a rejected source read to a retryable corrupt-input error", async () => {
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(
      new DOMException("read failed", "NotReadableError"),
    );
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-unreadable", { input: workerFileInput(file) }));
    await vi.waitFor(() => expect(terminalPosts(scope, "job-unreadable")).toHaveLength(1));

    expect(terminalPosts(scope, "job-unreadable")).toMatchObject([
      { event: { type: "failed", error: { code: "CORRUPT_INPUT", retryable: true } } },
    ]);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects a source read whose returned length changed", async () => {
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(new ArrayBuffer(5));
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-wrong-length", { input: workerFileInput(file) }));
    await vi.waitFor(() => expect(terminalPosts(scope, "job-wrong-length")).toHaveLength(1));

    expect(terminalPosts(scope, "job-wrong-length")).toMatchObject([
      { event: { type: "failed", error: { code: "CORRUPT_INPUT", retryable: false } } },
    ]);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("rejects a non-ordinary source read buffer", async () => {
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
    const bytes = new ArrayBuffer(4);
    Object.setPrototypeOf(bytes, null);
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(bytes);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-non-ordinary", { input: workerFileInput(file) }));
    await vi.waitFor(() => expect(terminalPosts(scope, "job-non-ordinary")).toHaveLength(1));

    expect(terminalPosts(scope, "job-non-ordinary")).toMatchObject([
      { event: { type: "failed", error: { code: "CORRUPT_INPUT", retryable: false } } },
    ]);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("settles cancellation once while a source File read is pending", async () => {
    const pending = deferred<ArrayBuffer>();
    const file = new File([Uint8Array.of(1, 2, 3, 4)], "photo.png", { type: "image/png" });
    vi.spyOn(file, "arrayBuffer").mockReturnValue(pending.promise);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-reading", { input: workerFileInput(file) }));
    await flushWorker();
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-reading" });
    pending.resolve(Uint8Array.of(1, 2, 3, 4).buffer);
    await flushWorker();

    expect(terminalPosts(scope, "job-reading")).toEqual([cancelledTerminalPost("job-reading")]);
    expect(pipelineMocks.process).not.toHaveBeenCalled();
  });

  it("passes validated data, reports monotonic progress, and transfers the final buffer once", async () => {
    const output = result();
    pipelineMocks.process.mockImplementation(
      async (_input: unknown, _spec: unknown, _logo: unknown, report: PipelineCall["report"]) => {
        report("validating", 0.02);
        report("decoding", 0.4);
        report("finalizing", 1);
        return output;
      },
    );
    const scope = await loadWorker();
    const request = runRequest("job-1");

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.process).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "photo.png",
        mimeHint: "image/png",
        byteLength: 4,
        bytes: expect.any(ArrayBuffer),
      }),
      textSpec,
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(scope.posts.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: "ready" }),
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 0,
        phase: "validating",
        fraction: 0.01,
      },
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 1,
        phase: "validating",
        fraction: 0.02,
      },
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 2,
        phase: "decoding",
        fraction: 0.4,
      },
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 3,
        phase: "finalizing",
        fraction: 1,
      },
      { protocol: 1, type: "complete", jobId: "job-1", result: output },
    ]);
    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: { protocol: 1, type: "complete", jobId: "job-1", result: output },
        transfer: [output.bytes],
      },
    ]);
  });

  it("maps a thrown pipeline error to one bounded terminal failure", async () => {
    const rawError = new Error("PRIVATE_PIPELINE_FAILURE");
    const payload: ImageWatermarkErrorPayload = {
      code: "DECODE_FAILED",
      message: "이미지를 읽지 못했습니다.",
      retryable: false,
    };
    pipelineMocks.process.mockRejectedValueOnce(rawError);
    pipelineMocks.toErrorPayload.mockReturnValueOnce(payload);
    const scope = await loadWorker();

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(pipelineMocks.toErrorPayload).toHaveBeenCalledExactlyOnceWith(rawError);
    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: { protocol: 1, type: "failed", jobId: "job-1", error: payload },
        transfer: [],
      },
    ]);
  });

  it("turns a result transfer failure into one failure and releases the active slot", async () => {
    pipelineMocks.process.mockResolvedValue(result());
    const scope = new StubWorkerScope();
    scope.failPost = (event) => eventType(event) === "complete";
    await loadWorker({ scope });

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "job-1",
          error: expect.objectContaining({ code: "WORKER_CRASH" }),
        },
        transfer: [],
      },
    ]);

    scope.failPost = undefined;
    scope.dispatch(runRequest("job-2"));
    await flushWorker();
    expect(terminalPosts(scope, "job-2")).toHaveLength(1);
  });

  it("aborts only the active matching job, settles cancellation once, and suppresses late work", async () => {
    const pending = deferred<ImageWatermarkResult>();
    pipelineMocks.process.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    scope.dispatch(runRequest("job-1"));
    await vi.waitFor(() => expect(pipelineMocks.process).toHaveBeenCalledOnce());
    const report = pipelineMocks.process.mock.calls[0]?.[3] as PipelineCall["report"];
    const signal = pipelineMocks.process.mock.calls[0]?.[4] as AbortSignal;

    scope.dispatch({ protocol: 1, type: "cancel", jobId: "stale-job" });
    expect(signal.aborted).toBe(false);
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    expect(signal.aborted).toBe(true);
    expect(terminalPosts(scope, "job-1")).toEqual([cancelledTerminalPost("job-1")]);
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    expect(terminalPosts(scope, "job-1")).toEqual([cancelledTerminalPost("job-1")]);

    report("finalizing", 1);
    pending.resolve(result());
    await flushWorker();

    expect(terminalPosts(scope, "job-1")).toEqual([cancelledTerminalPost("job-1")]);
    expect(scope.posts.filter(({ event }) => eventType(event) === "progress")).toHaveLength(1);
  });

  it("retains the active slot after cancellation until the aborted pipeline settles", async () => {
    const pending = deferred<ImageWatermarkResult>();
    pipelineMocks.process.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    scope.dispatch(runRequest("job-1"));
    await vi.waitFor(() => expect(pipelineMocks.process).toHaveBeenCalledOnce());

    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    expect(terminalPosts(scope, "job-1")).toEqual([cancelledTerminalPost("job-1")]);
    scope.dispatch(runRequest("job-2"));

    expect(pipelineMocks.process).toHaveBeenCalledOnce();
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

    pending.resolve(result());
    await flushWorker();
    expect(terminalPosts(scope, "job-1")).toEqual([cancelledTerminalPost("job-1")]);
  });

  it("suppresses a late rejection after cancellation without a second terminal", async () => {
    const pending = deferred<ImageWatermarkResult>();
    pipelineMocks.process.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    scope.dispatch(runRequest("job-1"));
    await vi.waitFor(() => expect(pipelineMocks.process).toHaveBeenCalledOnce());

    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    pending.reject(new Error("PRIVATE_LATE_FAILURE"));
    await flushWorker();

    expect(terminalPosts(scope, "job-1")).toEqual([cancelledTerminalPost("job-1")]);
    expect(pipelineMocks.toErrorPayload).not.toHaveBeenCalled();
  });

  it("keeps stale callbacks from adding progress or a second terminal event", async () => {
    const output = result();
    let staleReport: PipelineCall["report"] = () => undefined;
    pipelineMocks.process.mockImplementationOnce(
      async (_input: unknown, _spec: unknown, _logo: unknown, report: PipelineCall["report"]) => {
        staleReport = report;
        return output;
      },
    );
    const scope = await loadWorker();
    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    staleReport("finalizing", 1);
    await flushWorker();

    expect(terminalPosts(scope, "job-1")).toHaveLength(1);
    expect(scope.posts.filter(({ event }) => eventType(event) === "progress")).toHaveLength(1);
  });
});
