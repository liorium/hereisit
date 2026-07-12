import {
  PDF_TO_IMAGES_TOOL_ID,
  PDF_TO_IMAGES_TOOL_VERSION,
  type PdfToImagesErrorCode,
  type PdfToImagesErrorPayload,
  type PdfToImagesJobHandle,
  type PdfToImagesJobOutcome,
  type PdfToImagesProgress,
  type PdfToImagesResult,
  type PdfToImagesRunRequest,
  type PdfToImagesSpecV1,
  type PdfToImagesWorkerEvent,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";

const JOB_TIMEOUT_MS = 180_000;
const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PDF_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_SOURCE_PAGES = 500;
const MAX_OUTPUT_PAGES = 100;
const UNSAFE_DOWNLOAD_NAME = /[\\/<>:"|?*]/u;
const PDF_TO_IMAGES_ERROR_CODES = new Set<PdfToImagesErrorCode>([
  "INVALID_SPEC",
  "UNSUPPORTED_INPUT",
  "PASSWORD_PROTECTED",
  "CORRUPT_PDF",
  "PAGE_RANGE_INVALID",
  "PAGE_LIMIT",
  "MEMORY_LIMIT",
  "RENDER_FAILED",
  "ENCODE_FAILED",
  "WORKER_CRASH",
]);

export interface RunPdfToImagesJobOptions {
  onProgress?: (progress: PdfToImagesProgress) => void;
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
  } catch {
    // A failed feature probe must remain a simple unsupported result.
  }
  try {
    canvas.height = 0;
  } catch {
    // A failed feature probe must remain a simple unsupported result.
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

export function supportsBrowserPdfToImagesRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined" && supportsOffscreenCanvas();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isSafePublicText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code <= 31 ||
        code === 127 ||
        (code >= 0x80 && code <= 0x9f) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  );
}

function hasSignature(bytes: ArrayBuffer, signature: readonly number[]): boolean {
  const view = new Uint8Array(bytes);
  return signature.every((byte, index) => view[index] === byte);
}

function decodeTiming(value: unknown): PdfToImagesResult["timing"] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !["loadMs", "renderMs", "encodeMs", "archiveMs", "totalMs"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
    )
  ) {
    return undefined;
  }
  return {
    loadMs: value.loadMs as number,
    renderMs: value.renderMs as number,
    encodeMs: value.encodeMs as number,
    archiveMs: value.archiveMs as number,
    totalMs: value.totalMs as number,
  };
}

function decodePdfToImagesResult(
  value: unknown,
  spec: PdfToImagesSpecV1,
): PdfToImagesResult | undefined {
  if (!isRecord(value) || !(value.bytes instanceof ArrayBuffer)) return undefined;
  const timing = decodeTiming(value.timing);
  if (
    !isSafePublicText(value.suggestedName, 512) ||
    UNSAFE_DOWNLOAD_NAME.test(value.suggestedName) ||
    (value.mime !== "image/jpeg" &&
      value.mime !== "image/png" &&
      value.mime !== "application/zip") ||
    !isPositiveInteger(value.byteLength) ||
    value.byteLength > MAX_PDF_OUTPUT_BYTES ||
    value.byteLength !== value.bytes.byteLength ||
    !isPositiveInteger(value.sourcePageCount) ||
    value.sourcePageCount > MAX_SOURCE_PAGES ||
    !isPositiveInteger(value.outputPageCount) ||
    value.outputPageCount > MAX_OUTPUT_PAGES ||
    value.outputPageCount > value.sourcePageCount ||
    !isPositiveInteger(value.outputFileCount) ||
    value.outputFileCount !== value.outputPageCount ||
    (value.format !== "jpeg" && value.format !== "png") ||
    value.format !== spec.output.format ||
    !Array.isArray(value.warnings) ||
    value.warnings.length !== 2 ||
    value.warnings[0] !== "PDF_PAGE_RASTERIZED" ||
    value.warnings[1] !== "COLOR_PROFILE_NORMALIZED" ||
    timing === undefined
  ) {
    return undefined;
  }
  const sourcePageCount = value.sourcePageCount;
  const expectedOutputCount =
    spec.selection.mode === "every-page" ? sourcePageCount : spec.selection.pages.length;
  if (
    value.outputPageCount !== expectedOutputCount ||
    (spec.selection.mode === "extract" &&
      spec.selection.pages.some((sourcePage) => sourcePage > sourcePageCount))
  ) {
    return undefined;
  }
  if (value.outputPageCount === 1) {
    const expectedMime = value.format === "jpeg" ? "image/jpeg" : "image/png";
    const expectedSuffix = value.format === "jpeg" ? ".jpg" : ".png";
    const signature =
      value.format === "jpeg"
        ? [0xff, 0xd8, 0xff]
        : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      value.mime !== expectedMime ||
      !value.suggestedName.endsWith(expectedSuffix) ||
      !hasSignature(value.bytes, signature)
    ) {
      return undefined;
    }
  } else if (
    value.mime !== "application/zip" ||
    !value.suggestedName.endsWith(".zip") ||
    !hasSignature(value.bytes, [0x50, 0x4b, 0x03, 0x04])
  ) {
    return undefined;
  }
  return {
    bytes: value.bytes,
    suggestedName: value.suggestedName,
    mime: value.mime,
    byteLength: value.byteLength,
    sourcePageCount: value.sourcePageCount,
    outputPageCount: value.outputPageCount,
    outputFileCount: value.outputFileCount,
    format: value.format,
    warnings: [...value.warnings] as PdfToImagesResult["warnings"],
    timing,
  };
}

