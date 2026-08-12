import { PDFDocument } from "@cantoo/pdf-lib";
import {
  calculatePdfCompressScannedTarget,
  classifyPdfCompressionDocument,
  compressedPdfName,
  hasCompletePdfEnvelope,
  hasPdfSignature,
  MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES,
  MAX_PDF_COMPRESS_SCANNED_PAGES,
  type PdfCompressionPageSignals,
  PdfCompressScannedPlanError,
  planPdfCompressScannedRasterization,
} from "@hereisit/pdf-tool";
import {
  type PdfCompressScannedErrorCode,
  type PdfCompressScannedErrorPayload,
  type PdfCompressScannedNoSizeReductionReason,
  type PdfCompressScannedProgress,
  type PdfCompressScannedResult,
  type PdfCompressScannedResultV1,
  type PdfCompressScannedResultV2,
  type PdfCompressScannedRunRequest,
  type PdfCompressScannedSpecV1,
  type PdfCompressScannedSpecV2,
  pdfCompressScannedSpecSchema,
} from "@hereisit/tool-contracts";
import {
  inspectPdfRasterPage,
  isPdfRasterMemoryError,
  openPdfRasterSession,
  type PdfRasterRendererAdapter,
  PdfRasterRuntimeError,
  type PdfRasterSession,
  type PdfRasterViewport,
} from "./pdf-raster-runtime";

const MEMORY_LIMIT_MESSAGE =
  "선택한 설정에서 PDF 페이지의 전체 이미지 크기가 너무 커요. 더 낮은 해상도를 선택해 주세요.";
const PAGE_LIMIT_MESSAGE = `PDF는 1페이지부터 ${MAX_PDF_COMPRESS_SCANNED_PAGES}페이지까지 압축할 수 있어요.`;
const WORKER_CRASH_MESSAGE = "PDF 압축 작업을 완료하지 못했어요.";
const ASSEMBLY_FAILED_MESSAGE = "압축 PDF 결과를 만들지 못했어요.";
const NO_SIZE_REDUCTION_MESSAGE = "원본보다 1% 이상 작은 PDF를 만들지 못했어요.";

const WARNINGS = [
  "PDF_PAGES_RASTERIZED",
  "SEARCHABLE_CONTENT_REMOVED",
  "INTERACTIVE_CONTENT_REMOVED",
  "SIGNATURES_INVALIDATED",
  "COLOR_PROFILE_NORMALIZED",
] as const;

export interface PdfCompressScannedAssembler {
  readonly pageCount: number;
  addJpegPage(input: {
    bytes: ArrayBuffer;
    widthPoints: number;
    heightPoints: number;
  }): Promise<void>;
  serialize(): Promise<ArrayBuffer>;
  destroy(): void;
}

export interface PdfCompressScannedAssemblerFactory {
  create(): Promise<PdfCompressScannedAssembler>;
}

export interface PdfStructureCompressionCandidate {
  readonly bytes: ArrayBuffer;
  readonly pageCount: number;
  readonly loadMs: number;
  readonly serializeMs: number;
}

export interface PdfStructureOptimizer {
  optimize(input: {
    bytes: ArrayBuffer;
    targetBytes: number;
  }): Promise<PdfStructureCompressionCandidate | undefined>;
}

