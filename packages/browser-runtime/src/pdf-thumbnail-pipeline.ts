import {
  acceptPdfThumbnailBytes,
  hasPdfSignature,
  planPdfThumbnailRaster,
} from "@hereisit/pdf-tool";
import type {
  PdfThumbnailProgress,
  PdfThumbnailResult,
  PdfThumbnailRunRequest,
  PdfThumbnailUpdate,
  PdfToolErrorCode,
  PdfToolErrorPayload,
} from "@hereisit/tool-contracts";
import {
  openPdfRasterSession,
  type PdfRasterRendererAdapter,
  PdfRasterRuntimeError,
} from "./pdf-raster-runtime";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_PAGES = 500;

export type PdfThumbnailPipelineInput = PdfThumbnailRunRequest["input"];

export interface PdfThumbnailPipelineOptions {
  adapter?: PdfRasterRendererAdapter;
  signal?: AbortSignal;
  onThumbnail?: (update: PdfThumbnailUpdate) => void;
  onProgress?: (progress: PdfThumbnailProgress) => void;
}

export class PdfThumbnailPipelineError extends Error {
  constructor(
    readonly code: PdfToolErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PdfThumbnailPipelineError";
  }
}

class PdfThumbnailCancellationError extends Error {
  constructor() {
    super("PDF thumbnail rendering was cancelled.");
    this.name = "AbortError";
  }
}

class PdfThumbnailPageError extends Error {}

function emit<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // UI callbacks cannot change local processing or resource cleanup.
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PdfThumbnailCancellationError();
}

function validateInput(input: PdfThumbnailPipelineInput): void {
  const actualByteLength = input.bytes.byteLength;
  if (
    !Number.isSafeInteger(actualByteLength) ||
    actualByteLength < 1 ||
    actualByteLength > MAX_INPUT_BYTES
  ) {
    throw new PdfThumbnailPipelineError(
      "MEMORY_LIMIT",
      "PDF 파일은 1바이트 이상 50MB 이하여야 해요.",
    );
  }
  if (input.byteLength !== actualByteLength) {
    throw new PdfThumbnailPipelineError(
      "CORRUPT_PDF",
      "PDF 파일 크기 정보를 확인할 수 없어요.",
    );
  }
  const extensionIsPdf = /\.pdf$/i.test(input.name);
  const mimeIsPdf = input.mimeHint.trim().toLowerCase() === "application/pdf";
  if ((!extensionIsPdf && !mimeIsPdf) || !hasPdfSignature(input.bytes)) {
    throw new PdfThumbnailPipelineError(
      "CORRUPT_PDF",
      "PDF 형식을 확인할 수 없는 파일이에요.",
    );
  }
}

function isWebp(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  return (
    view.byteLength >= 12 &&
    view[0] === 0x52 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x46 &&
    view[8] === 0x57 &&
    view[9] === 0x45 &&
    view[10] === 0x42 &&
    view[11] === 0x50
  );
}

function mapRasterError(error: PdfRasterRuntimeError): PdfThumbnailPipelineError {
  if (error.code === "PASSWORD_PROTECTED") {
    return new PdfThumbnailPipelineError(
      "PASSWORD_PROTECTED",
      "암호로 잠긴 PDF는 아직 처리할 수 없어요.",
    );
  }
  if (error.code === "CORRUPT_PDF") {
    return new PdfThumbnailPipelineError(
      "CORRUPT_PDF",
      "PDF 파일을 읽을 수 없어요. 다른 파일을 선택해 주세요.",
    );
  }
  if (error.code === "MEMORY_LIMIT") {
    return new PdfThumbnailPipelineError(
      "MEMORY_LIMIT",
      "미리보기를 만들 메모리가 부족해요.",
    );
  }
  return new PdfThumbnailPipelineError(
    "WORKER_CRASH",
    error.message || "PDF 미리보기 작업기가 중단됐어요.",
    error.retryable,
  );
}

