import { acceptPdfThumbnailBytes, PDF_THUMBNAIL_LONG_EDGE } from "@hereisit/pdf-tool";
import {
  PDF_THUMBNAIL_TOOL_ID,
  PDF_THUMBNAIL_TOOL_VERSION,
  type PdfThumbnailJobHandle,
  type PdfThumbnailJobOutcome,
  type PdfThumbnailProgress,
  type PdfThumbnailResult,
  type PdfThumbnailRunRequest,
  type PdfThumbnailUpdate,
  type PdfToolErrorCode,
  type PdfToolErrorPayload,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";

const JOB_TIMEOUT_MS = 180_000;
const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_PAGES = 500;
const PDF_ERROR_CODES = new Set<PdfToolErrorCode>([
  "INVALID_SPEC",
  "UNSUPPORTED_INPUT",
  "PASSWORD_PROTECTED",
  "CORRUPT_PDF",
  "PAGE_RANGE_INVALID",
  "PAGE_LIMIT",
  "MEMORY_LIMIT",
  "WRITE_FAILED",
  "CANCELLED",
  "WORKER_CRASH",
]);

export interface RunPdfThumbnailJobOptions {
  onThumbnail?: (update: PdfThumbnailUpdate) => void;
  onProgress?: (progress: PdfThumbnailProgress) => void;
}

function makeJobId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function releaseCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas === undefined) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Feature detection remains best effort.
  }
}

function supportsOffscreenCanvas(): boolean {
  if (typeof OffscreenCanvas === "undefined") return false;
  let canvas: OffscreenCanvas | undefined;
  try {
    canvas = new OffscreenCanvas(1, 1);
    return canvas.getContext("2d") !== null && typeof canvas.convertToBlob === "function";
  } catch {
    return false;
  } finally {
    releaseCanvas(canvas);
  }
}

export function supportsBrowserPdfThumbnailRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined" && supportsOffscreenCanvas();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isWebp(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  return (
    view.byteLength === bytes.byteLength &&
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

function isSafePublicText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 300 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code <= 31 ||
        code === 127 ||
        (code >= 0x80 && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  );
}

function decodeError(value: unknown): PdfToolErrorPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !PDF_ERROR_CODES.has(value.code as PdfToolErrorCode) ||
    !isSafePublicText(value.message) ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code: value.code as PdfToolErrorCode,
    message: value.message,
    retryable: value.retryable,
  };
}

function decodeResult(value: unknown): PdfThumbnailResult | undefined {
  if (!isRecord(value)) return undefined;
  const counts = [
    value.pageCount,
    value.renderedPageCount,
    value.failedPageCount,
    value.omittedPageCount,
  ];
  if (!counts.every((count) => isSafeInteger(count, 0, MAX_SOURCE_PAGES))) return undefined;
  if (!isSafeInteger(value.pageCount, 1, MAX_SOURCE_PAGES)) return undefined;
  const renderedPageCount = value.renderedPageCount as number;
  const failedPageCount = value.failedPageCount as number;
  const omittedPageCount = value.omittedPageCount as number;
  if (renderedPageCount + failedPageCount + omittedPageCount !== value.pageCount) return undefined;
  return {
    pageCount: value.pageCount,
    renderedPageCount,
    failedPageCount,
    omittedPageCount,
  };
}

function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // Observer failures cannot alter the job lifecycle.
  }
}

