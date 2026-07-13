import {
  hasPdfSignature,
  MAX_PDF_TO_IMAGE_DIMENSION,
  MAX_PDF_TO_IMAGE_PAGE_PIXELS,
  MAX_PDF_TO_IMAGES_TOTAL_PIXELS,
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
import {
  isPdfRasterMemoryError,
  openPdfRasterSession,
  type PdfRasterCanvasResource,
  type PdfRasterLoadingTask,
  type PdfRasterRendererAdapter,
  type PdfRasterRendererDocument,
  type PdfRasterRendererPage,
  type PdfRasterRendererResources,
  PdfRasterRuntimeError,
  type PdfRasterSession,
  type PdfRasterViewport,
} from "./pdf-raster-runtime";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_PAGES = 500;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
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

export type PdfToImagesViewport = PdfRasterViewport;
export type PdfToImagesRendererPage = PdfRasterRendererPage;
export type PdfToImagesRendererDocument = PdfRasterRendererDocument;
export type PdfToImagesLoadingTask = PdfRasterLoadingTask;
export type PdfToImagesRendererResources = PdfRasterRendererResources;
export type PdfToImagesCanvasResource = PdfRasterCanvasResource;

export type PdfToImagesArchiveOnData = (error: unknown, data: Uint8Array, final: boolean) => void;

export interface PdfToImagesArchive {
  add(name: string, bytes: Uint8Array): void;
  end(): void;
  terminate(): void;
}

export interface PdfToImagesRendererAdapter extends PdfRasterRendererAdapter {
  createArchive?: (onData: PdfToImagesArchiveOnData) => PdfToImagesArchive;
}

function memoryLimit(): PdfToImagesPipelineError {
  return new PdfToImagesPipelineError("MEMORY_LIMIT", MEMORY_LIMIT_MESSAGE);
}

function mapRasterError(error: PdfRasterRuntimeError): PdfToImagesPipelineError {
  switch (error.code) {
    case "PASSWORD_PROTECTED":
      return new PdfToImagesPipelineError(
        "PASSWORD_PROTECTED",
        "암호로 잠긴 PDF는 아직 처리할 수 없어요.",
      );
    case "CORRUPT_PDF":
      return new PdfToImagesPipelineError(
        "CORRUPT_PDF",
        "PDF 파일을 읽을 수 없어요. 다른 파일을 선택해 주세요.",
      );
    case "MEMORY_LIMIT":
      return memoryLimit();
    case "RENDER_FAILED":
      return new PdfToImagesPipelineError(
        "RENDER_FAILED",
        "PDF 페이지를 이미지로 그리지 못했어요.",
      );
    case "WORKER_CRASH":
      return new PdfToImagesPipelineError(
        "WORKER_CRASH",
        error.message || PARSER_WORKER_FAILURE_MESSAGE,
        error.retryable,
      );
  }
}

function throwArchiveFailure(error: unknown): never {
  if (isPdfRasterMemoryError(error)) throw memoryLimit();
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

export async function runPdfToImagesPipeline(
  transferredInput: PdfToImagesPipelineInput,
  rawSpec: unknown,
  options: PdfToImagesPipelineOptions = {},
): Promise<PdfToImagesResult> {
  const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const totalStarted = now();
  const adapter = options.adapter;
  let inputBytes: ArrayBuffer | undefined = transferredInput.bytes;
  let session: PdfRasterSession | undefined;
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
      session = await openPdfRasterSession(
        { bytes: inputBytes as ArrayBuffer },
        {
          ...(adapter === undefined ? {} : { adapter }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      throwIfCancelled();
      if (error instanceof PdfToImagesPipelineError) throw error;
      if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
      throw new PdfToImagesPipelineError("WORKER_CRASH", "PDF 렌더러를 시작하지 못했어요.", true);
    }
    throwIfCancelled();
    const rasterSession = session;
    if (rasterSession === undefined) {
      throw new PdfToImagesPipelineError("WORKER_CRASH", "PDF 렌더러를 시작하지 못했어요.", true);
    }
    if (!Number.isSafeInteger(rasterSession.pageCount) || rasterSession.pageCount < 1) {
      throw new PdfToImagesPipelineError("CORRUPT_PDF", "페이지가 없는 PDF는 처리할 수 없어요.");
    }
    if (rasterSession.pageCount > MAX_SOURCE_PAGES) {
      throw new PdfToImagesPipelineError(
        "PAGE_LIMIT",
        `PDF는 최대 ${MAX_SOURCE_PAGES}페이지까지 처리할 수 있어요.`,
      );
    }

    const inspectionPages: PdfInspectionResult["pages"] extends readonly (infer Page)[]
      ? Page[]
      : never = [];
    try {
      for (let sourcePage = 1; sourcePage <= rasterSession.pageCount; sourcePage += 1) {
        throwIfCancelled();
        await rasterSession.withPage(sourcePage, (page) => {
          const viewport = page.getViewport({ scale: 1, rotation: 0 });
          inspectionPages.push({
            sourcePage,
            width: viewport.width,
            height: viewport.height,
            rotation: page.rotate,
          });
        });
      }
    } catch (error) {
      throwIfCancelled();
      if (error instanceof PdfToImagesPipelineError) throw error;
      if (isPdfRasterMemoryError(error)) throw memoryLimit();
      if (error instanceof PdfRasterRuntimeError) {
        if (error.code === "MEMORY_LIMIT") throw memoryLimit();
        if (error.code === "WORKER_CRASH") throw mapRasterError(error);
      }
      throw new PdfToImagesPipelineError(
        error instanceof PdfRasterRuntimeError ? error.code : "CORRUPT_PDF",
        "PDF 페이지 정보를 읽을 수 없어요.",
      );
    }

    let plan: ReturnType<typeof planPdfToImagesRasterization>;
    try {
      plan = planPdfToImagesRasterization(
        { pageCount: rasterSession.pageCount, pages: inspectionPages },
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
        archive = adapter?.createArchive?.(onData) ?? createFflateArchive(onData);
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
        await rasterSession.withPage(plannedPage.sourcePage, async (currentPage) => {
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
          await rasterSession.withCanvas(actual.width, actual.height, async (currentCanvas) => {
            currentCanvas.context.fillStyle = "#ffffff";
            currentCanvas.context.fillRect(0, 0, actual.width, actual.height);
            const renderStarted = now();
            try {
              await rasterSession.render(currentPage, currentCanvas, viewport, "#ffffff");
              throwIfCancelled();
            } catch (error) {
              throwIfCancelled();
              if (isPdfRasterMemoryError(error)) throw memoryLimit();
              if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
              if (error instanceof PdfToImagesPipelineError) throw error;
              throw new PdfToImagesPipelineError(
                "RENDER_FAILED",
                "PDF 페이지를 이미지로 그리지 못했어요.",
              );
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
              if (isPdfRasterMemoryError(error)) throw memoryLimit();
              if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
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
              if (isPdfRasterMemoryError(error)) throw memoryLimit();
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
          });
        });
      } catch (error) {
        throwIfCancelled();
        if (isPdfRasterMemoryError(error)) throw memoryLimit();
        if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
        if (error instanceof PdfToImagesPipelineError) throw error;
        throw new PdfToImagesPipelineError(
          "RENDER_FAILED",
          "PDF 페이지를 이미지로 그리지 못했어요.",
        );
      } finally {
        encodedBytes = undefined;
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
      sourcePageCount: rasterSession.pageCount,
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
    if (isPdfRasterMemoryError(error)) throw memoryLimit();
    if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
    if (error instanceof PdfToImagesPipelineError) throw error;
    throw new PdfToImagesPipelineError(
      "WORKER_CRASH",
      "PDF 이미지 변환 작업을 완료하지 못했어요.",
      true,
    );
  } finally {
    terminateArchive();
    if (session !== undefined) {
      await session.close();
      session = undefined;
    }
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