function decodePdfToImagesErrorPayload(value: unknown): PdfToImagesErrorPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !PDF_TO_IMAGES_ERROR_CODES.has(value.code as PdfToImagesErrorCode) ||
    !isSafePublicText(value.message, 300) ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code: value.code as PdfToImagesErrorCode,
    message: value.message,
    retryable: value.retryable,
  };
}

function decodeWorkerEvent(
  value: unknown,
  spec: PdfToImagesSpecV1,
): PdfToImagesWorkerEvent | undefined {
  if (
    !isRecord(value) ||
    value.protocol !== WORKER_PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    return undefined;
  }
  if (value.type === "ready") {
    const capabilities = value.capabilities;
    if (
      !isRecord(capabilities) ||
      typeof capabilities.offscreenCanvas !== "boolean" ||
      !Array.isArray(capabilities.formats) ||
      capabilities.formats.length !== 2 ||
      capabilities.formats[0] !== "jpeg" ||
      capabilities.formats[1] !== "png"
    ) {
      return undefined;
    }
    return {
      protocol: WORKER_PROTOCOL_VERSION,
      type: "ready",
      capabilities: { offscreenCanvas: capabilities.offscreenCanvas, formats: ["jpeg", "png"] },
    };
  }
  if (typeof value.jobId !== "string" || value.jobId.length === 0) return undefined;
  if (value.type === "progress") {
    if (!isNonNegativeInteger(value.sequence) || !isFiniteFraction(value.fraction))
      return undefined;
    if (value.phase === "rendering" || value.phase === "encoding") {
      if (
        !isNonNegativeInteger(value.completedPages) ||
        !isPositiveInteger(value.totalPages) ||
        value.totalPages > MAX_OUTPUT_PAGES ||
        value.completedPages > value.totalPages
      ) {
        return undefined;
      }
    } else if (
      value.phase !== "validating" &&
      value.phase !== "loading" &&
      value.phase !== "archiving" &&
      value.phase !== "finalizing"
    ) {
      return undefined;
    }
    if (value.phase === "rendering" || value.phase === "encoding") {
      return {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "progress",
        jobId: value.jobId,
        sequence: value.sequence,
        phase: value.phase,
        fraction: value.fraction,
        completedPages: value.completedPages as number,
        totalPages: value.totalPages as number,
      };
    }
    return {
      protocol: WORKER_PROTOCOL_VERSION,
      type: "progress",
      jobId: value.jobId,
      sequence: value.sequence,
      phase: value.phase,
      fraction: value.fraction,
    };
  }
  if (value.type === "complete") {
    const result = decodePdfToImagesResult(value.result, spec);
    if (result !== undefined) {
      return {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "complete",
        jobId: value.jobId,
        result,
      };
    }
  }
  if (value.type === "failed") {
    const error = decodePdfToImagesErrorPayload(value.error);
    if (error !== undefined) {
      return {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "failed",
        jobId: value.jobId,
        error,
      };
    }
  }
  return undefined;
}

function notifyProgress(
  callback: RunPdfToImagesJobOptions["onProgress"],
  progress: PdfToImagesProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // Observer failures must never alter the job lifecycle.
  }
}