export function runPdfThumbnailJob(
  file: File,
  options: RunPdfThumbnailJobOptions = {},
): PdfThumbnailJobHandle {
  let settled = false;
  let cancelled = false;
  let readStarted = false;
  let runPosted = false;
  let lastSequence = -1;
  let nextSourcePage = 1;
  let readyCount = 0;
  let failedCount = 0;
  let usedBytes = 0;
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (outcome: PdfThumbnailJobOutcome) => void = () => undefined;
  const result = new Promise<PdfThumbnailJobOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const jobId = makeJobId();

  const settle = (outcome: PdfThumbnailJobOutcome): void => {
    if (settled) return;
    settled = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    const activeWorker = worker;
    worker = undefined;
    try {
      activeWorker?.terminate();
    } catch {
      // The public result remains authoritative.
    }
    resolveResult(outcome);
  };
  const reject = (error: PdfToolErrorPayload): void => settle({ status: "rejected", error });
  const workerFailure = (): void => {
    reject({
      code: "WORKER_CRASH",
      message: "브라우저 PDF 미리보기 작업기가 중단됐어요.",
      retryable: true,
    });
  };
  const beginFileRead = (): void => {
    if (readStarted || settled || cancelled || worker === undefined) return;
    readStarted = true;
    void Promise.resolve().then(async () => {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        reject({
          code: "CORRUPT_PDF",
          message: "선택한 PDF 파일을 읽지 못했어요.",
          retryable: true,
        });
        return;
      }
      if (settled || cancelled) return;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size) {
        reject({
          code: "CORRUPT_PDF",
          message: "PDF 파일 크기 정보를 확인할 수 없어요.",
          retryable: false,
        });
        return;
      }
      const request: PdfThumbnailRunRequest = {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "run",
        jobId,
        tool: PDF_THUMBNAIL_TOOL_ID,
        toolVersion: PDF_THUMBNAIL_TOOL_VERSION,
        input: {
          name: file.name,
          mimeHint: file.type,
          byteLength: file.size,
          bytes,
        },
      };
      try {
        worker?.postMessage(request, [bytes]);
        runPosted = true;
      } catch {
        workerFailure();
      }
    });
  };

  timeoutId = setTimeout(() => {
    reject({
      code: "WORKER_CRASH",
      message: "PDF 미리보기 시간이 3분 제한을 넘었어요.",
      retryable: true,
    });
  }, JOB_TIMEOUT_MS);

  if (!supportsBrowserPdfThumbnailRuntime()) {
    reject({
      code: "WORKER_CRASH",
      message: "이 브라우저는 로컬 PDF 미리보기를 지원하지 않아요.",
      retryable: false,
    });
  } else if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PDF_FILE_BYTES) {
    reject({
      code: "MEMORY_LIMIT",
      message: "PDF 파일은 1바이트 이상 50MB 이하여야 해요.",
      retryable: false,
    });
  } else {
    try {
      worker = new Worker(new URL("./pdf-thumbnail.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-pdf-thumbnail-worker",
      });
      worker.onmessage = (message: MessageEvent<unknown>) => {
        try {
          if (settled || cancelled || !isRecord(message.data)) return;
          const event = message.data;
          if (event.protocol !== WORKER_PROTOCOL_VERSION || typeof event.type !== "string") return;
          if (event.type === "ready") {
            const capabilities = event.capabilities;
            if (
              isRecord(capabilities) &&
              capabilities.tool === PDF_THUMBNAIL_TOOL_ID &&
              capabilities.toolVersion === PDF_THUMBNAIL_TOOL_VERSION
            ) {
              beginFileRead();
            }
            return;
          }
          if (event.jobId !== jobId) return;
          if (event.type === "thumbnail") {
            if (
              !isSafeInteger(event.sequence, 0, Number.MAX_SAFE_INTEGER) ||
              event.sequence <= lastSequence
            )
              return;
            const update = event.update;
            if (!isRecord(update) || !isSafeInteger(update.sourcePage, 1, MAX_SOURCE_PAGES)) return;
            if (update.sourcePage !== nextSourcePage) return;
            let decoded: PdfThumbnailUpdate | undefined;
            if (update.status === "failed") {
              decoded = { status: "failed", sourcePage: update.sourcePage };
              failedCount += 1;
            } else if (
              update.status === "ready" &&
              isSafeInteger(update.width, 1, PDF_THUMBNAIL_LONG_EDGE) &&
              isSafeInteger(update.height, 1, PDF_THUMBNAIL_LONG_EDGE) &&
              update.mime === "image/webp" &&
              update.bytes instanceof ArrayBuffer &&
              isWebp(update.bytes)
            ) {
              const nextUsedBytes = acceptPdfThumbnailBytes(
                usedBytes,
                update.bytes.byteLength,
                update.width * update.height * 4,
              );
              if (nextUsedBytes !== undefined) {
                usedBytes = nextUsedBytes;
                readyCount += 1;
                decoded = {
                  status: "ready",
                  sourcePage: update.sourcePage,
                  width: update.width,
                  height: update.height,
                  mime: "image/webp",
                  bytes: update.bytes,
                };
              }
            }
            if (decoded === undefined) return;
            lastSequence = event.sequence;
            nextSourcePage += 1;
            notify(options.onThumbnail, decoded);
            return;
          }
          if (event.type === "progress") {
            if (
              !isSafeInteger(event.sequence, 0, Number.MAX_SAFE_INTEGER) ||
              event.sequence <= lastSequence ||
              !isSafeInteger(event.completedPages, 0, MAX_SOURCE_PAGES) ||
              !isSafeInteger(event.totalPages, 1, MAX_SOURCE_PAGES) ||
              event.completedPages > event.totalPages ||
              event.completedPages !== readyCount + failedCount ||
              !isFraction(event.fraction)
            ) {
              return;
            }
            lastSequence = event.sequence;
            notify(options.onProgress, {
              completedPages: event.completedPages,
              totalPages: event.totalPages,
              fraction: event.fraction,
            });
            return;
          }
          if (event.type === "complete") {
            const decoded = decodeResult(event.result);
            if (
              decoded !== undefined &&
              decoded.renderedPageCount === readyCount &&
              decoded.failedPageCount === failedCount &&
              decoded.renderedPageCount + decoded.failedPageCount === nextSourcePage - 1
            ) {
              settle({ status: "fulfilled", value: decoded });
            }
            return;
          }
          if (event.type === "failed") {
            const error = decodeError(event.error);
            if (error !== undefined) reject(error);
          }
        } catch {
          // Worker events are untrusted structured-clone input.
        }
      };
      worker.onerror = workerFailure;
      worker.onmessageerror = workerFailure;
    } catch {
      reject({
        code: "WORKER_CRASH",
        message: "브라우저 PDF 미리보기 작업기를 시작하지 못했어요.",
        retryable: true,
      });
    }
  }

  return {
    result,
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      if (runPosted) {
        try {
          worker?.postMessage({ protocol: WORKER_PROTOCOL_VERSION, type: "cancel", jobId });
        } catch {
          // Cancellation remains authoritative when the port is closed.
        }
      }
      settle({ status: "cancelled" });
    },
  };
}

export type {
  PdfThumbnailJobHandle,
  PdfThumbnailJobOutcome,
  PdfThumbnailProgress,
  PdfThumbnailResult,
  PdfThumbnailUpdate,
};
