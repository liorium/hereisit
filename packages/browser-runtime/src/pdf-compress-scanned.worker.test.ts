import type {
  PdfCompressScannedErrorPayload,
  PdfCompressScannedProgress,
  PdfCompressScannedResult,
  PdfCompressScannedRunRequest,
  PdfCompressScannedSpecV1,
} from "@hereisit/tool-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMocks = vi.hoisted(() => ({
  run: vi.fn(),
  toErrorPayload: vi.fn(),
}));

const rasterMocks = vi.hoisted(() => ({
  probe: vi.fn(),
}));

const assemblyMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("./pdf-compress-scanned-pipeline", () => ({
  runPdfCompressScannedPipeline: pipelineMocks.run,
  toPdfCompressScannedErrorPayload: pipelineMocks.toErrorPayload,
}));

const balancedSpec: PdfCompressScannedSpecV1 = { version: 1, preset: "balanced" };
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
let maximumInputBuffer: ArrayBuffer | undefined;

interface WorkerPipelineOptions {
  onProgress?: (progress: PdfCompressScannedProgress) => void;
  signal?: AbortSignal;
}

interface ScopePost {
  event: unknown;
  transfer: readonly Transferable[];
}

class StubWorkerScope {
  readonly location = { origin: "https://example.test" };
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

  async convertToBlob(options?: ImageEncodeOptions): Promise<Blob> {
    if (options?.type !== "image/jpeg") throw new Error("Expected an explicit JPEG probe.");
    return new Blob([Uint8Array.of(0xff, 0xd8, 0xff)], { type: "image/jpeg" });
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

function maximumSizedInput(): ArrayBuffer {
  maximumInputBuffer ??= new ArrayBuffer(MAX_INPUT_BYTES);
  return maximumInputBuffer;
}

function installChangingGetter<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  first: unknown,
  second: unknown,
): ReturnType<typeof vi.fn> {
  const getter = vi.fn<() => unknown>();
  getter.mockReturnValueOnce(first).mockReturnValue(second);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get: getter,
  });
  return getter;
}

function objectWithCustomPrototype<T extends object>(value: T): T {
  return Object.assign(Object.create({ inheritedBoundaryField: "blocked" }), value) as T;
}

function pdfBytes(): ArrayBuffer {
  return new TextEncoder().encode("%PDF-1.4\n%%EOF").buffer;
}

function result(bytes = pdfBytes()): PdfCompressScannedResult {
  return {
    bytes,
    suggestedName: "report-compressed-hereisit.pdf",
    mime: "application/pdf",
    sourceByteLength: 100,
    byteLength: bytes.byteLength,
    pageCount: 1,
    preset: "balanced",
    dpi: 150,
    quality: 72,
    warnings: [
      "PDF_PAGES_RASTERIZED",
      "SEARCHABLE_CONTENT_REMOVED",
      "INTERACTIVE_CONTENT_REMOVED",
      "SIGNATURES_INVALIDATED",
      "COLOR_PROFILE_NORMALIZED",
    ],
    timing: {
      loadMs: 1,
      renderMs: 2,
      encodeMs: 3,
      assembleMs: 4,
      serializeMs: 5,
      totalMs: 15,
    },
  };
}