export interface PdfCompressScannedPipelineOptions {
  rasterAdapter?: PdfRasterRendererAdapter;
  assemblerFactory?: PdfCompressScannedAssemblerFactory;
  structureOptimizer?: PdfStructureOptimizer;
  onProgress?: (progress: PdfCompressScannedProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export class PdfCompressScannedPipelineError extends Error {
  constructor(
    readonly code: PdfCompressScannedErrorCode,
    message: string,
    readonly retryable = false,
    readonly reason?: PdfCompressScannedNoSizeReductionReason,
  ) {
    super(message);
    this.name = "PdfCompressScannedPipelineError";
  }
}

class PdfCompressScannedCancellationError extends Error {
  constructor() {
    super("Scanned PDF compression was cancelled.");
    this.name = "AbortError";
  }
}

function fail(code: PdfCompressScannedErrorCode, message: string, retryable = false): never {
  throw new PdfCompressScannedPipelineError(code, message, retryable);
}

function memoryLimit(): PdfCompressScannedPipelineError {
  return new PdfCompressScannedPipelineError("MEMORY_LIMIT", MEMORY_LIMIT_MESSAGE);
}

function noSizeReduction(
  reason: PdfCompressScannedNoSizeReductionReason = "IMAGE_ONLY_NO_SAVINGS",
): PdfCompressScannedPipelineError {
  return new PdfCompressScannedPipelineError(
    "NO_SIZE_REDUCTION",
    NO_SIZE_REDUCTION_MESSAGE,
    false,
    reason,
  );
}

function assemblyFailed(): PdfCompressScannedPipelineError {
  return new PdfCompressScannedPipelineError("ASSEMBLY_FAILED", ASSEMBLY_FAILED_MESSAGE);
}

function encodeFailed(message = "PDF 페이지 이미지를 만들지 못했어요.") {
  return new PdfCompressScannedPipelineError("ENCODE_FAILED", message);
}

function emitProgress(
  callback: PdfCompressScannedPipelineOptions["onProgress"],
  progress: PdfCompressScannedProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // Progress observers are outside the compression outcome.
  }
}

function mapRasterError(error: PdfRasterRuntimeError): PdfCompressScannedPipelineError {
  switch (error.code) {
    case "PASSWORD_PROTECTED":
      return new PdfCompressScannedPipelineError(
        "PASSWORD_PROTECTED",
        "암호로 잠긴 PDF는 아직 처리할 수 없어요.",
      );
    case "CORRUPT_PDF":
      return new PdfCompressScannedPipelineError(
        "CORRUPT_PDF",
        "PDF 파일을 읽을 수 없어요. 다른 파일을 선택해 주세요.",
      );
    case "MEMORY_LIMIT":
      return memoryLimit();
    case "RENDER_FAILED":
      return new PdfCompressScannedPipelineError(
        "RENDER_FAILED",
        "PDF 페이지를 이미지로 그리지 못했어요.",
      );
    case "WORKER_CRASH":
      return new PdfCompressScannedPipelineError(
        "WORKER_CRASH",
        WORKER_CRASH_MESSAGE,
        error.retryable,
      );
  }
}

function mapPlanError(error: unknown): never {
  if (error instanceof PdfCompressScannedPlanError) {
    throw new PdfCompressScannedPipelineError(error.code, error.message);
  }
  throw error;
}

function validateInput(input: PdfCompressScannedRunRequest["input"]): void {
  if (!(input.bytes instanceof ArrayBuffer)) {
    fail("CORRUPT_PDF", "PDF 파일 크기 정보를 확인할 수 없어요.");
  }
  const actualByteLength = input.bytes.byteLength;
  if (
    !Number.isSafeInteger(actualByteLength) ||
    actualByteLength < 1 ||
    actualByteLength > MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES
  ) {
    fail("MEMORY_LIMIT", "PDF 파일은 1바이트 이상 50MB 이하여야 해요.");
  }
  if (input.byteLength !== actualByteLength) {
    fail("CORRUPT_PDF", "PDF 파일 크기 정보를 확인할 수 없어요.");
  }
  const extensionIsPdf = typeof input.name === "string" && /\.pdf$/i.test(input.name);
  const mimeIsPdf =
    typeof input.mimeHint === "string" && input.mimeHint.trim().toLowerCase() === "application/pdf";
  if ((!extensionIsPdf && !mimeIsPdf) || !hasPdfSignature(input.bytes)) {
    fail("UNSUPPORTED_INPUT", "PDF 형식을 확인할 수 없는 파일이에요.");
  }
}

function validateVisibleViewport(viewport: PdfRasterViewport): {
  widthPoints: number;
  heightPoints: number;
} {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw memoryLimit();
  }
  return { widthPoints: viewport.width, heightPoints: viewport.height };
}