export function runPdfToImagesJob(
  file: File,
  spec: PdfToImagesSpecV1,
  options: RunPdfToImagesJobOptions = {},
): PdfToImagesJobHandle {
  let settled = false;
  let cancelled = false;
  let readStarted = false;
  let runPosted = false;
  let lastProgressSequence = -1;
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (outcome: PdfToImagesJobOutcome) => void = () => undefined;
  const result = new Promise<PdfToImagesJobOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const jobId = makeJobId();

  const settle = (outcome: PdfToImagesJobOutcome): void => {
    if (settled) return;
    settled = true;
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    const activeWorker = worker;
    worker = undefined;
    try {
      activeWorker?.terminate();
    } catch {
      // The promised outcome still settles if browser teardown itself throws.
    }
    resolveResult(outcome);
  };
  const reject = (error: PdfToImagesErrorPayload): void => {
    settle({ status: "rejected", error });
  };
  const workerFailure = (): void => {
    reject({
      code: "WORKER_CRASH",
      message: "브라우저 PDF 이미지 변환 작업기가 중단됐어요.",
      retryable: true,
    });
  };
  const beginFileRead = (): void => {
    if (readStarted || settled || cancelled || worker === undefined) return;
    readStarted = true;
    void Promise.resolve().then(async () => {
      if (settled || cancelled) return;
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
      const input: PdfToImagesRunRequest["input"] = {
        name: file.name,
        mimeHint: file.type,
        byteLength: file.size,
        bytes,
      };
      const request: PdfToImagesRunRequest = {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "run",
        jobId,
        tool: PDF_TO_IMAGES_TOOL_ID,
        toolVersion: PDF_TO_IMAGES_TOOL_VERSION,
        input,
        spec,
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
      message: "PDF 이미지 변환 시간이 3분 제한을 넘었어요.",
      retryable: true,
    });
  }, JOB_TIMEOUT_MS);

  if (!supportsBrowserPdfToImagesRuntime()) {
    reject({
      code: "WORKER_CRASH",
      message: "이 브라우저는 로컬 PDF 이미지 변환을 지원하지 않아요.",
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
      worker = new Worker(new URL("./pdf-to-images.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-pdf-to-images-worker",
      });
      worker.onmessage = (message: MessageEvent<unknown>) => {
        if (settled || cancelled) return;
        let event: PdfToImagesWorkerEvent | undefined;
        try {
          event = decodeWorkerEvent(message.data, spec);
        } catch {
          return;
        }
        if (event === undefined) return;
        if (event.type === "ready") {
          if (!event.capabilities.offscreenCanvas) {
            reject({
              code: "WORKER_CRASH",
              message: "이 브라우저는 로컬 PDF 이미지 변환을 지원하지 않아요.",
              retryable: false,
            });
          } else {
            beginFileRead();
          }
          return;
        }
        if (event.jobId !== jobId) return;
        if (event.type === "progress") {
          if (event.sequence <= lastProgressSequence) return;
          lastProgressSequence = event.sequence;
          const {
            protocol: _protocol,
            type: _type,
            jobId: _jobId,
            sequence: _sequence,
            ...progress
          } = event;
          notifyProgress(options.onProgress, progress);
          return;
        }
        if (event.type === "complete") {
          settle({ status: "fulfilled", value: event.result });
          return;
        }
        reject(event.error);
      };
      worker.onerror = workerFailure;
      worker.onmessageerror = workerFailure;
    } catch {
      reject({
        code: "WORKER_CRASH",
        message: "브라우저 PDF 이미지 변환 작업기를 시작하지 못했어요.",
        retryable: true,
      });
    }
  }

  if (!settled && worker !== undefined) {
    notifyProgress(options.onProgress, { phase: "validating", fraction: 0 });
  }

  return {
    result,
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      if (runPosted) {
        try {
          worker?.postMessage({
            protocol: WORKER_PROTOCOL_VERSION,
            type: "cancel",
            jobId,
          });
        } catch {
          // Cancellation remains authoritative even if the Worker port is already closed.
        }
      }
      settle({ status: "cancelled" });
    },
  };
}

export type {
  PdfToImagesJobHandle,
  PdfToImagesJobOutcome,
  PdfToImagesProgress,
  PdfToImagesResult,
  PdfToImagesSpecV1,
};
