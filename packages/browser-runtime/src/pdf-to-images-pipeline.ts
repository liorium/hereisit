import {
  hasPdfSignature,
  MAX_PDF_TO_IMAGE_DIMENSION,
  MAX_PDF_TO_IMAGE_PAGE_PIXELS,
  MAX_PDF_TO_IMAGES_TOTAL_PIXELS,
  PDF_TO_IMAGE_RGBA_BYTES_PER_PIXEL,
  PdfToImagesPlanError,
  pdfToImagePageName,
  pdfToImagesArchiveName,
  planPdfToImagesRasterization,
} from "@hereisit/pdf-tool";
import {
  type PdfInspectionResult,
  type PdfToImagesErrorCode,
  type PdfToImagesErrorPayload,
  type PdfToImagesProgress,
  type PdfToImagesResult,
  type PdfToImagesRunRequest,
  pdfToImagesSpecSchema,
} from "@hereisit/tool-contracts";
import { Zip, ZipPassThrough } from "fflate";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_PAGES = 500;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_ACTIVE_CANVAS_BYTES = 128 * 1024 * 1024;
const PDFJS_VERSION = "6.1.200";
const PDFJS_ASSET_PATH = `/pdfjs/${PDFJS_VERSION}/`;
const CANVAS_MEMORY_MARKER = "[HEREITIS_PDF_CANVAS_MEMORY_LIMIT]";
const MEMORY_LIMIT_MESSAGE =
  "선택한 해상도에서 이미지를 안전하게 만들 수 없어요. 페이지 수나 해상도를 줄여 주세요.";
const PARSER_WORKER_FAILURE_MESSAGE = "PDF 렌더러 작업기가 중단됐어요.";

export type PdfToImagesPipelineInput = PdfToImagesRunRequest["input"];