function validateRasterViewport(
  viewport: PdfRasterViewport,
  planned: { width: number; height: number },
): void {
  const matchesPlannedDimension = (actual: number, plannedDimension: number) => {
    if (!Number.isFinite(actual) || actual <= 0) return false;
    const rounded = Math.ceil(actual);
    if (!Number.isSafeInteger(rounded) || !Number.isSafeInteger(plannedDimension)) return false;
    if (rounded === plannedDimension) return true;
    return (
      actual > plannedDimension &&
      actual - plannedDimension <=
        Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(plannedDimension)) * 8
    );
  };

  if (
    planned.width < 1 ||
    planned.height < 1 ||
    !matchesPlannedDimension(viewport.width, planned.width) ||
    !matchesPlannedDimension(viewport.height, planned.height)
  )
    throw memoryLimit();
}

function hasJpegSignature(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 3));
  return view.length === 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
}

function pageProgress(
  phase: "rendering" | "encoding" | "assembling",
  pageIndex: number,
  pageCount: number,
): PdfCompressScannedProgress {
  const stage = phase === "rendering" ? 1 : phase === "encoding" ? 2 : 3;
  return {
    phase,
    fraction: 0.1 + ((pageIndex * 3 + stage) / (pageCount * 3)) * 0.8,
    completedPages: pageIndex + 1,
    totalPages: pageCount,
  };
}

async function createDefaultAssembler(): Promise<PdfCompressScannedAssembler> {
  let document: PDFDocument | undefined = await PDFDocument.create({ updateMetadata: false });
  document.setCreator("HereIsIt");
  document.setProducer("HereIsIt");
  return {
    get pageCount() {
      return document?.getPageCount() ?? 0;
    },
    async addJpegPage({ bytes, widthPoints, heightPoints }) {
      if (document === undefined) throw new Error("ASSEMBLER_DESTROYED");
      const image = await document.embedJpg(new Uint8Array(bytes));
      const page = document.addPage([widthPoints, heightPoints]);
      page.drawImage(image, { x: 0, y: 0, width: widthPoints, height: heightPoints });
    },
    async serialize() {
      if (document === undefined) throw new Error("ASSEMBLER_DESTROYED");
      const saved = await document.save({
        useObjectStreams: true,
        addDefaultPage: false,
        objectsPerTick: 50,
        updateFieldAppearances: false,
      });
      if (
        !(saved.buffer instanceof ArrayBuffer) ||
        saved.byteOffset !== 0 ||
        saved.byteLength !== saved.buffer.byteLength
      ) {
        throw new Error("NON_EXACT_SERIALIZATION_BUFFER");
      }
      return saved.buffer;
    },
    destroy() {
      document = undefined;
    },
  };
}

const DEFAULT_ASSEMBLER_FACTORY: PdfCompressScannedAssemblerFactory = {
  create: createDefaultAssembler,
};

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

function createDefaultStructureOptimizer(now: () => number): PdfStructureOptimizer {
  return {
    async optimize({ bytes, targetBytes }) {
      let document: PDFDocument;
      const loadStarted = now();
      try {
        document = await PDFDocument.load(new Uint8Array(bytes), {
          updateMetadata: false,
          throwOnInvalidObject: true,
        });
      } catch {
        return undefined;
      }
      const loadMs = now() - loadStarted;
      const pageCount = document.getPageCount();
      if (pageCount < 1 || pageCount > MAX_PDF_COMPRESS_SCANNED_PAGES) return undefined;

      const serializeStarted = now();
      let serialized: Uint8Array;
      try {
        serialized = await document.save({
          useObjectStreams: true,
          addDefaultPage: false,
          objectsPerTick: 50,
          updateFieldAppearances: false,
        });
      } catch {
        return undefined;
      }
      const serializeMs = now() - serializeStarted;
      const candidate = ownedArrayBuffer(serialized);
      if (candidate.byteLength > targetBytes || !hasCompletePdfEnvelope(candidate))
        return undefined;
      return { bytes: candidate, pageCount, loadMs, serializeMs };
    },
  };
}

