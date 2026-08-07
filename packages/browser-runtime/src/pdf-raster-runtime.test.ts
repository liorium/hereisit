import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectPdfRasterPage,
  openPdfRasterSession,
  type PdfRasterRendererAdapter,
  type PdfRasterRendererDocument,
  type PdfRasterRendererPage,
  probePdfRasterParserWorker,
  WorkerCanvasBudget,
  WorkerCanvasFactory,
  WorkerFilterFactory,
} from "./pdf-raster-runtime";

describe("inspectPdfRasterPage", () => {
  it("counts only visible text and separates image paints from destructive-risk paints", async () => {
    const page = {
      getTextContent: async () => ({ items: [{ str: "   " }, { str: "searchable" }, {}] }),
      getAnnotations: async () => [{}, {}],
      getOperatorList: async () => ({
        fnArray: [
          85, // paintImageXObject
          86, // paintInlineImageXObject
          91, // constructPath
          44, // showText
          74, // paintFormXObjectBegin
          62, // shadingFill
          10, // save
        ],
      }),
    } as unknown as PdfRasterRendererPage;

    await expect(inspectPdfRasterPage(page)).resolves.toEqual({
      nonWhitespaceTextItems: 1,
      annotationCount: 2,
      imagePaintOperations: 2,
      nonImagePaintOperations: 4,
    });
  });
});

async function settleBeforeNextTimer<T>(promise: Promise<T>) {
  return await Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    new Promise<{ status: "pending" }>((resolve) => {
      setTimeout(() => resolve({ status: "pending" }), 0);
    }),
  ]);
}

interface RasterFixtureCounters {
  pageCleanup: number;
  canvasDestroy: number;
  renderCancel: number;
  documentCleanup: number;
  loadingTaskDestroy: number;
  pdfWorkerDestroy: number;
  parserPortTerminate: number;
  parserFailureListenerRemove: number;
}

interface RasterFixtureOptions {
  block?: "load" | "getPage" | "render";
  cleanupFailures?: ReadonlySet<keyof RasterFixtureCounters>;
}

function createRasterAdapterFixture(options: RasterFixtureOptions = {}): {
  adapter: PdfRasterRendererAdapter;
  counters: RasterFixtureCounters;
  readonly maximumOpenPages: number;
  readonly maximumOpenCanvases: number;
  blockedOperationStarted: Promise<void>;
} {
  const counters: RasterFixtureCounters = {
    pageCleanup: 0,
    canvasDestroy: 0,
    renderCancel: 0,
    documentCleanup: 0,
    loadingTaskDestroy: 0,
    pdfWorkerDestroy: 0,
    parserPortTerminate: 0,
    parserFailureListenerRemove: 0,
  };
  let openPages = 0;
  let maximumOpenPages = 0;
  let openCanvases = 0;
  let maximumOpenCanvases = 0;
  let notifyBlockedOperationStarted: () => void = () => undefined;
  const blockedOperationStarted = new Promise<void>((resolve) => {
    notifyBlockedOperationStarted = resolve;
  });
  const parserFailure = new Promise<never>(() => undefined);

  const failCleanup = (name: keyof RasterFixtureCounters) => {
    if (options.cleanupFailures?.has(name)) throw new Error(`${name} fixture failure`);
  };
  const createPage = (): PdfRasterRendererPage => {
    openPages += 1;
    maximumOpenPages = Math.max(maximumOpenPages, openPages);
    let cleaned = false;
    return {
      rotate: 0,
      getViewport({ scale }) {
        return { width: 100 * scale, height: 200 * scale };
      },
      render() {
        if (options.block !== "render") {
          return { promise: Promise.resolve(), cancel: vi.fn() };
        }
        notifyBlockedOperationStarted();
        let rejectRender: (error: unknown) => void = () => undefined;
        const promise = new Promise<void>((_resolve, reject) => {
          rejectRender = reject;
        });
        return {
          promise,
          cancel() {
            counters.renderCancel += 1;
            rejectRender(new Error("render cancelled"));
          },
        };
      },
      cleanup() {
        counters.pageCleanup += 1;
        if (!cleaned) {
          cleaned = true;
          openPages -= 1;
        }
        failCleanup("pageCleanup");
      },
    };
  };

  const document: PdfRasterRendererDocument = {
    numPages: 1,
    async getPage() {
      if (options.block === "getPage") {
        notifyBlockedOperationStarted();
        return await new Promise<PdfRasterRendererPage>(() => undefined);
      }
      return createPage();
    },
    cleanup() {
      counters.documentCleanup += 1;
      failCleanup("documentCleanup");
    },
  };

  const adapter: PdfRasterRendererAdapter = {
    async open() {
      if (options.block === "load") notifyBlockedOperationStarted();
      return {
        loadingTask: {
          promise:
            options.block === "load"
              ? new Promise<PdfRasterRendererDocument>(() => undefined)
              : Promise.resolve(document),
          destroy() {
            counters.loadingTaskDestroy += 1;
            failCleanup("loadingTaskDestroy");
          },
        },
        pdfWorker: {
          destroy() {
            counters.pdfWorkerDestroy += 1;
            failCleanup("pdfWorkerDestroy");
          },
        },
        parserPort: {
          terminate() {
            counters.parserPortTerminate += 1;
            failCleanup("parserPortTerminate");
          },
        },
        parserFailure,
        removeParserFailureListeners() {
          counters.parserFailureListenerRemove += 1;
          failCleanup("parserFailureListenerRemove");
        },
        classifyError() {
          return undefined;
        },
      };
    },
    createCanvas(width, height) {
      openCanvases += 1;
      maximumOpenCanvases = Math.max(maximumOpenCanvases, openCanvases);
      let destroyed = false;
      const canvas = {
        width,
        height,
        async convertToBlob() {
          return new Blob();
        },
      };
      return {
        canvas,
        context: { fillStyle: "", fillRect: vi.fn() },
        destroy() {
          counters.canvasDestroy += 1;
          if (!destroyed) {
            destroyed = true;
            openCanvases -= 1;
          }
          failCleanup("canvasDestroy");
        },
      };
    },
  };

  return {
    adapter,
    counters,
    get maximumOpenPages() {
      return maximumOpenPages;
    },
    get maximumOpenCanvases() {
      return maximumOpenCanvases;
    },
    blockedOperationStarted,
  };
}