function runRequest(jobId = "job-1", overrides: Record<string, unknown> = {}): unknown {
  const bytes = pdfBytes();
  return {
    protocol: 1,
    type: "run",
    jobId,
    tool: "pdf.compress-scanned",
    toolVersion: 1,
    input: {
      name: "report.pdf",
      mimeHint: "application/pdf",
      byteLength: bytes.byteLength,
      bytes,
    },
    spec: balancedSpec,
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

function readyPosts(scope: StubWorkerScope): ScopePost[] {
  return scope.posts.filter(
    ({ event }) =>
      typeof event === "object" && event !== null && "type" in event && event.type === "ready",
  );
}

function installDefaultModuleMocks(): void {
  vi.doMock("./pdf-raster-runtime", () => ({
    probePdfRasterParserWorker: rasterMocks.probe,
  }));
  vi.doMock("@cantoo/pdf-lib", () => ({
    PDFDocument: { create: assemblyMocks.create },
  }));
}

async function loadWorker(
  options: { offscreenCanvas?: unknown; useRealRasterProbe?: boolean } = {},
): Promise<StubWorkerScope> {
  if (!options.useRealRasterProbe) installDefaultModuleMocks();
  const scope = new StubWorkerScope();
  vi.stubGlobal("self", scope);
  vi.stubGlobal(
    "OffscreenCanvas",
    Object.hasOwn(options, "offscreenCanvas") ? options.offscreenCanvas : WorkerProbeCanvas,
  );
  await import("./pdf-compress-scanned.worker");
  return scope;
}

async function flushWorker(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForReady(scope: StubWorkerScope): Promise<ScopePost> {
  await vi.waitFor(() => expect(readyPosts(scope)).toHaveLength(1));
  const ready = readyPosts(scope)[0];
  if (ready === undefined) throw new Error("Expected a readiness event.");
  return ready;
}

beforeEach(() => {
  vi.resetModules();
  pipelineMocks.run.mockReset();
  pipelineMocks.toErrorPayload.mockReset();
  pipelineMocks.toErrorPayload.mockReturnValue({
    code: "WORKER_CRASH",
    message: "스캔 PDF 압축 작업을 완료하지 못했어요.",
    retryable: true,
  } satisfies PdfCompressScannedErrorPayload);
  rasterMocks.probe.mockReset();
  rasterMocks.probe.mockResolvedValue(undefined);
  assemblyMocks.create.mockReset();
  assemblyMocks.create.mockResolvedValue({
    save: vi.fn(async () => new Uint8Array(pdfBytes())),
  });
  WorkerProbeCanvas.instances = [];
});

afterEach(() => {
  vi.doUnmock("./pdf-raster-runtime");
  vi.doUnmock("pdfjs-dist");
  vi.doUnmock("@cantoo/pdf-lib");
  vi.unstubAllGlobals();
});

describe("scanned-PDF compression Worker readiness", () => {
  it("installs its message handler first and stays pending until every asynchronous probe settles", async () => {
    const parser = deferred<void>();
    const assembly = deferred<{
      save: ReturnType<typeof vi.fn>;
    }>();
    rasterMocks.probe.mockReturnValueOnce(parser.promise);
    assemblyMocks.create.mockReturnValueOnce(assembly.promise);

    const scope = await loadWorker();

    expect(scope.onmessage).toEqual(expect.any(Function));
    expect(readyPosts(scope)).toHaveLength(0);
    expect(rasterMocks.probe).toHaveBeenCalledOnce();
    expect(assemblyMocks.create).toHaveBeenCalledOnce();

    parser.resolve();
    await flushWorker();
    expect(readyPosts(scope)).toHaveLength(0);

    const save = vi.fn(async () => new Uint8Array(pdfBytes()));
    assembly.resolve({ save });
    const ready = await waitForReady(scope);

    expect(ready).toEqual({
      event: {
        protocol: 1,
        type: "ready",
        capabilities: {
          offscreenCanvas: true,
          jpegEncoder: true,
          pdfjsWorker: true,
          pdfAssembly: true,
        },
        error: null,
      },
      transfer: [],
    });
    expect(save).toHaveBeenCalledOnce();
    expect(WorkerProbeCanvas.instances).toHaveLength(1);
    expect(WorkerProbeCanvas.instances[0]).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    {
      name: "missing OffscreenCanvas",
      canvas: undefined,
      capabilities: { offscreenCanvas: false, jpegEncoder: false },
    },
    {
      name: "missing 2D context",
      canvas: class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext(): null {
          return null;
        }
        async convertToBlob(): Promise<Blob> {
          return new Blob([Uint8Array.of(1)], { type: "image/jpeg" });
        }
      },
      capabilities: { offscreenCanvas: false, jpegEncoder: false },
    },
    {
      name: "wrong JPEG MIME",
      canvas: class extends WorkerProbeCanvas {
        override async convertToBlob(): Promise<Blob> {
          return new Blob([Uint8Array.of(1)], { type: "image/png" });
        }
      },
      capabilities: { offscreenCanvas: true, jpegEncoder: false },
    },
  ])("reports a non-retryable unsupported readiness for $name", async ({
    canvas,
    capabilities,
  }) => {
    const scope = await loadWorker({ offscreenCanvas: canvas });
    const ready = await waitForReady(scope);
    expect(ready.event).toMatchObject({
      protocol: 1,
      type: "ready",
      capabilities: {
        ...capabilities,
        pdfjsWorker: true,
        pdfAssembly: true,
      },
      error: { code: "UNSUPPORTED_BROWSER", retryable: false },
    });
    expect(rasterMocks.probe).toHaveBeenCalledOnce();
    expect(assemblyMocks.create).toHaveBeenCalledOnce();
  });

  it.each([
    ["parser", "pdfjsWorker", rasterMocks.probe],
    ["assembly", "pdfAssembly", assemblyMocks.create],
  ] as const)("maps a %s probe failure to retryable Worker readiness", async (_name, capability, probe) => {
    probe.mockRejectedValueOnce(new Error("PRIVATE_PROBE_DETAIL"));
    const scope = await loadWorker();
    const ready = await waitForReady(scope);

    expect(ready.event).toMatchObject({
      protocol: 1,
      type: "ready",
      capabilities: { [capability]: false },
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(JSON.stringify(ready.event)).not.toContain("PRIVATE_PROBE_DETAIL");
  });

  it.each([
    "error",
    "messageerror",
  ])("does not declare readiness when the nested parser emits %s after PDFWorker.promise resolves", async (eventType) => {
    const addedListeners = new Map<string, Set<(event: Event) => void>>();
    class FakeParserWorker {
      static instances: FakeParserWorker[] = [];
      readonly terminate = vi.fn();

      constructor() {
        FakeParserWorker.instances.push(this);
      }

      addEventListener(type: string, listener: unknown): void {
        const listeners = addedListeners.get(type) ?? new Set<(event: Event) => void>();
        listeners.add(listener as (event: Event) => void);
        addedListeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: unknown): void {
        addedListeners.get(type)?.delete(listener as (event: Event) => void);
      }

      emit(type: string): void {
        const event = { preventDefault: vi.fn() } as unknown as Event;
        for (const listener of addedListeners.get(type) ?? []) listener(event);
      }
    }
    class FakePDFWorker {
      static instances: FakePDFWorker[] = [];
      readonly destroy = vi.fn();
      readonly promise = Promise.resolve();

      constructor(readonly options: { port: FakeParserWorker }) {
        FakePDFWorker.instances.push(this);
      }
    }
    class FakePdfException extends Error {}
    const loadingTask = {
      promise: new Promise<never>(() => undefined),
      destroy: vi.fn(async () => undefined),
    };
    const getDocument = vi.fn(() => loadingTask);
    vi.doUnmock("./pdf-raster-runtime");
    vi.doMock("pdfjs-dist", () => ({
      AbortException: FakePdfException,
      getDocument,
      InvalidPDFException: FakePdfException,
      PasswordException: FakePdfException,
      PDFWorker: FakePDFWorker,
      RenderingCancelledException: FakePdfException,
      ResponseException: FakePdfException,
      VerbosityLevel: { ERRORS: 0 },
      version: "6.2.108",
    }));
    vi.stubGlobal("Worker", FakeParserWorker);
    vi.doMock("@cantoo/pdf-lib", () => ({
      PDFDocument: { create: assemblyMocks.create },
    }));

    const scope = await loadWorker({ useRealRasterProbe: true });
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalledOnce());
    await expect(FakePDFWorker.instances[0]?.promise).resolves.toBeUndefined();
    expect(readyPosts(scope)).toHaveLength(0);

    FakeParserWorker.instances[0]?.emit(eventType);
    const ready = await waitForReady(scope);

    expect(ready.event).toMatchObject({
      protocol: 1,
      type: "ready",
      capabilities: { pdfjsWorker: false },
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(FakePDFWorker.instances[0]?.destroy).toHaveBeenCalledOnce();
    expect(FakeParserWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
});

describe("scanned-PDF compression Worker readiness state", () => {
  it("rejects a valid hostile run while pending without retaining an active job", async () => {
    const parser = deferred<void>();
    rasterMocks.probe.mockReturnValueOnce(parser.promise);
    const scope = await loadWorker();

    scope.dispatch(runRequest("pending-job"));

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(terminalPosts(scope, "pending-job")).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "pending-job",
          error: expect.objectContaining({ code: "WORKER_CRASH", retryable: true }),
        },
        transfer: [],
      },
    ]);

    parser.resolve();
    await waitForReady(scope);
    pipelineMocks.run.mockResolvedValueOnce(result());
    scope.dispatch(runRequest("ready-job"));
    await flushWorker();
    expect(pipelineMocks.run).toHaveBeenCalledOnce();
    expect(terminalPosts(scope, "ready-job")).toHaveLength(1);
  });

  it("rejects a valid hostile run after failed readiness without retaining an active job", async () => {
    rasterMocks.probe.mockRejectedValueOnce(new Error("parser unavailable"));
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(runRequest("failed-job"));
    scope.dispatch(runRequest("failed-job-2"));
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    for (const jobId of ["failed-job", "failed-job-2"]) {
      expect(terminalPosts(scope, jobId)).toEqual([
        {
          event: {
            protocol: 1,
            type: "failed",
            jobId,
            error: expect.objectContaining({ code: "WORKER_CRASH", retryable: true }),
          },
          transfer: [],
        },
      ]);
    }
  });
});

describe("scanned-PDF compression Worker request boundary", () => {
  it("accepts an otherwise-valid input at the exact 50 MiB boundary", async () => {
    const bytes = maximumSizedInput();
    new Uint8Array(bytes, 0, 5).set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    pipelineMocks.run.mockResolvedValueOnce(result());
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(
      runRequest("j".repeat(128), {
        input: {
          name: `${"n".repeat(508)}.pdf`,
          mimeHint: "m".repeat(100),
          byteLength: MAX_INPUT_BYTES,
          bytes,
        },
      }),
    );
    await flushWorker();

    expect(pipelineMocks.run).toHaveBeenCalledOnce();
    const input = pipelineMocks.run.mock.calls[0]?.[0] as PdfCompressScannedRunRequest["input"];
    expect(input.byteLength).toBe(MAX_INPUT_BYTES);
    expect(input.bytes).toBe(bytes);
  });

  it.each([
    {
      name: "overlong job ID",
      makeRequest: () => runRequest("j".repeat(129)),
    },
    {
      name: "overlong input name",
      makeRequest: () => {
        const request = runRequest() as PdfCompressScannedRunRequest;
        return { ...request, input: { ...request.input, name: "n".repeat(513) } };
      },
    },
    {
      name: "overlong MIME hint",
      makeRequest: () => {
        const request = runRequest() as PdfCompressScannedRunRequest;
        return { ...request, input: { ...request.input, mimeHint: "m".repeat(101) } };
      },
    },
    {
      name: "declared input above 50 MiB",
      makeRequest: () => {
        const request = runRequest() as PdfCompressScannedRunRequest;
        return {
          ...request,
          input: {
            ...request.input,
            byteLength: MAX_INPUT_BYTES + 1,
            bytes: new ArrayBuffer(1),
          },
        };
      },
    },
    {
      name: "extra run key",
      makeRequest: () => ({ ...(runRequest() as object), extra: true }),
    },
    {
      name: "extra input key",
      makeRequest: () => {
        const request = runRequest() as PdfCompressScannedRunRequest;
        return { ...request, input: { ...request.input, extra: true } };
      },
    },
    {
      name: "run array with named properties",
      makeRequest: () => Object.assign([], runRequest()),
    },
    {
      name: "input array with named properties",
      makeRequest: () => {
        const request = runRequest() as PdfCompressScannedRunRequest;
        return { ...request, input: Object.assign([], request.input) };
      },
    },
    {
      name: "custom run prototype",
      makeRequest: () => objectWithCustomPrototype(runRequest() as object),
    },
    {
      name: "custom input prototype",
      makeRequest: () => {
        const request = runRequest() as PdfCompressScannedRunRequest;
        return { ...request, input: objectWithCustomPrototype(request.input) };
      },
    },
    {
      name: "symbol run key",
      makeRequest: () => {
        const request = runRequest() as Record<PropertyKey, unknown>;
        request[Symbol("extra")] = true;
        return request;
      },
    },
    {
      name: "non-enumerable run key",
      makeRequest: () => {
        const request = runRequest() as object;
        Object.defineProperty(request, "hiddenExtra", { value: true });
        return request;
      },
    },
  ])("rejects $name without running the pipeline", async ({ makeRequest }) => {
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(makeRequest());
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(scope.posts).toHaveLength(1);
  });

  it("captures every run and input field exactly once before starting", async () => {
    pipelineMocks.run.mockResolvedValueOnce(result());
    const request = runRequest() as unknown as Record<string, unknown>;
    const input = request.input as Record<string, unknown>;
    const topLevelGetters = [
      installChangingGetter(request, "protocol", 1, 2),
      installChangingGetter(request, "type", "run", "cancel"),
      installChangingGetter(request, "jobId", "captured-job", "other-job"),
      installChangingGetter(request, "tool", "pdf.compress-scanned", "pdf.merge"),
      installChangingGetter(request, "toolVersion", 1, 2),
      installChangingGetter(request, "input", input, null),
      installChangingGetter(request, "spec", balancedSpec, { version: 2 }),
    ];
    const originalBytes = input.bytes;
    const inputGetters = [
      installChangingGetter(input, "name", "report.pdf", "PRIVATE_NAME"),
      installChangingGetter(input, "mimeHint", "application/pdf", "PRIVATE_MIME"),
      installChangingGetter(input, "byteLength", (originalBytes as ArrayBuffer).byteLength, -1),
      installChangingGetter(input, "bytes", originalBytes, new ArrayBuffer(0)),
    ];
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).toHaveBeenCalledOnce();
    for (const getter of [...topLevelGetters, ...inputGetters]) {
      expect(getter).toHaveBeenCalledOnce();
    }
  });

  it("rejects a shadowed input ArrayBuffer without invoking its byte-length getter", async () => {
    pipelineMocks.run.mockResolvedValueOnce(result());
    const request = runRequest("intrinsic-length") as PdfCompressScannedRunRequest;
    const shadowGetter = vi.fn(() => 0);
    Object.defineProperty(request.input.bytes, "byteLength", {
      configurable: true,
      get: shadowGetter,
    });
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(shadowGetter).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "spec array with named properties",
      makeSpec: () => Object.assign([], balancedSpec),
    },
    {
      name: "custom spec prototype",
      makeSpec: () => objectWithCustomPrototype(balancedSpec),
    },
    {
      name: "symbol spec key",
      makeSpec: () => {
        const spec: Record<PropertyKey, unknown> = { ...balancedSpec };
        spec[Symbol("extra")] = true;
        return spec;
      },
    },
    {
      name: "non-enumerable spec key",
      makeSpec: () => {
        const spec = { ...balancedSpec };
        Object.defineProperty(spec, "hiddenExtra", { value: true });
        return spec;
      },
    },
  ])("rejects a $name through the strict spec boundary", async ({ makeSpec }) => {
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(runRequest("bad-spec-shape", { spec: makeSpec() }));
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(terminalPosts(scope, "bad-spec-shape")).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "bad-spec-shape",
          error: expect.objectContaining({ code: "INVALID_SPEC", retryable: false }),
        },
        transfer: [],
      },
    ]);
  });

  it.each([
    null,
    {},
    { protocol: 2, type: "run", jobId: "job-1" },
    { protocol: 1, type: "run", jobId: "" },
    runRequest("bad-input", { input: null }),
    runRequest("bad-length", {
      input: {
        name: "report.pdf",
        mimeHint: "application/pdf",
        byteLength: 1,
        bytes: new ArrayBuffer(2),
      },
    }),
  ])("ignores a malformed request without running the pipeline", async (request) => {
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(scope.posts).toHaveLength(1);
  });

  it.each([
    runRequest("wrong-tool", { tool: "pdf.merge" }),
    runRequest("wrong-version", { toolVersion: 2 }),
    runRequest("wrong-spec", { spec: { version: 1, preset: "lossless" } }),
  ])("rejects a tool, version, or strict-spec mismatch", async (request) => {
    const scope = await loadWorker();
    await waitForReady(scope);
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

  it("ignores a duplicate active run and rejects a different concurrent run", async () => {
    const pending = deferred<PdfCompressScannedResult>();
    pipelineMocks.run.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(runRequest("job-1"));
    scope.dispatch(runRequest("job-1"));
    scope.dispatch(runRequest("job-2"));

    expect(pipelineMocks.run).toHaveBeenCalledOnce();
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

  it.each([
    {
      name: "cancel array with named properties",
      makeCancel: () => Object.assign([], { protocol: 1, type: "cancel", jobId: "job-1" }),
    },
    {
      name: "custom cancel prototype",
      makeCancel: () => objectWithCustomPrototype({ protocol: 1, type: "cancel", jobId: "job-1" }),
    },
    {
      name: "extra cancel key",
      makeCancel: () => ({ protocol: 1, type: "cancel", jobId: "job-1", extra: true }),
    },
    {
      name: "symbol cancel key",
      makeCancel: () => {
        const cancel: Record<PropertyKey, unknown> = {
          protocol: 1,
          type: "cancel",
          jobId: "job-1",
        };
        cancel[Symbol("extra")] = true;
        return cancel;
      },
    },
  ])("does not let an invalid $name abort the active job", async ({ makeCancel }) => {
    const pending = deferred<PdfCompressScannedResult>();
    pipelineMocks.run.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    await waitForReady(scope);
    scope.dispatch(runRequest("job-1"));
    const options = pipelineMocks.run.mock.calls[0]?.[2] as WorkerPipelineOptions;

    scope.dispatch(makeCancel());

    expect(options.signal?.aborted).toBe(false);
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });
    expect(options.signal?.aborted).toBe(true);
    pending.resolve(result());
    await flushWorker();
    expect(terminalPosts(scope, "job-1")).toHaveLength(0);
  });
});