export interface PdfToImagesPipelineOptions {
  adapter?: PdfToImagesRendererAdapter;
  onProgress?: (progress: PdfToImagesProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export class PdfToImagesPipelineError extends Error {
  constructor(
    readonly code: PdfToImagesErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PdfToImagesPipelineError";
  }
}

class PdfToImagesCancellationError extends Error {
  constructor() {
    super("PDF image conversion was cancelled.");
    this.name = "AbortError";
  }
}

class WorkerCanvasBudgetError extends PdfToImagesPipelineError {
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
    width > MAX_PDF_TO_IMAGE_DIMENSION ||
    height > MAX_PDF_TO_IMAGE_DIMENSION
  ) {
    throw new WorkerCanvasBudgetError();
  }
  const pixels = width * height;
  const bytes = pixels * 4;
  if (
    !Number.isSafeInteger(pixels) ||
    !Number.isSafeInteger(bytes) ||
    pixels > MAX_PDF_TO_IMAGE_PAGE_PIXELS
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
        // Pipeline teardown will destroy a canvas that the browser refused to restore.
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

export interface PdfToImagesViewport {
  width: number;
  height: number;
}

export interface PdfToImagesRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfToImagesRendererPage {
  readonly rotate: number;
  getViewport(options: { scale: number; rotation?: number }): PdfToImagesViewport;
  render(options: {
    canvas: PdfToImagesCanvasSurface;
    viewport: PdfToImagesViewport;
    background: "#ffffff";
  }): PdfToImagesRenderTask;
  cleanup(): unknown;
}

export interface PdfToImagesRendererDocument {
  readonly numPages: number;
  getPage(sourcePage: number): Promise<PdfToImagesRendererPage>;
  cleanup(): Promise<unknown> | unknown;
}

export interface PdfToImagesLoadingTask {
  readonly promise: Promise<PdfToImagesRendererDocument>;
  destroy(): Promise<unknown> | unknown;
}

export interface PdfToImagesRendererResources {
  readonly loadingTask: PdfToImagesLoadingTask;
  readonly pdfWorker: { destroy(): Promise<unknown> | unknown };
  readonly parserPort: { terminate(): void };
  readonly parserFailure: Promise<never>;
  removeParserFailureListeners(): void;
  classifyError(error: unknown): "PASSWORD_PROTECTED" | "CORRUPT_PDF" | undefined;
}

export interface PdfToImagesCanvasSurface {
  width: number;
  height: number;
  convertToBlob(options: { type: string; quality?: number }): Promise<Blob>;
}

export interface PdfToImagesCanvasResource {
  readonly canvas: PdfToImagesCanvasSurface;
  readonly context: {
    fillStyle: unknown;
    fillRect(x: number, y: number, width: number, height: number): void;
  };
  destroy(): void;
}

export type PdfToImagesArchiveOnData = (error: unknown, data: Uint8Array, final: boolean) => void;

export interface PdfToImagesArchive {
  add(name: string, bytes: Uint8Array): void;
  end(): void;
  terminate(): void;
}

export interface PdfToImagesRendererAdapter {
  open(
    input: PdfToImagesPipelineInput,
    budget: WorkerCanvasBudget,
  ): Promise<PdfToImagesRendererResources>;
  createCanvas(
    width: number,
    height: number,
    budget: WorkerCanvasBudget,
  ): PdfToImagesCanvasResource;
  createArchive?: (onData: PdfToImagesArchiveOnData) => PdfToImagesArchive;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function hasCanvasMemoryMarker(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof WorkerCanvasBudgetError) return true;
  if (typeof value === "string") return value.includes(CANVAS_MEMORY_MARKER);
  if (!isObject(value) || seen.has(value)) return false;
  seen.add(value);
  return [value.message, value.details, value.cause, value.reason, value.originalError].some(
    (part) => hasCanvasMemoryMarker(part, seen),
  );
}

function memoryLimit(): PdfToImagesPipelineError {
  return new PdfToImagesPipelineError("MEMORY_LIMIT", MEMORY_LIMIT_MESSAGE);
}

function parserWorkerFailure(): PdfToImagesPipelineError {
  return new PdfToImagesPipelineError("WORKER_CRASH", PARSER_WORKER_FAILURE_MESSAGE, true);
}

function normalizeParserFailure(error: unknown): PdfToImagesPipelineError {
  if (
    error instanceof PdfToImagesPipelineError &&
    error.code === "WORKER_CRASH" &&
    error.retryable
  ) {
    return error;
  }
  return parserWorkerFailure();
}

async function raceParserFailure<T>(
  operation: PromiseLike<T>,
  parserFailure: Promise<never> | undefined,
): Promise<T> {
  if (parserFailure === undefined) return await operation;
  return await Promise.race([parserFailure, Promise.resolve(operation)]);
}

function throwArchiveFailure(error: unknown): never {
  if (hasCanvasMemoryMarker(error)) throw memoryLimit();
  throw new PdfToImagesPipelineError("ENCODE_FAILED", "ZIP 파일을 만들지 못했어요.");
}

function mapPlanError(error: unknown): never {
  if (error instanceof PdfToImagesPlanError) {
    throw new PdfToImagesPipelineError(error.code, error.message);
  }
  throw error;
}

function createFflateArchive(onData: PdfToImagesArchiveOnData): PdfToImagesArchive {
  const zip = new Zip((error, data, final) => onData(error, data, final));
  return {
    add(name, bytes) {
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
    },
    end() {
      zip.end();
    },
    terminate() {
      zip.terminate();
    },
  };
}

function createDefaultAdapter(): PdfToImagesRendererAdapter {
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
        throw new PdfToImagesPipelineError(
          "WORKER_CRASH",
          "PDF 렌더러 버전을 확인하지 못했어요.",
          true,
        );
      }

      let parserPort: Worker | undefined;
      let pdfWorker: InstanceType<typeof PDFWorker> | undefined;
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
        let rejectParserFailure: (error: PdfToImagesPipelineError) => void = () => undefined;
        const parserFailure = new Promise<never>((_resolve, reject) => {
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
        const loadingTask = getDocument({
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
          maxImageSize: MAX_PDF_TO_IMAGE_PAGE_PIXELS,
          canvasMaxAreaInBytes: MAX_PDF_TO_IMAGE_PAGE_PIXELS * PDF_TO_IMAGE_RGBA_BYTES_PER_PIXEL,
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
          verbosity: VerbosityLevel.ERRORS,
          CanvasFactory,
          FilterFactory: WorkerFilterFactory,
        });

        return {
          loadingTask: loadingTask as unknown as PdfToImagesLoadingTask,
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
          pdfWorker?.destroy();
        } finally {
          parserPort?.terminate();
        }
        if (error instanceof PdfToImagesPipelineError) throw error;
        throw new PdfToImagesPipelineError("WORKER_CRASH", "PDF 렌더러를 시작하지 못했어요.", true);
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

function emitProgress(
  callback: PdfToImagesPipelineOptions["onProgress"],
  progress: PdfToImagesProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // Progress callbacks must never change the conversion outcome.
  }
}

function validateInput(input: PdfToImagesPipelineInput): void {
  const actualByteLength = input.bytes.byteLength;
  if (
    !Number.isSafeInteger(actualByteLength) ||
    actualByteLength < 1 ||
    actualByteLength > MAX_INPUT_BYTES
  ) {
    throw new PdfToImagesPipelineError(
      "MEMORY_LIMIT",
      "PDF 파일은 1바이트 이상 50MB 이하여야 해요.",
    );
  }
  if (input.byteLength !== actualByteLength) {
    throw new PdfToImagesPipelineError("CORRUPT_PDF", "PDF 파일 크기 정보를 확인할 수 없어요.");
  }
  const extensionIsPdf = /\.pdf$/i.test(input.name);
  const mimeIsPdf = input.mimeHint.trim().toLowerCase() === "application/pdf";
  if ((!extensionIsPdf && !mimeIsPdf) || !hasPdfSignature(input.bytes)) {
    throw new PdfToImagesPipelineError(
      "UNSUPPORTED_INPUT",
      "PDF 형식을 확인할 수 없는 파일이에요.",
    );
  }
}

function validateViewport(
  viewport: PdfToImagesViewport,
  planned: { width: number; height: number; pixels: number },
): {
  width: number;
  height: number;
  pixels: number;
} {
  const canonicalizeDimension = (actual: number, expected: number) => {
    const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(actual), expected);
    return Math.abs(actual - expected) <= tolerance ? expected : Math.ceil(actual);
  };
  const width = canonicalizeDimension(viewport.width, planned.width);
  const height = canonicalizeDimension(viewport.height, planned.height);
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width !== planned.width ||
    height !== planned.height ||
    width < 1 ||
    height < 1 ||
    width > MAX_PDF_TO_IMAGE_DIMENSION ||
    height > MAX_PDF_TO_IMAGE_DIMENSION
  ) {
    throw memoryLimit();
  }
  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels !== planned.pixels ||
    pixels > MAX_PDF_TO_IMAGE_PAGE_PIXELS
  ) {
    throw memoryLimit();
  }
  return { width, height, pixels };
}

function outputMime(format: "jpeg" | "png"): "image/jpeg" | "image/png" {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

function hasOutputSignature(bytes: ArrayBuffer, format: "jpeg" | "png"): boolean {
  const view = new Uint8Array(bytes);
  if (format === "jpeg") {
    return view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => view[index] === byte);
}

function concatenateChunks(chunks: readonly Uint8Array[], byteLength: number): ArrayBuffer {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

async function ignoreCleanup(
  cleanup: () => Promise<unknown> | unknown,
  parserFailure?: Promise<never>,
): Promise<void> {
  try {
    await raceParserFailure(Promise.resolve(cleanup()), parserFailure);
  } catch {
    // Cleanup is best-effort, and every independent resource still gets its turn.
  }
}

export async function runPdfToImagesPipeline(
  transferredInput: PdfToImagesPipelineInput,
  rawSpec: unknown,
  options: PdfToImagesPipelineOptions = {},
): Promise<PdfToImagesResult> {
  const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const totalStarted = now();
  const adapter = options.adapter ?? createDefaultAdapter();
  const budget = new WorkerCanvasBudget();
  let inputBytes: ArrayBuffer | undefined = transferredInput.bytes;
  let resources: PdfToImagesRendererResources | undefined;
  let parserFailure: Promise<never> | undefined;
  let document: PdfToImagesRendererDocument | undefined;
  let currentPage: PdfToImagesRendererPage | undefined;
  let currentCanvas: PdfToImagesCanvasResource | undefined;
  let activeRender: PdfToImagesRenderTask | undefined;
  let archive: PdfToImagesArchive | undefined;
  let archiveFinished = false;
  let archiveTerminated = false;
  let rejectPendingArchive: (() => void) | undefined;
  let cancelled = false;

  const terminateArchive = () => {
    if (archive === undefined || archiveFinished || archiveTerminated) return;
    archiveTerminated = true;
    try {
      archive.terminate();
    } catch {
      // The remaining cleanup path must continue even if the archive is already closed.
    }
  };
  const cancel = () => {
    cancelled = true;
    try {
      activeRender?.cancel();
    } catch {
      // Cancellation state still wins over a renderer cancellation exception.
    }
    terminateArchive();
    rejectPendingArchive?.();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const throwIfCancelled = () => {
    if (cancelled || options.signal?.aborted) throw new PdfToImagesCancellationError();
  };

  try {
    throwIfCancelled();
    emitProgress(options.onProgress, { phase: "validating", fraction: 0 });
    const parsed = pdfToImagesSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      throw new PdfToImagesPipelineError("INVALID_SPEC", "PDF 이미지 변환 설정이 올바르지 않아요.");
    }
    const spec = parsed.data;
    validateInput(transferredInput);
    throwIfCancelled();

    emitProgress(options.onProgress, { phase: "loading", fraction: 0.05 });
    const loadStarted = now();
    try {
      resources = await adapter.open(
        {
          name: transferredInput.name,
          mimeHint: transferredInput.mimeHint,
          byteLength: transferredInput.byteLength,
          bytes: inputBytes,
        },
        budget,
      );
    } catch (error) {
      throwIfCancelled();
      if (error instanceof PdfToImagesPipelineError) throw error;
      throw new PdfToImagesPipelineError("WORKER_CRASH", "PDF 렌더러를 시작하지 못했어요.", true);
    }
    throwIfCancelled();
    parserFailure = resources.parserFailure.catch((error: unknown): never => {
      throw normalizeParserFailure(error);
    });
    void parserFailure.catch(() => undefined);
    try {
      document = await raceParserFailure(resources.loadingTask.promise, parserFailure);
    } catch (error) {
      throwIfCancelled();
      if (hasCanvasMemoryMarker(error)) throw memoryLimit();
      if (error instanceof PdfToImagesPipelineError) throw error;
      const code = resources.classifyError(error) ?? "CORRUPT_PDF";
      throw new PdfToImagesPipelineError(
        code,
        code === "PASSWORD_PROTECTED"
          ? "암호로 잠긴 PDF는 아직 처리할 수 없어요."
          : "PDF 파일을 읽을 수 없어요. 다른 파일을 선택해 주세요.",
      );
    }
    throwIfCancelled();
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new PdfToImagesPipelineError("CORRUPT_PDF", "페이지가 없는 PDF는 처리할 수 없어요.");
    }
    if (document.numPages > MAX_SOURCE_PAGES) {
      throw new PdfToImagesPipelineError(
        "PAGE_LIMIT",
        `PDF는 최대 ${MAX_SOURCE_PAGES}페이지까지 처리할 수 있어요.`,
      );
    }

    const inspectionPages: PdfInspectionResult["pages"] extends readonly (infer Page)[]
      ? Page[]
      : never = [];
    try {
      for (let sourcePage = 1; sourcePage <= document.numPages; sourcePage += 1) {
        throwIfCancelled();
        currentPage = await raceParserFailure(document.getPage(sourcePage), parserFailure);
        try {
          const viewport = currentPage.getViewport({ scale: 1, rotation: 0 });
          inspectionPages.push({
            sourcePage,
            width: viewport.width,
            height: viewport.height,
            rotation: currentPage.rotate,
          });
        } finally {
          currentPage.cleanup();
          currentPage = undefined;
        }
      }
    } catch (error) {
      throwIfCancelled();
      if (error instanceof PdfToImagesPipelineError) throw error;
      if (hasCanvasMemoryMarker(error)) throw memoryLimit();
      throw new PdfToImagesPipelineError(
        resources.classifyError(error) ?? "CORRUPT_PDF",
        "PDF 페이지 정보를 읽을 수 없어요.",
      );
    }

    let plan: ReturnType<typeof planPdfToImagesRasterization>;
    try {
      plan = planPdfToImagesRasterization(
        { pageCount: document.numPages, pages: inspectionPages },
        spec,
      );
    } catch (error) {
      mapPlanError(error);
    }
    const loadMs = now() - loadStarted;
    throwIfCancelled();

    let archiveMs = 0;
    let archiveByteLength = 0;
    let archiveFailure: PdfToImagesPipelineError | undefined;
    const archiveChunks: Uint8Array[] = [];
    let resolveArchive: (bytes: ArrayBuffer) => void = () => undefined;
    let rejectArchive: (error: unknown) => void = () => undefined;
    const archiveResult = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveArchive = resolve;
      rejectArchive = reject;
    });
    void archiveResult.catch(() => undefined);
    const failArchive = (error: PdfToImagesPipelineError) => {
      if (archiveFailure !== undefined || archiveFinished) return;
      archiveFailure = error;
      terminateArchive();
      archiveChunks.length = 0;
      rejectArchive(error);
    };
    rejectPendingArchive = () => {
      if (archiveFinished || archiveFailure !== undefined) return;
      archiveChunks.length = 0;
      rejectArchive(new PdfToImagesCancellationError());
    };
    if (plan.pages.length > 1) {
      const archiveStarted = now();
      const onData: PdfToImagesArchiveOnData = (error, data, final) => {
        if (archiveFailure !== undefined || archiveFinished) return;
        if (error !== null && error !== undefined) {
          failArchive(new PdfToImagesPipelineError("ENCODE_FAILED", "ZIP 파일을 만들지 못했어요."));
          return;
        }
        const nextByteLength = archiveByteLength + data.byteLength;
        if (!Number.isSafeInteger(nextByteLength) || nextByteLength > MAX_OUTPUT_BYTES) {
          failArchive(memoryLimit());
          return;
        }
        archiveByteLength = nextByteLength;
        archiveChunks.push(data);
        if (final) {
          try {
            const bytes = concatenateChunks(archiveChunks, archiveByteLength);
            archiveFinished = true;
            archiveChunks.length = 0;
            resolveArchive(bytes);
          } catch {
            failArchive(memoryLimit());
          }
        }
      };
      try {
        archive = adapter.createArchive?.(onData) ?? createFflateArchive(onData);
      } catch (error) {
        throwArchiveFailure(error);
      }
      archiveMs += now() - archiveStarted;
      if (archiveFailure !== undefined) throw archiveFailure;
    }

    let renderMs = 0;
    let encodeMs = 0;
    let actualTotalPixels = 0;
    let directBytes: ArrayBuffer | undefined;
    const mime = outputMime(spec.output.format);

    for (const [index, plannedPage] of plan.pages.entries()) {
      throwIfCancelled();
      let encodedBytes: ArrayBuffer | undefined;
      try {
        try {
          currentPage = await raceParserFailure(
            document.getPage(plannedPage.sourcePage),
            parserFailure,
          );
          throwIfCancelled();
          const viewport = currentPage.getViewport({ scale: spec.dpi / 72 });
          const actual = validateViewport(viewport, plannedPage);
          const nextTotalPixels = actualTotalPixels + actual.pixels;
          if (
            !Number.isSafeInteger(nextTotalPixels) ||
            nextTotalPixels > MAX_PDF_TO_IMAGES_TOTAL_PIXELS
          ) {
            throw memoryLimit();
          }
          actualTotalPixels = nextTotalPixels;
          currentCanvas = adapter.createCanvas(actual.width, actual.height, budget);
          currentCanvas.context.fillStyle = "#ffffff";
          currentCanvas.context.fillRect(0, 0, actual.width, actual.height);

          const renderStarted = now();
          try {
            activeRender = currentPage.render({
              canvas: currentCanvas.canvas,
              viewport,
              background: "#ffffff",
            });
            await raceParserFailure(activeRender.promise, parserFailure);
            throwIfCancelled();
          } catch (error) {
            throwIfCancelled();
            if (hasCanvasMemoryMarker(error)) throw memoryLimit();
            if (error instanceof PdfToImagesPipelineError) {
              if (error.code === "WORKER_CRASH") {
                try {
                  activeRender?.cancel();
                } catch {
                  // The parser failure remains the terminal error.
                }
              }
              throw error;
            }
            throw new PdfToImagesPipelineError(
              "RENDER_FAILED",
              "PDF 페이지를 이미지로 그리지 못했어요.",
            );
          } finally {
            activeRender = undefined;
          }
          renderMs += now() - renderStarted;
          emitProgress(options.onProgress, {
            phase: "rendering",
            fraction: 0.1 + ((index + 0.5) / plan.pages.length) * 0.8,
            completedPages: index + 1,
            totalPages: plan.pages.length,
          });

          const encodeStarted = now();
          let blob: Blob;
          try {
            blob = await currentCanvas.canvas.convertToBlob(
              spec.output.format === "jpeg"
                ? { type: mime, quality: spec.output.quality / 100 }
                : { type: mime },
            );
          } catch (error) {
            throwIfCancelled();
            if (hasCanvasMemoryMarker(error)) throw memoryLimit();
            if (error instanceof PdfToImagesPipelineError) throw error;
            throw new PdfToImagesPipelineError("ENCODE_FAILED", "이미지 파일을 만들지 못했어요.");
          }
          throwIfCancelled();
          if (blob.type !== mime || blob.size < 1) {
            throw new PdfToImagesPipelineError(
              "ENCODE_FAILED",
              "요청한 이미지 형식으로 만들지 못했어요.",
            );
          }
          if (blob.size > MAX_OUTPUT_BYTES) throw memoryLimit();
          try {
            encodedBytes = await blob.arrayBuffer();
          } catch (error) {
            if (error instanceof PdfToImagesPipelineError) throw error;
            throw new PdfToImagesPipelineError("ENCODE_FAILED", "이미지 파일을 읽지 못했어요.");
          }
          throwIfCancelled();
          if (
            encodedBytes.byteLength !== blob.size ||
            !hasOutputSignature(encodedBytes, spec.output.format)
          ) {
            throw new PdfToImagesPipelineError(
              "ENCODE_FAILED",
              "이미지 파일 형식을 확인하지 못했어요.",
            );
          }
          encodeMs += now() - encodeStarted;
          emitProgress(options.onProgress, {
            phase: "encoding",
            fraction: 0.1 + ((index + 1) / plan.pages.length) * 0.8,
            completedPages: index + 1,
            totalPages: plan.pages.length,
          });

          if (archive === undefined) {
            directBytes = encodedBytes;
          } else {
            const archiveStarted = now();
            try {
              archive.add(
                pdfToImagePageName(
                  transferredInput.name,
                  plannedPage.sourcePage,
                  spec.output.format,
                ),
                new Uint8Array(encodedBytes),
              );
            } catch (error) {
              throwArchiveFailure(error);
            }
            archiveMs += now() - archiveStarted;
            if (archiveFailure !== undefined) throw archiveFailure;
          }
        } catch (error) {
          throwIfCancelled();
          if (hasCanvasMemoryMarker(error)) throw memoryLimit();
          if (error instanceof PdfToImagesPipelineError) throw error;
          throw new PdfToImagesPipelineError(
            "RENDER_FAILED",
            "PDF 페이지를 이미지로 그리지 못했어요.",
          );
        }
      } finally {
        encodedBytes = undefined;
        if (currentPage !== undefined) {
          try {
            currentPage.cleanup();
          } catch {
            // Loading-task cleanup remains responsible for any PDF.js residue.
          }
          currentPage = undefined;
        }
        if (currentCanvas !== undefined) {
          try {
            currentCanvas.destroy();
          } catch {
            // The shared budget is released by the concrete canvas owner.
          }
          currentCanvas = undefined;
        }
      }
    }

    let resultBytes: ArrayBuffer;
    let suggestedName: string;
    let resultMime: PdfToImagesResult["mime"];
    if (archive !== undefined) {
      emitProgress(options.onProgress, { phase: "archiving", fraction: 0.95 });
      const archiveStarted = now();
      try {
        archive.end();
      } catch (error) {
        throwArchiveFailure(error);
      }
      resultBytes = await archiveResult;
      archiveMs += now() - archiveStarted;
      suggestedName = pdfToImagesArchiveName(transferredInput.name);
      resultMime = "application/zip";
    } else {
      if (directBytes === undefined) {
        throw new PdfToImagesPipelineError("ENCODE_FAILED", "이미지 결과를 만들지 못했어요.");
      }
      resultBytes = directBytes;
      suggestedName = pdfToImagePageName(
        transferredInput.name,
        plan.pages[0]?.sourcePage ?? 1,
        spec.output.format,
      );
      resultMime = mime;
    }
    throwIfCancelled();
    if (resultBytes.byteLength > MAX_OUTPUT_BYTES) throw memoryLimit();
    emitProgress(options.onProgress, { phase: "finalizing", fraction: 1 });

    return {
      bytes: resultBytes,
      suggestedName,
      mime: resultMime,
      byteLength: resultBytes.byteLength,
      sourcePageCount: document.numPages,
      outputPageCount: plan.pages.length,
      outputFileCount: plan.pages.length,
      format: spec.output.format,
      warnings: ["PDF_PAGE_RASTERIZED", "COLOR_PROFILE_NORMALIZED"],
      timing: {
        loadMs,
        renderMs,
        encodeMs,
        archiveMs,
        totalMs: now() - totalStarted,
      },
    };
  } catch (error) {
    if (cancelled || options.signal?.aborted || error instanceof PdfToImagesCancellationError) {
      throw new PdfToImagesCancellationError();
    }
    if (hasCanvasMemoryMarker(error)) throw memoryLimit();
    if (error instanceof PdfToImagesPipelineError) throw error;
    throw new PdfToImagesPipelineError(
      "WORKER_CRASH",
      "PDF 이미지 변환 작업을 완료하지 못했어요.",
      true,
    );
  } finally {
    if (activeRender !== undefined) {
      try {
        activeRender.cancel();
      } catch {
        // Continue releasing every remaining resource.
      }
      activeRender = undefined;
    }
    terminateArchive();
    if (currentPage !== undefined) {
      try {
        currentPage.cleanup();
      } catch {
        // Continue cleanup.
      }
      currentPage = undefined;
    }
    if (currentCanvas !== undefined) {
      try {
        currentCanvas.destroy();
      } catch {
        // Continue cleanup.
      }
      currentCanvas = undefined;
    }
    if (document !== undefined) {
      await ignoreCleanup(() => document?.cleanup(), parserFailure);
      document = undefined;
    }
    if (resources !== undefined) {
      await ignoreCleanup(() => resources?.loadingTask.destroy(), parserFailure);
      await ignoreCleanup(() => resources?.pdfWorker.destroy(), parserFailure);
      try {
        resources.removeParserFailureListeners();
      } catch {
        // Parser-port termination must still run.
      }
      await ignoreCleanup(() => resources?.parserPort.terminate());
      resources = undefined;
    }
    parserFailure = undefined;
    inputBytes = undefined;
    rejectPendingArchive = undefined;
    options.signal?.removeEventListener("abort", cancel);
  }
}

export function toPdfToImagesErrorPayload(error: unknown): PdfToImagesErrorPayload {
  if (error instanceof PdfToImagesPipelineError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "WORKER_CRASH",
    message: "PDF 이미지 변환 작업을 완료하지 못했어요.",
    retryable: true,
  };
}