afterEach(() => {
  vi.doUnmock("pdfjs-dist");
  vi.unstubAllGlobals();
});

describe("PDF raster session ownership", () => {
  it("owns one page and canvas at a time and closes every renderer resource once", async () => {
    const fixture = createRasterAdapterFixture();
    const session = await openPdfRasterSession(
      { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
      { adapter: fixture.adapter },
    );

    await session.withPage(1, async (page) => {
      const viewport = page.getViewport({ scale: 1 });
      await session.withCanvas(100, 200, async (canvas) => {
        await session.render(page, canvas, viewport, "#ffffff");
      });
    });
    await session.close();
    await session.close();

    expect(fixture.maximumOpenPages).toBe(1);
    expect(fixture.maximumOpenCanvases).toBe(1);
    expect(fixture.counters).toMatchObject({
      pageCleanup: 1,
      canvasDestroy: 1,
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
  });

  it("attempts every independent close step when earlier cleanup throws", async () => {
    const fixture = createRasterAdapterFixture({
      cleanupFailures: new Set([
        "parserFailureListenerRemove",
        "documentCleanup",
        "loadingTaskDestroy",
        "pdfWorkerDestroy",
        "parserPortTerminate",
      ]),
    });
    const session = await openPdfRasterSession(
      { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
      { adapter: fixture.adapter },
    );

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(fixture.counters).toMatchObject({
      parserFailureListenerRemove: 1,
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
    });
  });

  it("normalizes an adapter startup rejection into the neutral runtime contract", async () => {
    const adapter: PdfRasterRendererAdapter = {
      async open() {
        throw new Error("private adapter startup details");
      },
      createCanvas() {
        throw new Error("not reached");
      },
    };

    await expect(
      openPdfRasterSession(
        { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
        { adapter },
      ),
    ).rejects.toMatchObject({
      name: "PdfRasterRuntimeError",
      code: "WORKER_CRASH",
      retryable: true,
    });
  });

  it("settles abort during adapter startup and cleans resources that fulfill late once", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const fixture = createRasterAdapterFixture();
    let notifyOpenStarted: () => void = () => undefined;
    const openStarted = new Promise<void>((resolve) => {
      notifyOpenStarted = resolve;
    });
    let releaseOpen: () => Promise<void> = async () => undefined;
    const adapter: PdfRasterRendererAdapter = {
      open(input, budget) {
        notifyOpenStarted();
        return new Promise((resolve) => {
          releaseOpen = async () => {
            resolve(await fixture.adapter.open(input, budget));
          };
        });
      },
      createCanvas: fixture.adapter.createCanvas,
    };
    const opened = openPdfRasterSession(
      { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
      { adapter, signal: controller.signal },
    );

    await openStarted;
    controller.abort();

    await expect(settleBeforeNextTimer(opened)).resolves.toMatchObject({
      status: "rejected",
      error: { name: "AbortError" },
    });
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(fixture.counters).toMatchObject({
      documentCleanup: 0,
      loadingTaskDestroy: 0,
      pdfWorkerDestroy: 0,
      parserPortTerminate: 0,
      parserFailureListenerRemove: 0,
    });

    await releaseOpen();
    await vi.waitFor(() => {
      expect(fixture.counters).toMatchObject({
        documentCleanup: 1,
        loadingTaskDestroy: 1,
        pdfWorkerDestroy: 1,
        parserPortTerminate: 1,
        parserFailureListenerRemove: 1,
      });
    });
    await Promise.resolve();
    expect(fixture.counters).toMatchObject({
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
  });

  it("cleans a cached loaded document when a known parser failure wins the load race", async () => {
    const parserFailure = Promise.reject(new Error("parser crashed"));
    void parserFailure.catch(() => undefined);
    const document: PdfRasterRendererDocument = {
      numPages: 1,
      getPage: vi.fn(),
      cleanup: vi.fn(),
    };
    const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn() };
    const adapter: PdfRasterRendererAdapter = {
      async open() {
        return {
          loadingTask,
          pdfWorker: { destroy: vi.fn() },
          parserPort: { terminate: vi.fn() },
          parserFailure,
          removeParserFailureListeners: vi.fn(),
          classifyError: vi.fn(),
        };
      },
      createCanvas() {
        throw new Error("not reached");
      },
    };

    await expect(
      openPdfRasterSession(
        { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
        { adapter },
      ),
    ).rejects.toMatchObject({ code: "WORKER_CRASH" });

    expect(document.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { stage: "load" as const, pageCleanup: 0, renderCancel: 0, documentCleanup: 0 },
    { stage: "getPage" as const, pageCleanup: 0, renderCancel: 0, documentCleanup: 1 },
    { stage: "render" as const, pageCleanup: 1, renderCancel: 1, documentCleanup: 1 },
  ])("cancels and cleans up during $stage", async ({
    stage,
    pageCleanup,
    renderCancel,
    documentCleanup,
  }) => {
    const controller = new AbortController();
    const fixture = createRasterAdapterFixture({ block: stage });
    const opened = openPdfRasterSession(
      { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
      { adapter: fixture.adapter, signal: controller.signal },
    );
    const operation: Promise<unknown> =
      stage === "load"
        ? opened
        : opened.then(async (session) => {
            try {
              await session.withPage(1, async (page) => {
                if (stage !== "render") return;
                const viewport = page.getViewport({ scale: 1 });
                await session.withCanvas(100, 200, async (canvas) => {
                  await session.render(page, canvas, viewport, "#ffffff");
                });
              });
            } finally {
              await session.close();
            }
          });

    await fixture.blockedOperationStarted;
    controller.abort();

    await expect(settleBeforeNextTimer(operation)).resolves.toMatchObject({
      status: "rejected",
      error: { name: "AbortError" },
    });
    expect(fixture.counters).toMatchObject({
      pageCleanup,
      renderCancel,
      documentCleanup,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
  });
});

describe("default PDF.js adapter and parser readiness", () => {
  it.each([
    "error",
    "messageerror",
  ] as const)("rejects the parser probe when the Worker sends %s after PDFWorker.promise but before document load", async (eventType) => {
    const addedListenerTypes: string[] = [];
    const removedListenerTypes: string[] = [];
    class FakeParserWorker {
      static instances: FakeParserWorker[] = [];
      readonly listeners = new Map<string, Set<(event: Event) => void>>();
      readonly terminate = vi.fn();

      constructor(
        readonly url: URL,
        readonly options: WorkerOptions,
      ) {
        FakeParserWorker.instances.push(this);
      }

      addEventListener(type: string, listener: unknown) {
        addedListenerTypes.push(type);
        const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
        listeners.add(listener as (event: Event) => void);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: unknown) {
        removedListenerTypes.push(type);
        this.listeners.get(type)?.delete(listener as (event: Event) => void);
      }

      emit(type: string) {
        const event = { type, preventDefault: vi.fn() } as unknown as Event;
        for (const listener of this.listeners.get(type) ?? []) listener(event);
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
    const getPage = vi.fn();
    const loadingTask = {
      promise: new Promise<never>(() => undefined),
      destroy: vi.fn(async () => undefined),
    };
    const getDocument = vi.fn((_parameters: Record<string, unknown>) => loadingTask);
    vi.resetModules();
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
    vi.stubGlobal("self", { location: { origin: "https://example.test" } });

    const result = probePdfRasterParserWorker();
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalledOnce());
    await expect(FakePDFWorker.instances[0]?.promise).resolves.toBeUndefined();
    expect(await settleBeforeNextTimer(result)).toEqual({ status: "pending" });
    const parserPort = FakeParserWorker.instances[0];
    expect(parserPort).toBeDefined();
    expect(parserPort?.url.href).toBe("https://example.test/pdfjs/6.2.108/pdf.worker.min.mjs");
    expect(parserPort?.options).toEqual({
      type: "module",
      name: "hereisit-pdfjs-parser-worker",
    });
    expect(addedListenerTypes).toEqual(["error", "messageerror"]);

    parserPort?.emit(eventType);

    await expect(settleBeforeNextTimer(result)).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(FakePDFWorker.instances[0]?.destroy).toHaveBeenCalledOnce();
    expect(parserPort?.terminate).toHaveBeenCalledOnce();
    expect(removedListenerTypes).toEqual(["error", "messageerror"]);

    const parameters = getDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(parameters).sort()).toEqual(
      [
        "CanvasFactory",
        "FilterFactory",
        "cMapPacked",
        "cMapUrl",
        "canvasMaxAreaInBytes",
        "data",
        "disableFontFace",
        "enableXfa",
        "isImageDecoderSupported",
        "isOffscreenCanvasSupported",
        "maxImageSize",
        "standardFontDataUrl",
        "stopAtErrors",
        "useSystemFonts",
        "useWasm",
        "useWorkerFetch",
        "verbosity",
        "worker",
      ].sort(),
    );
    expect(parameters).toMatchObject({
      cMapUrl: "https://example.test/pdfjs/6.2.108/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "https://example.test/pdfjs/6.2.108/standard_fonts/",
      useWorkerFetch: true,
      useWasm: false,
      enableXfa: false,
      stopAtErrors: true,
      disableFontFace: true,
      useSystemFonts: false,
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 64_000_000,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      verbosity: 0,
      worker: FakePDFWorker.instances[0],
    });
    expect(parameters.data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode((parameters.data as Uint8Array).slice(0, 5))).toBe("%PDF-");
  });

  it("loads and acquires page 1 of the module-owned one-page PDF before resolving", async () => {
    class FakeParserWorker extends EventTarget {
      readonly terminate = vi.fn();
    }
    class FakePDFWorker {
      readonly destroy = vi.fn();
    }
    class FakePdfException extends Error {}
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 1, height: 1 })),
      render: vi.fn(),
      cleanup: vi.fn(),
    };
    const document = {
      numPages: 1,
      getPage: vi.fn(async () => page),
      cleanup: vi.fn(),
    };
    const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn() };
    const getDocument = vi.fn(() => loadingTask);
    vi.resetModules();
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
    vi.stubGlobal("self", { location: { origin: "https://example.test" } });

    await probePdfRasterParserWorker();

    expect(getDocument).toHaveBeenCalledOnce();
    expect(document.getPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(page.getViewport).toHaveBeenCalledExactlyOnceWith({ scale: 1 });
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(document.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a probe whose acquired page has a non-finite viewport and still closes it", async () => {
    class FakeParserWorker extends EventTarget {
      readonly terminate = vi.fn();
    }
    class FakePDFWorker {
      readonly destroy = vi.fn();
    }
    class FakePdfException extends Error {}
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({ width: Number.NaN, height: 1 })),
      render: vi.fn(),
      cleanup: vi.fn(),
    };
    const document = {
      numPages: 1,
      getPage: vi.fn(async () => page),
      cleanup: vi.fn(),
    };
    const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn() };
    vi.resetModules();
    vi.doMock("pdfjs-dist", () => ({
      AbortException: FakePdfException,
      getDocument: vi.fn(() => loadingTask),
      InvalidPDFException: FakePdfException,
      PasswordException: FakePdfException,
      PDFWorker: FakePDFWorker,
      RenderingCancelledException: FakePdfException,
      ResponseException: FakePdfException,
      VerbosityLevel: { ERRORS: 0 },
      version: "6.2.108",
    }));
    vi.stubGlobal("Worker", FakeParserWorker);
    vi.stubGlobal("self", { location: { origin: "https://example.test" } });

    await expect(probePdfRasterParserWorker()).rejects.toMatchObject({
      code: "RENDER_FAILED",
    });

    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(document.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("rejects any PDF.js version other than the pinned renderer version", async () => {
    class FakePdfException extends Error {}
    const ParserWorker = vi.fn();
    vi.resetModules();
    vi.doMock("pdfjs-dist", () => ({
      AbortException: FakePdfException,
      getDocument: vi.fn(),
      InvalidPDFException: FakePdfException,
      PasswordException: FakePdfException,
      PDFWorker: vi.fn(),
      RenderingCancelledException: FakePdfException,
      ResponseException: FakePdfException,
      VerbosityLevel: { ERRORS: 0 },
      version: "6.1.201",
    }));
    vi.stubGlobal("Worker", ParserWorker);

    await expect(
      openPdfRasterSession({ bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer }),
    ).rejects.toMatchObject({ code: "WORKER_CRASH", retryable: true });
    expect(ParserWorker).not.toHaveBeenCalled();
  });

  it("tears down a partially opened default adapter when getDocument throws", async () => {
    const removedListenerTypes: string[] = [];
    class FakeParserWorker extends EventTarget {
      static instances: FakeParserWorker[] = [];
      readonly terminate = vi.fn();

      constructor() {
        super();
        FakeParserWorker.instances.push(this);
      }

      override removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        removedListenerTypes.push(type);
        super.removeEventListener(type, listener);
      }
    }
    class FakePDFWorker {
      static instances: FakePDFWorker[] = [];
      readonly destroy = vi.fn();

      constructor() {
        FakePDFWorker.instances.push(this);
      }
    }
    class FakePdfException extends Error {}
    vi.resetModules();
    vi.doMock("pdfjs-dist", () => ({
      AbortException: FakePdfException,
      getDocument: vi.fn(() => {
        throw new Error("getDocument fixture failure");
      }),
      InvalidPDFException: FakePdfException,
      PasswordException: FakePdfException,
      PDFWorker: FakePDFWorker,
      RenderingCancelledException: FakePdfException,
      ResponseException: FakePdfException,
      VerbosityLevel: { ERRORS: 0 },
      version: "6.2.108",
    }));
    vi.stubGlobal("Worker", FakeParserWorker);
    vi.stubGlobal("self", { location: { origin: "https://example.test" } });

    await expect(
      openPdfRasterSession({ bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer }),
    ).rejects.toMatchObject({ code: "WORKER_CRASH", retryable: true });

    expect(FakePDFWorker.instances[0]?.destroy).toHaveBeenCalledOnce();
    expect(FakeParserWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(removedListenerTypes).toEqual(["error", "messageerror"]);
  });
});

describe("WorkerCanvasBudget and Worker factories", () => {
  function installOffscreenCanvas() {
    const constructorCalls = vi.fn();
    class FakeOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        constructorCalls(width, height);
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { fillStyle: "", fillRect: vi.fn() };
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    return constructorCalls;
  }

  it.each([
    [8_193, 1_000],
    [4_001, 4_000],
  ])("rejects an unsafe %i x %i scratch canvas before allocation", (width, height) => {
    const constructorCalls = installOffscreenCanvas();
    const factory = new WorkerCanvasFactory(new WorkerCanvasBudget());

    expect(() => factory.create(width, height)).toThrowError(
      expect.objectContaining({ code: "MEMORY_LIMIT" }),
    );
    expect(constructorCalls).not.toHaveBeenCalled();
  });

  it("accounts the 128 MiB combined output and display-layer budget and releases once", () => {
    installOffscreenCanvas();
    const budget = new WorkerCanvasBudget();
    const factory = new WorkerCanvasFactory(budget);
    const first = factory.create(4_000, 4_000);
    const second = factory.create(4_000, 4_000);
    const small = factory.create(1, 1);

    expect(() => factory.reset(small, 1_024, 2_048)).toThrowError(
      expect.objectContaining({ code: "MEMORY_LIMIT" }),
    );
    expect(small.canvas).toMatchObject({ width: 1, height: 1 });

    factory.destroy(first);
    expect(() => factory.reset(small, 1_024, 2_048)).not.toThrow();
    const activeAfterReset = budget.activeBytes;
    factory.destroy(first);
    expect(budget.activeBytes).toBe(activeAfterReset);
    factory.destroy(second);
    factory.destroy(small);

    expect(budget.activeBytes).toBe(0);
    expect(first).toEqual({ canvas: null, context: null });
    expect(second).toEqual({ canvas: null, context: null });
    expect(small).toEqual({ canvas: null, context: null });
  });

  it("rejects duplicate reserve and reset of an unknown allocation", () => {
    const budget = new WorkerCanvasBudget();
    const owner = {};

    budget.reserve(owner, 1, 1);

    expect(() => budget.reserve(owner, 1, 1)).toThrowError(
      expect.objectContaining({ code: "MEMORY_LIMIT" }),
    );
    expect(() => budget.reset({}, 1, 1)).toThrowError(
      expect.objectContaining({ code: "MEMORY_LIMIT" }),
    );
    budget.release(owner);
    expect(budget.activeBytes).toBe(0);
  });

  it("releases the old backing store before changing both reset dimensions", () => {
    let peakPixels = 0;
    class PeakTrackingOffscreenCanvas {
      #width: number;
      #height: number;

      constructor(width: number, height: number) {
        this.#width = width;
        this.#height = height;
        peakPixels = Math.max(peakPixels, width * height);
      }

      get width() {
        return this.#width;
      }

      set width(value: number) {
        this.#width = value;
        peakPixels = Math.max(peakPixels, this.#width * this.#height);
      }

      get height() {
        return this.#height;
      }

      set height(value: number) {
        this.#height = value;
        peakPixels = Math.max(peakPixels, this.#width * this.#height);
      }

      getContext() {
        return { fillStyle: "", fillRect: vi.fn() };
      }
    }
    vi.stubGlobal("OffscreenCanvas", PeakTrackingOffscreenCanvas);
    const factory = new WorkerCanvasFactory(new WorkerCanvasBudget());
    const holder = factory.create(4_000, 4_000);

    factory.reset(holder, 8_000, 2_000);

    expect(peakPixels).toBe(16_000_000);
    factory.destroy(holder);
  });

  it("zeros both canvas axes before releasing its holder", () => {
    const writes: Array<["width" | "height", number]> = [];
    class TrackedOffscreenCanvas {
      #width: number;
      #height: number;

      constructor(width: number, height: number) {
        this.#width = width;
        this.#height = height;
      }

      get width() {
        return this.#width;
      }

      set width(value: number) {
        this.#width = value;
        writes.push(["width", value]);
      }

      get height() {
        return this.#height;
      }

      set height(value: number) {
        this.#height = value;
        writes.push(["height", value]);
      }

      getContext() {
        return { fillStyle: "", fillRect: vi.fn() };
      }
    }
    vi.stubGlobal("OffscreenCanvas", TrackedOffscreenCanvas);
    const factory = new WorkerCanvasFactory(new WorkerCanvasBudget());
    const holder = factory.create(10, 20);
    const canvas = holder.canvas;

    factory.destroy(holder);

    expect(writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
    expect(holder).toEqual({ canvas: null, context: null });
  });

  it.each([
    [8_193, 1_000],
    [4_001, 4_000],
  ])("rejects an unsafe %i x %i scratch reset without changing its holder", (width, height) => {
    installOffscreenCanvas();
    const budget = new WorkerCanvasBudget();
    const factory = new WorkerCanvasFactory(budget);
    const holder = factory.create(1, 1);

    expect(() => factory.reset(holder, width, height)).toThrowError(
      expect.objectContaining({ code: "MEMORY_LIMIT" }),
    );
    expect(holder.canvas).toMatchObject({ width: 1, height: 1 });
    factory.destroy(holder);
    expect(budget.activeBytes).toBe(0);
  });

  it("provides a DOM-free filter factory surface", () => {
    const factory = new WorkerFilterFactory();

    expect(factory.addFilter([])).toBe("none");
    expect(factory.addHCMFilter("#000", "#fff")).toBe("none");
    expect(factory.addAlphaFilter(new Uint8Array())).toBe("none");
    expect(factory.addLuminosityFilter(new Uint8Array())).toBe("none");
    expect(factory.addKnockoutFilter()).toBe("none");
    expect(factory.addSelectionFilter()).toBe("none");
    expect(factory.createSelectionStyle()).toBeNull();
    expect(() => factory.destroy()).not.toThrow();
  });
});
