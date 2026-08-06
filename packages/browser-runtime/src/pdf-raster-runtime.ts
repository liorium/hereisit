import {
  MAX_PDF_RASTER_DIMENSION,
  MAX_PDF_RASTER_PAGE_PIXELS,
  PDF_RASTER_RGBA_BYTES_PER_PIXEL,
} from "@hereisit/pdf-tool";

const MAX_ACTIVE_CANVAS_BYTES = 128 * 1024 * 1024;
const PDFJS_VERSION = "6.2.108";
const PDFJS_ASSET_PATH = `/pdfjs/${PDFJS_VERSION}/`;
const CANVAS_MEMORY_MARKER = "[HEREISIT_PDF_CANVAS_MEMORY_LIMIT]";
const MEMORY_LIMIT_MESSAGE =
  "선택한 해상도에서 이미지를 안전하게 만들 수 없어요. 페이지 수나 해상도를 줄여 주세요.";
const PARSER_WORKER_FAILURE_MESSAGE = "PDF 렌더러 작업기가 중단됐어요.";

const MINIMAL_ONE_PAGE_PDF_BYTES = new TextEncoder().encode(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Resources << >> >>
endobj
xref
0 4
0000000000 65535 f${" "}
0000000009 00000 n${" "}
0000000058 00000 n${" "}
0000000115 00000 n${" "}
trailer
<< /Size 4 /Root 1 0 R >>
startxref
199
%%EOF
`);

export type PdfRasterRuntimeErrorCode =
  | "PASSWORD_PROTECTED"
  | "CORRUPT_PDF"
  | "MEMORY_LIMIT"
  | "RENDER_FAILED"
  | "WORKER_CRASH";

export class PdfRasterRuntimeError extends Error {
  constructor(
    readonly code: PdfRasterRuntimeErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PdfRasterRuntimeError";
  }
}

class PdfRasterCancellationError extends Error {
  constructor() {
    super("PDF raster rendering was cancelled.");
    this.name = "AbortError";
  }
}

class WorkerCanvasBudgetError extends PdfRasterRuntimeError {
  constructor() {
    super("MEMORY_LIMIT", `${CANVAS_MEMORY_MARKER} ${MEMORY_LIMIT_MESSAGE}`);
    this.name = "WorkerCanvasBudgetError";
  }
}

interface CanvasAllocation {
  bytes: number;
}

export class WorkerCanvasBudget {
  readonly #allocations = new Map<object, CanvasAllocation>();
  #activeBytes = 0;

  get activeBytes(): number {
    return this.#activeBytes;
  }

  reserve(owner: object, width: number, height: number): void {
    if (this.#allocations.has(owner)) throw new WorkerCanvasBudgetError();
    const bytes = canvasBytes(width, height);
    if (this.#activeBytes + bytes > MAX_ACTIVE_CANVAS_BYTES) {
      throw new WorkerCanvasBudgetError();
    }
    this.#allocations.set(owner, { bytes });
    this.#activeBytes += bytes;
  }

  reset(owner: object, width: number, height: number): void {
    const current = this.#allocations.get(owner);
    if (current === undefined) throw new WorkerCanvasBudgetError();
    const bytes = canvasBytes(width, height);
    const nextActiveBytes = this.#activeBytes - current.bytes + bytes;
    if (!Number.isSafeInteger(nextActiveBytes) || nextActiveBytes > MAX_ACTIVE_CANVAS_BYTES) {
      throw new WorkerCanvasBudgetError();
    }
    current.bytes = bytes;
    this.#activeBytes = nextActiveBytes;
  }

  release(owner: object): void {
    const allocation = this.#allocations.get(owner);
    if (allocation === undefined) return;
    this.#allocations.delete(owner);
    this.#activeBytes -= allocation.bytes;
  }
}

function canvasBytes(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_PDF_RASTER_DIMENSION ||
    height > MAX_PDF_RASTER_DIMENSION
  ) {
    throw new WorkerCanvasBudgetError();
  }
  const pixels = width * height;
  const bytes = pixels * PDF_RASTER_RGBA_BYTES_PER_PIXEL;
  if (
    !Number.isSafeInteger(pixels) ||
    !Number.isSafeInteger(bytes) ||
    pixels > MAX_PDF_RASTER_PAGE_PIXELS
  ) {
    throw new WorkerCanvasBudgetError();
  }
  return bytes;
}

export interface WorkerCanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}

export class WorkerCanvasFactory {
  readonly #owners = new WeakMap<WorkerCanvasAndContext, object>();

  constructor(readonly budget = new WorkerCanvasBudget()) {}

  create(width: number, height: number): WorkerCanvasAndContext {
    const owner = {};
    this.budget.reserve(owner, width, height);
    let canvas: OffscreenCanvas | undefined;
    try {
      canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new WorkerCanvasBudgetError();
      const holder: WorkerCanvasAndContext = { canvas, context };
      this.#owners.set(holder, owner);
      return holder;
    } catch (error) {
      this.budget.release(owner);
      if (canvas !== undefined) {
        canvas.width = 0;
        canvas.height = 0;
      }
      throw error;
    }
  }

  reset(holder: WorkerCanvasAndContext, width: number, height: number): void {
    const owner = this.#owners.get(holder);
    const canvas = holder.canvas;
    if (owner === undefined || canvas === null) throw new WorkerCanvasBudgetError();
    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    this.budget.reset(owner, width, height);
    try {
      canvas.width = 0;
      canvas.height = 0;
      canvas.width = width;
      canvas.height = height;
    } catch (error) {
      this.budget.reset(owner, previousWidth, previousHeight);
      try {
        canvas.width = 0;
        canvas.height = 0;
        canvas.width = previousWidth;
        canvas.height = previousHeight;
      } catch {
        // Session teardown will destroy a canvas that the browser refused to restore.
      }
      throw error;
    }
  }

  destroy(holder: WorkerCanvasAndContext): void {
    const owner = this.#owners.get(holder);
    if (owner === undefined) return;
    this.#owners.delete(holder);
    try {
      if (holder.canvas !== null) {
        holder.canvas.width = 0;
        holder.canvas.height = 0;
      }
    } finally {
      holder.canvas = null;
      holder.context = null;
      this.budget.release(owner);
    }
  }
}

export class WorkerFilterFactory {
  addFilter(_maps: unknown): string {
    return "none";
  }

  addHCMFilter(_foreground: unknown, _background: unknown): string {
    return "none";
  }

  addAlphaFilter(_map: unknown): string {
    return "none";
  }

  addLuminosityFilter(_map: unknown): string {
    return "none";
  }

  addKnockoutFilter(_alpha?: number): string {
    return "none";
  }

  addHighlightHCMFilter(
    _filterName: unknown,
    _foreground: unknown,
    _background: unknown,
    _newForeground: unknown,
    _newBackground: unknown,
  ): string {
    return "none";
  }

  addSelectionHCMFilter(_foreground: string, _background: string): string {
    return "none";
  }

  addSelectionFilter(): string {
    return "none";
  }

  createSelectionStyle(_pageColors?: { background?: string; foreground?: string }): null {
    return null;
  }

  destroy(_keepHCM?: boolean): void {}
}

export interface PdfRasterViewport {
  width: number;
  height: number;
}

export interface PdfRasterRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfRasterRendererPage {
  readonly rotate: number;
  getViewport(options: { scale: number; rotation?: number }): PdfRasterViewport;
  render(options: {
    canvas: PdfRasterCanvasSurface;
    viewport: PdfRasterViewport;
    background: "#ffffff";
  }): PdfRasterRenderTask;
  cleanup(): unknown;
}

export interface PdfRasterRendererDocument {
  readonly numPages: number;
  getPage(sourcePage: number): Promise<PdfRasterRendererPage>;
  cleanup(): Promise<unknown> | unknown;
}

export interface PdfRasterLoadingTask {
  readonly promise: Promise<PdfRasterRendererDocument>;
  destroy(): Promise<unknown> | unknown;
}

export interface PdfRasterRendererResources {
  readonly loadingTask: PdfRasterLoadingTask;
  readonly pdfWorker: { destroy(): Promise<unknown> | unknown };
  readonly parserPort: { terminate(): void };
  readonly parserFailure: Promise<never>;
  removeParserFailureListeners(): void;
  classifyError(error: unknown): "PASSWORD_PROTECTED" | "CORRUPT_PDF" | undefined;
}

export interface PdfRasterCanvasSurface {
  width: number;
  height: number;
  convertToBlob(options: { type: string; quality?: number }): Promise<Blob>;
}

export interface PdfRasterCanvasResource {
  readonly canvas: PdfRasterCanvasSurface;
  readonly context: {
    fillStyle: unknown;
    fillRect(x: number, y: number, width: number, height: number): void;
  };
  destroy(): void;
}

export interface PdfRasterRendererAdapter {
  open(
    input: { bytes: ArrayBuffer },
    budget: WorkerCanvasBudget,
  ): Promise<PdfRasterRendererResources>;
  createCanvas(width: number, height: number, budget: WorkerCanvasBudget): PdfRasterCanvasResource;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function hasCanvasMemoryMarker(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof WorkerCanvasBudgetError) return true;
  if (value instanceof PdfRasterRuntimeError && value.code === "MEMORY_LIMIT") return true;
  if (typeof value === "string") return value.includes(CANVAS_MEMORY_MARKER);
  if (!isObject(value) || seen.has(value)) return false;
  seen.add(value);
  return [value.message, value.details, value.cause, value.reason, value.originalError].some(
    (part) => hasCanvasMemoryMarker(part, seen),
  );
}

export function isPdfRasterMemoryError(value: unknown): boolean {
  return hasCanvasMemoryMarker(value);
}

function memoryLimit(): PdfRasterRuntimeError {
  return new PdfRasterRuntimeError("MEMORY_LIMIT", MEMORY_LIMIT_MESSAGE);
}

function parserWorkerFailure(): PdfRasterRuntimeError {
  return new PdfRasterRuntimeError("WORKER_CRASH", PARSER_WORKER_FAILURE_MESSAGE, true);
}

function normalizeParserFailure(error: unknown): PdfRasterRuntimeError {
  if (error instanceof PdfRasterRuntimeError && error.code === "WORKER_CRASH" && error.retryable) {
    return error;
  }
  return parserWorkerFailure();
}

async function ignoreCleanup(
  cleanup: () => Promise<unknown> | unknown,
  parserFailure?: Promise<never>,
): Promise<void> {
  try {
    const result = Promise.resolve(cleanup());
    if (parserFailure === undefined) {
      await result;
    } else {
      await Promise.race([parserFailure, result]);
    }
  } catch {
    // Every independent renderer resource still gets its cleanup attempt.
  }
}

async function cleanupRendererResources(
  resources: PdfRasterRendererResources,
  document?: PdfRasterRendererDocument,
): Promise<void> {
  await ignoreCleanup(() => document?.cleanup(), resources.parserFailure);
  await ignoreCleanup(() => resources.loadingTask.destroy(), resources.parserFailure);
  await ignoreCleanup(() => resources.pdfWorker.destroy(), resources.parserFailure);
  try {
    resources.removeParserFailureListeners();
  } catch {
    // Continue cleanup after a listener removal failure.
  }
  await ignoreCleanup(() => resources.parserPort.terminate());
}

async function cleanupLateRendererResources(resources: PdfRasterRendererResources): Promise<void> {
  let documentCleanupStarted = false;
  const cleanupDocument = async (document: PdfRasterRendererDocument): Promise<void> => {
    if (documentCleanupStarted) return;
    documentCleanupStarted = true;
    await ignoreCleanup(() => document.cleanup(), resources.parserFailure);
  };
  void Promise.resolve(resources.loadingTask.promise).then(
    (document) => cleanupDocument(document),
    () => undefined,
  );
  await cleanupRendererResources(resources);
}

function createDefaultAdapter(): PdfRasterRendererAdapter {
  return {
    async open(input, budget) {
      const pdfjs = await import("pdfjs-dist");
      const {
        AbortException,
        getDocument,
        InvalidPDFException,
        PasswordException,
        PDFWorker,
        RenderingCancelledException,
        ResponseException,
        VerbosityLevel,
        version,
      } = pdfjs;
      if (version !== PDFJS_VERSION) {
        throw new PdfRasterRuntimeError(
          "WORKER_CRASH",
          "PDF 렌더러 버전을 확인하지 못했어요.",
          true,
        );
      }

      let parserPort: Worker | undefined;
      let pdfWorker: InstanceType<typeof PDFWorker> | undefined;
      let loadingTask: PdfRasterLoadingTask | undefined;
      let parserFailure: Promise<never> | undefined;
      let removeParserFailureListeners = () => undefined;
      try {
        parserPort = new Worker(
          new URL(`${PDFJS_ASSET_PATH}pdf.worker.min.mjs`, self.location.origin),
          {
            type: "module",
            name: "hereisit-pdfjs-parser-worker",
          },
        );
        let parserFailureReported = false;
        let rejectParserFailure: (error: PdfRasterRuntimeError) => void = () => undefined;
        parserFailure = new Promise<never>((_resolve, reject) => {
          rejectParserFailure = reject;
        });
        void parserFailure.catch(() => undefined);
        const onParserFailure = (event: Event) => {
          event.preventDefault();
          if (parserFailureReported) return;
          parserFailureReported = true;
          rejectParserFailure(parserWorkerFailure());
        };
        let parserFailureListenersRemoved = false;
        removeParserFailureListeners = () => {
          if (parserFailureListenersRemoved || parserPort === undefined) return;
          parserFailureListenersRemoved = true;
          parserPort.removeEventListener("error", onParserFailure);
          parserPort.removeEventListener("messageerror", onParserFailure);
        };
        parserPort.addEventListener("error", onParserFailure);
        parserPort.addEventListener("messageerror", onParserFailure);
        const PDFWorkerWithPort = PDFWorker as unknown as new (options: {
          port: Worker;
        }) => InstanceType<typeof PDFWorker>;
        pdfWorker = new PDFWorkerWithPort({ port: parserPort });
        const assetBase = new URL(PDFJS_ASSET_PATH, self.location.origin).href;
        const CanvasFactory = class extends WorkerCanvasFactory {
          constructor(_options?: unknown) {
            super(budget);
          }
        };
        loadingTask = getDocument({
          data: new Uint8Array(input.bytes),
          worker: pdfWorker,
          cMapUrl: `${assetBase}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${assetBase}standard_fonts/`,
          useWorkerFetch: true,
          useWasm: false,
          enableXfa: false,
          stopAtErrors: true,
          disableFontFace: true,
          useSystemFonts: false,
          maxImageSize: MAX_PDF_RASTER_PAGE_PIXELS,
          canvasMaxAreaInBytes: MAX_PDF_RASTER_PAGE_PIXELS * PDF_RASTER_RGBA_BYTES_PER_PIXEL,
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
          verbosity: VerbosityLevel.ERRORS,
          CanvasFactory,
          FilterFactory: WorkerFilterFactory,
        }) as unknown as PdfRasterLoadingTask;

        return {
          loadingTask,
          pdfWorker,
          parserPort,
          parserFailure,
          removeParserFailureListeners,
          classifyError(error) {
            if (error instanceof PasswordException) return "PASSWORD_PROTECTED";
            if (error instanceof InvalidPDFException || error instanceof ResponseException) {
              return "CORRUPT_PDF";
            }
            if (error instanceof AbortException || error instanceof RenderingCancelledException) {
              return undefined;
            }
            return undefined;
          },
        };
      } catch (error) {
        try {
          removeParserFailureListeners();
        } catch {
          // Continue partial-construction cleanup.
        }
        if (loadingTask !== undefined) {
          await ignoreCleanup(() => loadingTask?.destroy(), parserFailure);
        }
        if (pdfWorker !== undefined) {
          await ignoreCleanup(() => pdfWorker?.destroy(), parserFailure);
        }
        if (parserPort !== undefined) {
          await ignoreCleanup(() => parserPort?.terminate());
        }
        if (error instanceof PdfRasterRuntimeError) throw error;
        throw new PdfRasterRuntimeError("WORKER_CRASH", "PDF 렌더러를 시작하지 못했어요.", true);
      }
    },
    createCanvas(width, height, budget) {
      const factory = new WorkerCanvasFactory(budget);
      const holder = factory.create(width, height);
      const canvas = holder.canvas;
      const context = holder.context;
      if (canvas === null || context === null) {
        factory.destroy(holder);
        throw memoryLimit();
      }
      return {
        canvas,
        context,
        destroy() {
          factory.destroy(holder);
        },
      };
    },
  };
}

export interface PdfRasterSession {
  readonly pageCount: number;
  withPage<T>(sourcePage: number, use: (page: PdfRasterRendererPage) => Promise<T> | T): Promise<T>;
  withCanvas<T>(
    width: number,
    height: number,
    use: (canvas: PdfRasterCanvasResource) => Promise<T> | T,
  ): Promise<T>;
  render(
    page: PdfRasterRendererPage,
    canvas: PdfRasterCanvasResource,
    viewport: PdfRasterViewport,
    background: "#ffffff",
  ): Promise<void>;
  close(): Promise<void>;
}

export async function openPdfRasterSession(
  input: { bytes: ArrayBuffer },
  options: { adapter?: PdfRasterRendererAdapter; signal?: AbortSignal } = {},
): Promise<PdfRasterSession> {
  const adapter = options.adapter ?? createDefaultAdapter();
  const budget = new WorkerCanvasBudget();
  let aborted = options.signal?.aborted ?? false;
  let activeRender: PdfRasterRenderTask | undefined;
  let rejectAbort: (error: PdfRasterCancellationError) => void = () => undefined;
  const abortFailure = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void abortFailure.catch(() => undefined);
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    try {
      activeRender?.cancel();
    } catch {
      // Cancellation remains the terminal state.
    }
    rejectAbort(new PdfRasterCancellationError());
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (aborted) onAbort();
  const removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
  const throwIfAborted = () => {
    if (aborted || options.signal?.aborted) throw new PdfRasterCancellationError();
  };

  let resources: PdfRasterRendererResources | undefined;
  let document: PdfRasterRendererDocument | undefined;
  let loadedDocument: PdfRasterRendererDocument | undefined;
  let loadRaceLost = false;
  let loadedDocumentCleanupStarted = false;
  let adapterOpenRaceLost = false;
  let fulfilledOpenResources: PdfRasterRendererResources | undefined;
  let lateOpenCleanupStarted = false;
  let parserFailure: Promise<never> | undefined;
  const cleanupLateOpenResources = (candidate: PdfRasterRendererResources) => {
    if (lateOpenCleanupStarted) return;
    lateOpenCleanupStarted = true;
    void cleanupLateRendererResources(candidate);
  };
  const cleanupLoadedDocument = async (candidate: PdfRasterRendererDocument): Promise<void> => {
    if (loadedDocumentCleanupStarted) return;
    loadedDocumentCleanupStarted = true;
    await ignoreCleanup(() => candidate.cleanup(), resources?.parserFailure);
  };
  try {
    throwIfAborted();
    const adapterOpenPromise = Promise.resolve(adapter.open(input, budget)).then((opened) => {
      fulfilledOpenResources = opened;
      if (adapterOpenRaceLost) cleanupLateOpenResources(opened);
      return opened;
    });
    resources = await Promise.race([abortFailure, adapterOpenPromise]);
    throwIfAborted();
    parserFailure = resources.parserFailure.catch((error: unknown): never => {
      throw normalizeParserFailure(error);
    });
    void parserFailure.catch(() => undefined);
    const loadingPromise = Promise.resolve(resources.loadingTask.promise).then((loaded) => {
      loadedDocument = loaded;
      if (loadRaceLost) void cleanupLoadedDocument(loaded);
      return loaded;
    });
    await Promise.resolve();
    try {
      document = await Promise.race([parserFailure, abortFailure, loadingPromise]);
    } catch (error) {
      throwIfAborted();
      if (hasCanvasMemoryMarker(error)) throw memoryLimit();
      if (error instanceof PdfRasterRuntimeError) throw error;
      const code = resources.classifyError(error) ?? "CORRUPT_PDF";
      throw new PdfRasterRuntimeError(
        code,
        code === "PASSWORD_PROTECTED"
          ? "암호로 잠긴 PDF는 아직 처리할 수 없어요."
          : "PDF 파일을 읽을 수 없어요. 다른 파일을 선택해 주세요.",
      );
    }
    throwIfAborted();
  } catch (error) {
    loadRaceLost = true;
    if (resources === undefined) {
      adapterOpenRaceLost = true;
      if (fulfilledOpenResources !== undefined) cleanupLateOpenResources(fulfilledOpenResources);
    }
    removeAbortListener();
    if (resources !== undefined) {
      const cleanupDocument = document ?? loadedDocument;
      if (cleanupDocument !== undefined) await cleanupLoadedDocument(cleanupDocument);
      await cleanupRendererResources(resources);
    }
    if (aborted || options.signal?.aborted || error instanceof PdfRasterCancellationError) {
      throw new PdfRasterCancellationError();
    }
    if (hasCanvasMemoryMarker(error)) throw memoryLimit();
    if (error instanceof PdfRasterRuntimeError) throw error;
    throw new PdfRasterRuntimeError("WORKER_CRASH", "PDF 렌더러를 시작하지 못했어요.", true);
  }

  const ownedResources = resources;
  const ownedDocument = document;
  const ownedParserFailure = parserFailure;
  let closed = false;

  const raceRendererOperation = async <T>(operation: PromiseLike<T>): Promise<T> => {
    throwIfAborted();
    return await Promise.race([ownedParserFailure, abortFailure, Promise.resolve(operation)]);
  };
  const ensureOpen = () => {
    if (closed) {
      throw new PdfRasterRuntimeError("RENDER_FAILED", "PDF 렌더러 세션이 이미 종료됐어요.");
    }
  };

  return {
    pageCount: ownedDocument.numPages,
    async withPage(sourcePage, use) {
      ensureOpen();
      let page: PdfRasterRendererPage | undefined;
      let acquisitionLost = false;
      let pageCleanupStarted = false;
      const cleanupPage = (candidate: PdfRasterRendererPage) => {
        if (pageCleanupStarted) return;
        pageCleanupStarted = true;
        try {
          candidate.cleanup();
        } catch {
          // Document cleanup remains responsible for renderer residue.
        }
      };
      const pagePromise = Promise.resolve(ownedDocument.getPage(sourcePage)).then((acquired) => {
        if (acquisitionLost) cleanupPage(acquired);
        return acquired;
      });
      try {
        page = await raceRendererOperation(pagePromise);
      } catch (error) {
        acquisitionLost = true;
        void pagePromise.then(cleanupPage, () => undefined);
        throw error;
      }
      try {
        return await use(page);
      } finally {
        cleanupPage(page);
      }
    },
    async withCanvas(width, height, use) {
      ensureOpen();
      throwIfAborted();
      let canvas: PdfRasterCanvasResource | undefined;
      try {
        canvas = adapter.createCanvas(width, height, budget);
        return await use(canvas);
      } catch (error) {
        if (hasCanvasMemoryMarker(error)) throw memoryLimit();
        throw error;
      } finally {
        if (canvas !== undefined) {
          try {
            canvas.destroy();
          } catch {
            // The concrete canvas owner releases its shared-budget reservation.
          }
        }
      }
    },
    async render(page, canvas, viewport, background) {
      ensureOpen();
      throwIfAborted();
      let renderTask: PdfRasterRenderTask | undefined;
      try {
        renderTask = page.render({ canvas: canvas.canvas, viewport, background });
        activeRender = renderTask;
        await raceRendererOperation(renderTask.promise);
        throwIfAborted();
      } catch (error) {
        if (aborted || options.signal?.aborted) throw new PdfRasterCancellationError();
        if (hasCanvasMemoryMarker(error)) throw memoryLimit();
        if (error instanceof PdfRasterRuntimeError) {
          if (error.code === "WORKER_CRASH") {
            try {
              renderTask?.cancel();
            } catch {
              // The parser failure remains terminal.
            }
          }
          throw error;
        }
        throw new PdfRasterRuntimeError("RENDER_FAILED", "PDF 페이지를 이미지로 그리지 못했어요.");
      } finally {
        if (activeRender === renderTask) activeRender = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      removeAbortListener();
      activeRender = undefined;
      await cleanupRendererResources(ownedResources, ownedDocument);
    },
  };
}

export async function probePdfRasterParserWorker(): Promise<void> {
  const session = await openPdfRasterSession({ bytes: MINIMAL_ONE_PAGE_PDF_BYTES.slice().buffer });
  try {
    if (session.pageCount !== 1) {
      throw new PdfRasterRuntimeError("CORRUPT_PDF", "PDF 렌더러 준비 상태를 확인하지 못했어요.");
    }
    await session.withPage(1, (page) => {
      const viewport = page.getViewport({ scale: 1 });
      if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0
      ) {
        throw new PdfRasterRuntimeError(
          "RENDER_FAILED",
          "PDF 렌더러 준비 상태를 확인하지 못했어요.",
        );
      }
    });
  } finally {
    await session.close();
  }
}