export async function runPdfThumbnailPipeline(
  input: PdfThumbnailPipelineInput,
  options: PdfThumbnailPipelineOptions = {},
): Promise<PdfThumbnailResult> {
  validateInput(input);
  throwIfAborted(options.signal);

  let session;
  try {
    session = await openPdfRasterSession(
      { bytes: input.bytes },
      {
        ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new PdfThumbnailCancellationError();
    }
    if (error instanceof PdfRasterRuntimeError) throw mapRasterError(error);
    throw new PdfThumbnailPipelineError(
      "WORKER_CRASH",
      "PDF 미리보기 작업기를 시작하지 못했어요.",
      true,
    );
  }

  let renderedPageCount = 0;
  let failedPageCount = 0;
  let omittedPageCount = 0;
  let usedBytes = 0;

  try {
    if (!Number.isSafeInteger(session.pageCount) || session.pageCount < 1) {
      throw new PdfThumbnailPipelineError("CORRUPT_PDF", "페이지가 없는 PDF는 처리할 수 없어요.");
    }
    if (session.pageCount > MAX_SOURCE_PAGES) {
      throw new PdfThumbnailPipelineError(
        "PAGE_LIMIT",
        `PDF는 최대 ${MAX_SOURCE_PAGES}페이지까지 처리할 수 있어요.`,
      );
    }

    for (let sourcePage = 1; sourcePage <= session.pageCount; sourcePage += 1) {
      throwIfAborted(options.signal);
      try {
        const rendered = await session.withPage(sourcePage, async (page) => {
          const base = page.getViewport({ scale: 1 });
          const plan = planPdfThumbnailRaster(base.width, base.height);
          const viewport = page.getViewport({ scale: plan.scale });
          if (
            !Number.isFinite(viewport.width) ||
            !Number.isFinite(viewport.height) ||
            Math.ceil(viewport.width) !== plan.width ||
            Math.ceil(viewport.height) !== plan.height
          ) {
            throw new PdfThumbnailPageError();
          }
          return await session.withCanvas(plan.width, plan.height, async (canvas) => {
            await session.render(page, canvas, viewport, "#ffffff");
            let blob: Blob;
            try {
              blob = await canvas.canvas.convertToBlob({ type: "image/webp", quality: 0.72 });
            } catch {
              throw new PdfThumbnailPageError();
            }
            if (blob.type !== "image/webp" || blob.size < 1 || blob.size > plan.rawByteLimit) {
              throw new PdfThumbnailPageError();
            }
            const nextUsedBytes = acceptPdfThumbnailBytes(
              usedBytes,
              blob.size,
              plan.rawByteLimit,
            );
            if (nextUsedBytes === undefined) {
              return { status: "budget" as const };
            }
            const bytes = await blob.arrayBuffer();
            if (bytes.byteLength !== blob.size || !isWebp(bytes)) {
              throw new PdfThumbnailPageError();
            }
            return { status: "ready" as const, plan, bytes, nextUsedBytes };
          });
        });

        if (rendered.status === "budget") {
          omittedPageCount = session.pageCount - sourcePage + 1;
          break;
        }

        usedBytes = rendered.nextUsedBytes;
        renderedPageCount += 1;
        emit(options.onThumbnail, {
          status: "ready",
          sourcePage,
          width: rendered.plan.width,
          height: rendered.plan.height,
          mime: "image/webp",
          bytes: rendered.bytes,
        });
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new PdfThumbnailCancellationError();
        }
        if (error instanceof PdfRasterRuntimeError && error.code === "MEMORY_LIMIT") {
          omittedPageCount = session.pageCount - sourcePage + 1;
          break;
        }
        if (
          error instanceof PdfThumbnailPageError ||
          (error instanceof PdfRasterRuntimeError && error.code === "RENDER_FAILED")
        ) {
          failedPageCount += 1;
          emit(options.onThumbnail, { status: "failed", sourcePage });
        } else if (error instanceof PdfThumbnailPipelineError) {
          throw error;
        } else if (error instanceof PdfRasterRuntimeError) {
          throw mapRasterError(error);
        } else {
          throw new PdfThumbnailPipelineError(
            "WORKER_CRASH",
            "PDF 미리보기 작업기가 중단됐어요.",
            true,
          );
        }
      }

      const completedPages = renderedPageCount + failedPageCount;
      emit(options.onProgress, {
        completedPages,
        totalPages: session.pageCount,
        fraction: completedPages / session.pageCount,
      });
    }

    return {
      pageCount: session.pageCount,
      renderedPageCount,
      failedPageCount,
      omittedPageCount,
    };
  } finally {
    await session.close();
  }
}

export function toPdfThumbnailErrorPayload(error: unknown): PdfToolErrorPayload {
  if (error instanceof PdfThumbnailPipelineError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "CANCELLED", message: "PDF 미리보기를 중단했어요.", retryable: false };
  }
  return {
    code: "WORKER_CRASH",
    message: "PDF 미리보기 작업기가 중단됐어요.",
    retryable: true,
  };
}