export function runPdfCompressScannedPipeline(
  transferredInput: PdfCompressScannedRunRequest["input"],
  rawSpec: PdfCompressScannedSpecV1,
  options?: PdfCompressScannedPipelineOptions,
): Promise<PdfCompressScannedResultV1>;
export function runPdfCompressScannedPipeline(
  transferredInput: PdfCompressScannedRunRequest["input"],
  rawSpec: PdfCompressScannedSpecV2,
  options?: PdfCompressScannedPipelineOptions,
): Promise<PdfCompressScannedResultV2>;
export function runPdfCompressScannedPipeline(
  transferredInput: PdfCompressScannedRunRequest["input"],
  rawSpec: unknown,
  options?: PdfCompressScannedPipelineOptions,
): Promise<PdfCompressScannedResult>;

export async function runPdfCompressScannedPipeline(
  transferredInput: PdfCompressScannedRunRequest["input"],
  rawSpec: unknown,
  options: PdfCompressScannedPipelineOptions = {},
): Promise<PdfCompressScannedResult> {
  const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const totalStarted = now();
  let inputBytes: ArrayBuffer | undefined = transferredInput.bytes;
  let currentJpegBytes: ArrayBuffer | undefined;
  let candidateBytes: ArrayBuffer | undefined;
  let session: PdfRasterSession | undefined;
  let assembler: PdfCompressScannedAssembler | undefined;

  let loadMs = 0;
  let renderMs = 0;
  let encodeMs = 0;
  let assembleMs = 0;
  let serializeMs = 0;

  const throwIfCancelled = () => {
    if (options.signal?.aborted) throw new PdfCompressScannedCancellationError();
  };

  try {
    throwIfCancelled();
    emitProgress(options.onProgress, { phase: "validating", fraction: 0 });
    const parsed = pdfCompressScannedSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      return fail("INVALID_SPEC", "PDF 압축 설정이 올바르지 않아요.");
    }
    validateInput(transferredInput);
    const { targetBytes } = calculatePdfCompressScannedTarget(transferredInput.byteLength);
    throwIfCancelled();

    emitProgress(options.onProgress, { phase: "loading", fraction: 0.05 });
    if (parsed.data.version === 2) {
      let structuralCandidate: PdfStructureCompressionCandidate | undefined;
      try {
        structuralCandidate = await (
          options.structureOptimizer ?? createDefaultStructureOptimizer(now)
        ).optimize({ bytes: inputBytes, targetBytes });
      } catch {
        structuralCandidate = undefined;
      }
      throwIfCancelled();
      if (
        structuralCandidate !== undefined &&
        structuralCandidate.pageCount >= 1 &&
        structuralCandidate.pageCount <= MAX_PDF_COMPRESS_SCANNED_PAGES &&
        structuralCandidate.bytes instanceof ArrayBuffer &&
        structuralCandidate.bytes.byteLength <= targetBytes &&
        hasCompletePdfEnvelope(structuralCandidate.bytes)
      ) {
        emitProgress(options.onProgress, { phase: "finalizing", fraction: 1 });
        return {
          bytes: structuralCandidate.bytes,
          suggestedName: compressedPdfName(transferredInput.name),
          mime: "application/pdf",
          sourceByteLength: transferredInput.byteLength,
          byteLength: structuralCandidate.bytes.byteLength,
          pageCount: structuralCandidate.pageCount,
          mode: "structure-preserving",
          warnings: ["SIGNATURES_INVALIDATED"],
          timing: {
            loadMs: structuralCandidate.loadMs,
            renderMs: 0,
            encodeMs: 0,
            assembleMs: 0,
            serializeMs: structuralCandidate.serializeMs,
            totalMs: now() - totalStarted,
          },
        };
      }
    }
    const loadStarted = now();
    try {
      session = await openPdfRasterSession(
        { bytes: inputBytes },
        {
          ...(options.rasterAdapter === undefined ? {} : { adapter: options.rasterAdapter }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      throwIfCancelled();
      if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
      throw new PdfCompressScannedPipelineError(
        "WORKER_CRASH",
        "PDF 렌더러를 시작하지 못했어요.",
        true,
      );
    }
    throwIfCancelled();
    const rasterSession = session;
    if (rasterSession === undefined) {
      throw new PdfCompressScannedPipelineError(
        "WORKER_CRASH",
        "PDF 렌더러를 시작하지 못했어요.",
        true,
      );
    }
    if (
      !Number.isSafeInteger(rasterSession.pageCount) ||
      rasterSession.pageCount < 1 ||
      rasterSession.pageCount > MAX_PDF_COMPRESS_SCANNED_PAGES
    ) {
      return fail("PAGE_LIMIT", PAGE_LIMIT_MESSAGE);
    }

    const visiblePages: Array<{ widthPoints: number; heightPoints: number }> = [];
    const pageSignals: PdfCompressionPageSignals[] = [];
    try {
      for (let sourcePage = 1; sourcePage <= rasterSession.pageCount; sourcePage += 1) {
        throwIfCancelled();
        await rasterSession.withPage(sourcePage, async (page) => {
          const viewport = page.getViewport({ scale: 1 });
          visiblePages.push(validateVisibleViewport(viewport));
          if (parsed.data.version === 2) pageSignals.push(await inspectPdfRasterPage(page));
        });
      }
    } catch (error) {
      throwIfCancelled();
      if (error instanceof PdfCompressScannedPipelineError) throw error;
      if (isPdfRasterMemoryError(error)) throw memoryLimit();
      if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
      throw new PdfCompressScannedPipelineError("CORRUPT_PDF", "PDF 페이지 정보를 읽을 수 없어요.");
    }

    let plan: ReturnType<typeof planPdfCompressScannedRasterization>;
    try {
      plan = planPdfCompressScannedRasterization(visiblePages, parsed.data.preset);
    } catch (error) {
      mapPlanError(error);
    }
    loadMs = now() - loadStarted;
    throwIfCancelled();
    if (parsed.data.version === 2 && classifyPdfCompressionDocument(pageSignals) !== "image-only") {
      throw noSizeReduction("STRUCTURED_OR_MIXED");
    }

    try {
      assembler = await (options.assemblerFactory ?? DEFAULT_ASSEMBLER_FACTORY).create();
    } catch {
      throw assemblyFailed();
    }
    throwIfCancelled();
    const outputAssembler = assembler;
    if (outputAssembler === undefined) throw assemblyFailed();

    let cumulativeJpegBytes = 0;
    for (const [pageIndex, plannedPage] of plan.pages.entries()) {
      throwIfCancelled();
      try {
        await rasterSession.withPage(plannedPage.sourcePage, async (page) => {
          throwIfCancelled();
          let viewport: PdfRasterViewport;
          try {
            viewport = page.getViewport({ scale: plan.dpi / 72 });
            validateRasterViewport(viewport, plannedPage);
          } catch (error) {
            if (error instanceof PdfCompressScannedPipelineError) throw error;
            if (isPdfRasterMemoryError(error)) throw memoryLimit();
            if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
            throw new PdfCompressScannedPipelineError(
              "RENDER_FAILED",
              "PDF 페이지 크기를 확인하지 못했어요.",
            );
          }

          try {
            await rasterSession.withCanvas(
              plannedPage.width,
              plannedPage.height,
              async (canvas) => {
                canvas.context.fillStyle = plan.background;
                canvas.context.fillRect(0, 0, plannedPage.width, plannedPage.height);

                const renderStarted = now();
                try {
                  await rasterSession.render(page, canvas, viewport, plan.background);
                  throwIfCancelled();
                } catch (error) {
                  throwIfCancelled();
                  if (isPdfRasterMemoryError(error)) throw memoryLimit();
                  if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
                  if (error instanceof PdfCompressScannedPipelineError) throw error;
                  throw new PdfCompressScannedPipelineError(
                    "RENDER_FAILED",
                    "PDF 페이지를 이미지로 그리지 못했어요.",
                  );
                } finally {
                  renderMs += now() - renderStarted;
                }
                emitProgress(
                  options.onProgress,
                  pageProgress("rendering", pageIndex, plan.pages.length),
                );
                throwIfCancelled();

                const encodeStarted = now();
                try {
                  let blob: Blob;
                  try {
                    blob = await canvas.canvas.convertToBlob({
                      type: "image/jpeg",
                      quality: plan.quality / 100,
                    });
                  } catch (error) {
                    throwIfCancelled();
                    if (isPdfRasterMemoryError(error)) throw memoryLimit();
                    if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
                    if (error instanceof PdfCompressScannedPipelineError) throw error;
                    throw encodeFailed();
                  }
                  throwIfCancelled();
                  if (
                    blob.type !== "image/jpeg" ||
                    !Number.isSafeInteger(blob.size) ||
                    blob.size < 1
                  ) {
                    throw encodeFailed("요청한 JPEG 형식으로 만들지 못했어요.");
                  }

                  const remainingTarget = targetBytes - cumulativeJpegBytes;
                  if (!Number.isSafeInteger(remainingTarget) || remainingTarget < 1) {
                    throw noSizeReduction();
                  }
                  if (blob.size > remainingTarget) throw noSizeReduction();

                  try {
                    currentJpegBytes = await blob.arrayBuffer();
                  } catch (error) {
                    if (isPdfRasterMemoryError(error)) throw memoryLimit();
                    if (error instanceof PdfCompressScannedPipelineError) throw error;
                    throw encodeFailed("JPEG 이미지 데이터를 읽지 못했어요.");
                  }
                  throwIfCancelled();
                  if (!(currentJpegBytes instanceof ArrayBuffer)) {
                    throw encodeFailed("JPEG 이미지 데이터를 확인하지 못했어요.");
                  }
                  const actualByteLength = currentJpegBytes.byteLength;
                  if (actualByteLength > remainingTarget) throw noSizeReduction();
                  if (actualByteLength !== blob.size) {
                    throw encodeFailed("JPEG 이미지 크기 정보를 확인하지 못했어요.");
                  }
                  const nextCumulativeJpegBytes = cumulativeJpegBytes + actualByteLength;
                  if (
                    !Number.isSafeInteger(nextCumulativeJpegBytes) ||
                    nextCumulativeJpegBytes > targetBytes
                  ) {
                    throw noSizeReduction();
                  }
                  if (!hasJpegSignature(currentJpegBytes)) {
                    throw encodeFailed("JPEG 이미지 형식을 확인하지 못했어요.");
                  }
                  cumulativeJpegBytes = nextCumulativeJpegBytes;
                } finally {
                  encodeMs += now() - encodeStarted;
                }
                emitProgress(
                  options.onProgress,
                  pageProgress("encoding", pageIndex, plan.pages.length),
                );
                throwIfCancelled();

                const assembleStarted = now();
                try {
                  if (currentJpegBytes === undefined) throw assemblyFailed();
                  await outputAssembler.addJpegPage({
                    bytes: currentJpegBytes,
                    widthPoints: plannedPage.widthPoints,
                    heightPoints: plannedPage.heightPoints,
                  });
                } catch (error) {
                  if (error instanceof PdfCompressScannedPipelineError) throw error;
                  throw assemblyFailed();
                } finally {
                  assembleMs += now() - assembleStarted;
                }
                currentJpegBytes = undefined;
                emitProgress(
                  options.onProgress,
                  pageProgress("assembling", pageIndex, plan.pages.length),
                );
                throwIfCancelled();
              },
            );
          } catch (error) {
            if (error instanceof PdfCompressScannedPipelineError) throw error;
            if (isPdfRasterMemoryError(error)) throw memoryLimit();
            if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
            throw memoryLimit();
          }
        });
      } catch (error) {
        throwIfCancelled();
        if (error instanceof PdfCompressScannedPipelineError) throw error;
        if (isPdfRasterMemoryError(error)) throw memoryLimit();
        if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
        throw new PdfCompressScannedPipelineError(
          "RENDER_FAILED",
          "PDF 페이지를 처리하지 못했어요.",
        );
      } finally {
        currentJpegBytes = undefined;
      }
    }

    emitProgress(options.onProgress, { phase: "serializing", fraction: 0.95 });
    throwIfCancelled();
    const serializeStarted = now();
    try {
      candidateBytes = await outputAssembler.serialize();
    } catch {
      throw assemblyFailed();
    } finally {
      serializeMs += now() - serializeStarted;
    }
    throwIfCancelled();
    let candidateIsValid = false;
    try {
      candidateIsValid =
        outputAssembler.pageCount === plan.pages.length &&
        candidateBytes instanceof ArrayBuffer &&
        hasCompletePdfEnvelope(candidateBytes);
    } catch {
      throw assemblyFailed();
    }
    if (!candidateIsValid) throw assemblyFailed();
    if (candidateBytes.byteLength > targetBytes) throw noSizeReduction();

    const resultBytes = candidateBytes;
    emitProgress(options.onProgress, { phase: "finalizing", fraction: 1 });
    const rasterResult: PdfCompressScannedResultV1 = {
      bytes: resultBytes,
      suggestedName: compressedPdfName(transferredInput.name),
      mime: "application/pdf",
      sourceByteLength: transferredInput.byteLength,
      byteLength: resultBytes.byteLength,
      pageCount: plan.pages.length,
      preset: plan.preset,
      dpi: plan.dpi,
      quality: plan.quality,
      warnings: [...WARNINGS],
      timing: {
        loadMs,
        renderMs,
        encodeMs,
        assembleMs,
        serializeMs,
        totalMs: now() - totalStarted,
      },
    };
    return parsed.data.version === 2
      ? { ...rasterResult, mode: "rasterized" as const }
      : rasterResult;
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new PdfCompressScannedCancellationError();
    }
    if (error instanceof PdfCompressScannedPipelineError) throw error;
    if (isPdfRasterMemoryError(error)) throw memoryLimit();
    if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
    throw new PdfCompressScannedPipelineError("WORKER_CRASH", WORKER_CRASH_MESSAGE, true);
  } finally {
    currentJpegBytes = undefined;
    candidateBytes = undefined;
    inputBytes = undefined;
    if (assembler !== undefined) {
      try {
        assembler.destroy();
      } catch {
        // Session cleanup still owns independent raster resources.
      }
      assembler = undefined;
    }
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        // A terminal result or bounded failure must not be replaced by cleanup details.
      }
      session = undefined;
    }
  }
}

export function toPdfCompressScannedErrorPayload(error: unknown): PdfCompressScannedErrorPayload {
  if (error instanceof PdfCompressScannedPipelineError) {
    if (error.code === "NO_SIZE_REDUCTION" && error.reason !== undefined) {
      return {
        code: error.code,
        message: error.message,
        reason: error.reason,
        retryable: error.retryable,
      };
    }
    if (error.code === "NO_SIZE_REDUCTION") {
      return { code: "WORKER_CRASH", message: WORKER_CRASH_MESSAGE, retryable: true };
    }
    return {
      code: error.code,
      message: error.code === "WORKER_CRASH" ? WORKER_CRASH_MESSAGE : error.message,
      retryable: error.retryable,
    };
  }
  return { code: "WORKER_CRASH", message: WORKER_CRASH_MESSAGE, retryable: true };
}