describe("scanned-PDF compression Worker execution", () => {
  it("passes validated data and an AbortSignal to the pipeline", async () => {
    const output = result();
    pipelineMocks.run.mockResolvedValueOnce(output);
    const scope = await loadWorker();
    await waitForReady(scope);
    const request = runRequest("job-1") as PdfCompressScannedRunRequest;

    scope.dispatch(request);
    await flushWorker();

    expect(pipelineMocks.run).toHaveBeenCalledExactlyOnceWith(
      request.input,
      balancedSpec,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
  });

  it("forwards progress with monotonically increasing sequence numbers from zero", async () => {
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
        options.onProgress?.({ phase: "finalizing", fraction: 1 });
        return output;
      },
    );
    const scope = await loadWorker();
    await waitForReady(scope);

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
      {
        protocol: 1,
        type: "progress",
        jobId: "job-1",
        sequence: 2,
        phase: "finalizing",
        fraction: 1,
      },
      expect.objectContaining({ type: "complete", jobId: "job-1" }),
    ]);
  });

  it("aborts only the matching job and emits no progress or terminal event after cancellation", async () => {
    const pending = deferred<PdfCompressScannedResult>();
    pipelineMocks.run.mockReturnValueOnce(pending.promise);
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(runRequest("job-1"));
    const options = pipelineMocks.run.mock.calls[0]?.[2] as WorkerPipelineOptions;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "other-job" });
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
  });

  it("maps raw failures to a bounded terminal payload", async () => {
    const rawError = Object.assign(new Error("PRIVATE_PARSER_DETAIL"), {
      source: "/Users/private/report.pdf",
    });
    pipelineMocks.run.mockRejectedValueOnce(rawError);
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(pipelineMocks.toErrorPayload).toHaveBeenCalledExactlyOnceWith(rawError);
    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "job-1",
          error: {
            code: "WORKER_CRASH",
            message: "스캔 PDF 압축 작업을 완료하지 못했어요.",
            retryable: true,
          },
        },
        transfer: [],
      },
    ]);
    expect(JSON.stringify(terminalPosts(scope, "job-1"))).not.toContain("PRIVATE_PARSER_DETAIL");
  });

  it("uses a fixed bounded fallback when the public error mapper throws", async () => {
    pipelineMocks.run.mockRejectedValueOnce(new Error("PRIVATE_PIPELINE_SENTINEL"));
    pipelineMocks.toErrorPayload.mockImplementationOnce(() => {
      throw new Error("PRIVATE_MAPPER_SENTINEL");
    });
    const scope = await loadWorker();
    await waitForReady(scope);

    scope.dispatch(runRequest("job-1"));
    await flushWorker();

    expect(terminalPosts(scope, "job-1")).toEqual([
      {
        event: {
          protocol: 1,
          type: "failed",
          jobId: "job-1",
          error: {
            code: "WORKER_CRASH",
            message: "스캔 PDF 압축 작업을 완료하지 못했어요.",
            retryable: true,
          },
        },
        transfer: [],
      },
    ]);
    expect(JSON.stringify(terminalPosts(scope, "job-1"))).not.toContain("PRIVATE_");
  });

  it("transfers only the completed result bytes", async () => {
    const bytes = pdfBytes();
    const output = result(bytes);
    pipelineMocks.run.mockResolvedValueOnce(output);
    const scope = await loadWorker();
    await waitForReady(scope);

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
