import {
  calculatePdfCompressScannedTarget,
  compressedPdfName,
  hasCompletePdfEnvelope,
  MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES,
  MAX_PDF_COMPRESS_SCANNED_PAGES,
} from "@hereisit/pdf-tool";
import {
  PDF_COMPRESS_SCANNED_TOOL_ID,
  PDF_COMPRESS_SCANNED_TOOL_VERSION,
  type PdfCompressScannedErrorCode,
  type PdfCompressScannedErrorPayload,
  type PdfCompressScannedJobHandle,
  type PdfCompressScannedJobOutcome,
  type PdfCompressScannedProgress,
  type PdfCompressScannedResult,
  type PdfCompressScannedRunRequest,
  type PdfCompressScannedSpecV1,
  pdfCompressScannedSpecSchema,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";

const JOB_TIMEOUT_MS = 180_000;
const MAX_PUBLIC_TIMING_MS = JOB_TIMEOUT_MS;
const MAX_INPUT_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const MAX_PUBLIC_MESSAGE_LENGTH = 300;
const MAX_PUBLIC_NAME_LENGTH = 512;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const WARNINGS = [
  "PDF_PAGES_RASTERIZED",
  "SEARCHABLE_CONTENT_REMOVED",
  "INTERACTIVE_CONTENT_REMOVED",
  "SIGNATURES_INVALIDATED",
  "COLOR_PROFILE_NORMALIZED",
] as const satisfies PdfCompressScannedResult["warnings"];

const ERROR_CODES = new Set<PdfCompressScannedErrorCode>([
  "INVALID_SPEC",
  "UNSUPPORTED_BROWSER",
  "UNSUPPORTED_INPUT",
  "PASSWORD_PROTECTED",
  "CORRUPT_PDF",
  "PAGE_LIMIT",
  "MEMORY_LIMIT",
  "RENDER_FAILED",
  "ENCODE_FAILED",
  "ASSEMBLY_FAILED",
  "NO_SIZE_REDUCTION",
  "WORKER_CRASH",
]);

const WORKER_FAILURE: PdfCompressScannedErrorPayload = {
  code: "WORKER_CRASH",
  message: "브라우저 스캔 PDF 압축 작업기가 중단됐어요.",
  retryable: true,
};
const PROTOCOL_FAILURE: PdfCompressScannedErrorPayload = {
  code: "WORKER_CRASH",
  message: "스캔 PDF 압축 작업기 응답을 확인하지 못했어요.",
  retryable: true,
};

export interface RunPdfCompressScannedJobOptions {
  expectedPageCount: number;
  onProgress?: (progress: PdfCompressScannedProgress) => void;
}

interface CapturedInput {
  name: string;
  mimeHint: string;
  size: number;
  read(): Promise<ArrayBuffer>;
  spec: PdfCompressScannedSpecV1;
  expectedPageCount: number;
  onProgress?: (progress: PdfCompressScannedProgress) => void;
}

interface DecodedReady {
  capabilities: {
    offscreenCanvas: boolean;
    jpegEncoder: boolean;
    pdfjsWorker: boolean;
    pdfAssembly: boolean;
  };
  error: PdfCompressScannedErrorPayload | null;
}

interface DecodedProgress {
  jobId: string;
  sequence: number;
  progress: PdfCompressScannedProgress;
}

function makeJobId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (!isObjectRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function arrayBufferByteLength(value: ArrayBuffer): number {
  if (ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) {
    throw new TypeError("ArrayBuffer byte length is unavailable.");
  }
  return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []) as number;
}

function isOrdinaryArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer &&
    Object.getPrototypeOf(value) === ArrayBuffer.prototype &&
    Reflect.ownKeys(value).length === 0
  );
}

function isFiniteFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isSafePublicText(value: unknown, maximum: number): value is string {
  return (
    isBoundedString(value, 1, maximum) &&
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

function releaseCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas === undefined) return;
  try {
    canvas.width = 0;
  } catch {
    // Both axes receive an independent release attempt.
  }
  try {
    canvas.height = 0;
  } catch {
    // Both axes receive an independent release attempt.
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

export function supportsBrowserPdfCompressScannedRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined" && supportsOffscreenCanvas();
}

function decodeError(value: unknown): PdfCompressScannedErrorPayload | undefined {
  if (!isPlainRecord(value)) return undefined;
  const code = value.code;
  const message = value.message;
  const retryable = value.retryable;
  if (
    typeof code !== "string" ||
    !ERROR_CODES.has(code as PdfCompressScannedErrorCode) ||
    !isSafePublicText(message, MAX_PUBLIC_MESSAGE_LENGTH) ||
    typeof retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code: code as PdfCompressScannedErrorCode,
    message,
    retryable,
  };
}

function decodeReady(value: Record<PropertyKey, unknown>): DecodedReady | undefined {
  const protocol = value.protocol;
  const rawCapabilities = value.capabilities;
  const rawError = value.error;
  if (protocol !== WORKER_PROTOCOL_VERSION || !isPlainRecord(rawCapabilities)) return undefined;
  const offscreenCanvas = rawCapabilities.offscreenCanvas;
  const jpegEncoder = rawCapabilities.jpegEncoder;
  const pdfjsWorker = rawCapabilities.pdfjsWorker;
  const pdfAssembly = rawCapabilities.pdfAssembly;
  if (
    typeof offscreenCanvas !== "boolean" ||
    typeof jpegEncoder !== "boolean" ||
    typeof pdfjsWorker !== "boolean" ||
    typeof pdfAssembly !== "boolean"
  ) {
    return undefined;
  }
  let error: PdfCompressScannedErrorPayload | null;
  if (rawError === null) {
    error = null;
  } else {
    const decodedError = decodeError(rawError);
    if (decodedError === undefined) return undefined;
    error = decodedError;
  }
  return {
    capabilities: {
      offscreenCanvas,
      jpegEncoder,
      pdfjsWorker,
      pdfAssembly,
    },
    error,
  };
}

function readinessOutcome(
  ready: DecodedReady,
): { supported: true } | { supported: false; error: PdfCompressScannedErrorPayload } | undefined {
  const capabilities = ready.capabilities;
  if (!capabilities.offscreenCanvas && capabilities.jpegEncoder) return undefined;
  const allSupported =
    capabilities.offscreenCanvas &&
    capabilities.jpegEncoder &&
    capabilities.pdfjsWorker &&
    capabilities.pdfAssembly;
  if (allSupported) return ready.error === null ? { supported: true } : undefined;
  if (ready.error === null) return undefined;

  const canvasUnsupported = !capabilities.offscreenCanvas || !capabilities.jpegEncoder;
  if (canvasUnsupported) {
    return ready.error.code === "UNSUPPORTED_BROWSER" && !ready.error.retryable
      ? { supported: false, error: ready.error }
      : undefined;
  }
  return ready.error.code === "WORKER_CRASH" && ready.error.retryable
    ? { supported: false, error: ready.error }
    : undefined;
}

function decodeProgress(
  value: Record<PropertyKey, unknown>,
  jobId: string,
  expectedPageCount: number,
): DecodedProgress | undefined {
  const protocol = value.protocol;
  const sequence = value.sequence;
  const phase = value.phase;
  const fraction = value.fraction;
  if (
    protocol !== WORKER_PROTOCOL_VERSION ||
    !isNonNegativeInteger(sequence) ||
    !isFiniteFraction(fraction)
  ) {
    return undefined;
  }
  if (phase === "rendering" || phase === "encoding" || phase === "assembling") {
    const completedPages = value.completedPages;
    const totalPages = value.totalPages;
    if (
      !isPositiveInteger(completedPages) ||
      totalPages !== expectedPageCount ||
      completedPages > expectedPageCount
    ) {
      return undefined;
    }
    return {
      jobId,
      sequence,
      progress: {
        phase,
        fraction,
        completedPages,
        totalPages: expectedPageCount,
      },
    };
  }
  if (
    phase !== "validating" &&
    phase !== "loading" &&
    phase !== "serializing" &&
    phase !== "finalizing"
  ) {
    return undefined;
  }
  if (phase === "finalizing" && fraction !== 1) return undefined;
  return {
    jobId,
    sequence,
    progress: { phase, fraction },
  };
}

function decodeTiming(value: unknown): PdfCompressScannedResult["timing"] | undefined {
  if (!isPlainRecord(value)) return undefined;
  const loadMs = value.loadMs;
  const renderMs = value.renderMs;
  const encodeMs = value.encodeMs;
  const assembleMs = value.assembleMs;
  const serializeMs = value.serializeMs;
  const totalMs = value.totalMs;
  const timings = [loadMs, renderMs, encodeMs, assembleMs, serializeMs, totalMs];
  if (
    !timings.every(
      (timing) =>
        typeof timing === "number" &&
        Number.isFinite(timing) &&
        timing >= 0 &&
        timing <= MAX_PUBLIC_TIMING_MS,
    )
  ) {
    return undefined;
  }
  return {
    loadMs: loadMs as number,
    renderMs: renderMs as number,
    encodeMs: encodeMs as number,
    assembleMs: assembleMs as number,
    serializeMs: serializeMs as number,
    totalMs: totalMs as number,
  };
}

function decodeWarnings(value: unknown): PdfCompressScannedResult["warnings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (
    value.length !== WARNINGS.length ||
    ownKeys.length !== WARNINGS.length + 1 ||
    !WARNINGS.every((_warning, index) => ownKeys.includes(String(index)))
  ) {
    return undefined;
  }
  const first = value[0];
  const second = value[1];
  const third = value[2];
  const fourth = value[3];
  const fifth = value[4];
  if (
    first !== WARNINGS[0] ||
    second !== WARNINGS[1] ||
    third !== WARNINGS[2] ||
    fourth !== WARNINGS[3] ||
    fifth !== WARNINGS[4]
  ) {
    return undefined;
  }
  return [first, second, third, fourth, fifth];
}

function decodeResult(value: unknown, input: CapturedInput): PdfCompressScannedResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  const bytes = value.bytes;
  const suggestedName = value.suggestedName;
  const mime = value.mime;
  const sourceByteLength = value.sourceByteLength;
  const byteLength = value.byteLength;
  const pageCount = value.pageCount;
  const preset = value.preset;
  const dpi = value.dpi;
  const quality = value.quality;
  const rawWarnings = value.warnings;
  const rawTiming = value.timing;
  if (!isOrdinaryArrayBuffer(bytes)) return undefined;
  const actualByteLength = arrayBufferByteLength(bytes);
  const warnings = decodeWarnings(rawWarnings);
  const timing = decodeTiming(rawTiming);
  let targetBytes: number;
  try {
    targetBytes = calculatePdfCompressScannedTarget(input.size).targetBytes;
  } catch {
    return undefined;
  }
  const expectedName = compressedPdfName(input.name);
  const presetMatches =
    (input.spec.preset === "balanced" && preset === "balanced" && dpi === 150 && quality === 72) ||
    (input.spec.preset === "minimum" && preset === "minimum" && dpi === 96 && quality === 55);
  if (
    sourceByteLength !== input.size ||
    !isPositiveInteger(byteLength) ||
    byteLength !== actualByteLength ||
    byteLength > targetBytes ||
    !hasCompletePdfEnvelope(bytes) ||
    mime !== "application/pdf" ||
    !isSafePublicText(suggestedName, MAX_PUBLIC_NAME_LENGTH) ||
    suggestedName !== expectedName ||
    pageCount !== input.expectedPageCount ||
    !presetMatches ||
    warnings === undefined ||
    timing === undefined
  ) {
    return undefined;
  }
  return {
    bytes,
    suggestedName,
    mime: "application/pdf",
    sourceByteLength: input.size,
    byteLength,
    pageCount: input.expectedPageCount,
    preset: preset as PdfCompressScannedResult["preset"],
    dpi: dpi as PdfCompressScannedResult["dpi"],
    quality: quality as PdfCompressScannedResult["quality"],
    warnings,
    timing,
  };
}

function notifyProgress(
  callback: RunPdfCompressScannedJobOptions["onProgress"],
  progress: PdfCompressScannedProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // Observer failures never alter the job lifecycle.
  }
}

function validationError(
  file: File,
  rawSpec: PdfCompressScannedSpecV1,
  rawOptions: RunPdfCompressScannedJobOptions,
): { input?: CapturedInput; error?: PdfCompressScannedErrorPayload } {
  try {
    if (!supportsBrowserPdfCompressScannedRuntime()) {
      return {
        error: {
          code: "UNSUPPORTED_BROWSER",
          message: "이 브라우저는 로컬 스캔 PDF 압축을 지원하지 않아요.",
          retryable: false,
        },
      };
    }
    if (!isObjectRecord(file)) {
      return {
        error: {
          code: "UNSUPPORTED_INPUT",
          message: "PDF 파일을 확인할 수 없어요.",
          retryable: false,
        },
      };
    }
    const size = file.size;
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES
    ) {
      return {
        error: {
          code: "MEMORY_LIMIT",
          message: "PDF 파일은 1바이트 이상 50MB 이하여야 해요.",
          retryable: false,
        },
      };
    }
    const name = file.name;
    const mimeHint = file.type;
    if (
      !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
      !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
      (mimeHint.trim().toLowerCase() !== "application/pdf" && !/\.pdf$/iu.test(name))
    ) {
      return {
        error: {
          code: "UNSUPPORTED_INPUT",
          message: "PDF 형식을 확인할 수 없는 파일이에요.",
          retryable: false,
        },
      };
    }
    const arrayBuffer = file.arrayBuffer;
    if (typeof arrayBuffer !== "function") {
      return {
        error: { code: "CORRUPT_PDF", message: "PDF 파일을 읽을 수 없어요.", retryable: false },
      };
    }
    const parsedSpec = pdfCompressScannedSpecSchema.safeParse(rawSpec);
    if (!parsedSpec.success) {
      return {
        error: {
          code: "INVALID_SPEC",
          message: "스캔 PDF 압축 설정이 올바르지 않아요.",
          retryable: false,
        },
      };
    }
    if (!isObjectRecord(rawOptions)) {
      return {
        error: {
          code: "INVALID_SPEC",
          message: "스캔 PDF 압축 요청이 올바르지 않아요.",
          retryable: false,
        },
      };
    }
    const expectedPageCount = rawOptions.expectedPageCount;
    if (
      !isPositiveInteger(expectedPageCount) ||
      expectedPageCount > MAX_PDF_COMPRESS_SCANNED_PAGES
    ) {
      return {
        error: {
          code: "PAGE_LIMIT",
          message: `PDF는 1페이지부터 ${MAX_PDF_COMPRESS_SCANNED_PAGES}페이지까지 압축할 수 있어요.`,
          retryable: false,
        },
      };
    }
    const onProgress = rawOptions.onProgress;
    if (onProgress !== undefined && typeof onProgress !== "function") {
      return {
        error: {
          code: "INVALID_SPEC",
          message: "스캔 PDF 압축 요청이 올바르지 않아요.",
          retryable: false,
        },
      };
    }
    return {
      input: {
        name,
        mimeHint,
        size,
        read: () => Reflect.apply(arrayBuffer, file, []) as Promise<ArrayBuffer>,
        spec: parsedSpec.data,
        expectedPageCount,
        ...(onProgress === undefined ? {} : { onProgress }),
      },
    };
  } catch {
    return {
      error: {
        code: "INVALID_SPEC",
        message: "스캔 PDF 압축 요청이 올바르지 않아요.",
        retryable: false,
      },
    };
  }
}

export function runPdfCompressScannedJob(
  file: File,
  spec: PdfCompressScannedSpecV1,
  options: RunPdfCompressScannedJobOptions,
): PdfCompressScannedJobHandle {
  let settled = false;
  let cancelled = false;
  let readyAccepted = false;
  let readStarted = false;
  let runPosted = false;
  let lastProgressSequence = -1;
  let lastProgressFraction = -1;
  let lastCompletedPages = 0;
  let sawFinalizingOne = false;
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let captured: CapturedInput | undefined;
  let resolveResult: (outcome: PdfCompressScannedJobOutcome) => void = () => undefined;
  const result = new Promise<PdfCompressScannedJobOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const jobId = makeJobId();

  const settle = (outcome: PdfCompressScannedJobOutcome): void => {
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
      // Teardown cannot replace the selected public outcome.
    }
    resolveResult(outcome);
  };
  const reject = (error: PdfCompressScannedErrorPayload): void => {
    settle({ status: "rejected", error });
  };
  const workerFailure = (): void => reject(WORKER_FAILURE);
  const protocolFailure = (): void => reject(PROTOCOL_FAILURE);

  timeoutId = setTimeout(() => {
    reject({
      code: "WORKER_CRASH",
      message: "스캔 PDF 압축 시간이 3분 제한을 넘었어요.",
      retryable: true,
    });
  }, JOB_TIMEOUT_MS);

  const validation = validationError(file, spec, options);
  if (validation.error !== undefined) {
    reject(validation.error);
  } else if (validation.input !== undefined) {
    const input = validation.input;
    captured = input;
    const beginFileRead = (): void => {
      if (readStarted || settled || cancelled || worker === undefined) return;
      readStarted = true;
      void Promise.resolve().then(async () => {
        if (settled || cancelled) return;
        let bytes: ArrayBuffer;
        try {
          bytes = await input.read();
        } catch {
          reject({
            code: "CORRUPT_PDF",
            message: "선택한 PDF 파일을 읽지 못했어요.",
            retryable: true,
          });
          return;
        }
        if (settled || cancelled) return;
        if (!isOrdinaryArrayBuffer(bytes) || arrayBufferByteLength(bytes) !== input.size) {
          reject({
            code: "CORRUPT_PDF",
            message: "PDF 파일 크기 정보를 확인할 수 없어요.",
            retryable: false,
          });
          return;
        }
        const request: PdfCompressScannedRunRequest = {
          protocol: WORKER_PROTOCOL_VERSION,
          type: "run",
          jobId,
          tool: PDF_COMPRESS_SCANNED_TOOL_ID,
          toolVersion: PDF_COMPRESS_SCANNED_TOOL_VERSION,
          input: {
            name: input.name,
            mimeHint: input.mimeHint,
            byteLength: input.size,
            bytes,
          },
          spec: input.spec,
        };
        try {
          runPosted = true;
          worker?.postMessage(request, [bytes]);
        } catch {
          runPosted = false;
          protocolFailure();
        }
      });
    };

    try {
      worker = new Worker(new URL("./pdf-compress-scanned.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-pdf-compress-scanned-worker",
      });
      worker.onmessage = (message: MessageEvent<unknown>) => {
        if (settled || cancelled) return;
        try {
          const value = message.data;
          if (!isPlainRecord(value)) {
            if (typeof value === "object" && value !== null) protocolFailure();
            return;
          }
          const eventJobId = value.jobId;
          if (typeof eventJobId === "string" && eventJobId !== jobId) return;
          const eventType = value.type;

          if (eventType === "complete" || eventType === "failed") {
            if (eventJobId !== jobId) return;
            const protocol = value.protocol;
            if (!runPosted || protocol !== WORKER_PROTOCOL_VERSION) {
              protocolFailure();
              return;
            }
            if (eventType === "complete") {
              const rawResult = value.result;
              const decoded = sawFinalizingOne ? decodeResult(rawResult, input) : undefined;
              if (decoded === undefined) {
                protocolFailure();
                return;
              }
              settle({ status: "fulfilled", value: decoded });
              return;
            }
            const rawError = value.error;
            const error = decodeError(rawError);
            if (error === undefined) {
              protocolFailure();
              return;
            }
            reject(error);
            return;
          }

          if (eventType === "ready") {
            if (readyAccepted) return;
            const decoded = decodeReady(value);
            const readiness = decoded === undefined ? undefined : readinessOutcome(decoded);
            if (readiness === undefined) {
              protocolFailure();
            } else if (readiness.supported) {
              readyAccepted = true;
              beginFileRead();
            } else {
              reject(readiness.error);
            }
            return;
          }

          if (eventType !== "progress" || eventJobId !== jobId || !runPosted) return;
          const progress = decodeProgress(value, eventJobId, input.expectedPageCount);
          if (
            progress === undefined ||
            progress.sequence <= lastProgressSequence ||
            progress.progress.fraction < lastProgressFraction
          ) {
            return;
          }
          const completedPages =
            progress.progress.phase === "rendering" ||
            progress.progress.phase === "encoding" ||
            progress.progress.phase === "assembling"
              ? progress.progress.completedPages
              : undefined;
          if (completedPages !== undefined && completedPages < lastCompletedPages) {
            protocolFailure();
            return;
          }
          lastProgressSequence = progress.sequence;
          lastProgressFraction = progress.progress.fraction;
          if (completedPages !== undefined) lastCompletedPages = completedPages;
          if (progress.progress.phase === "finalizing" && progress.progress.fraction === 1) {
            sawFinalizingOne = true;
          }
          notifyProgress(input.onProgress, progress.progress);
        } catch {
          protocolFailure();
        }
      };
      worker.onerror = workerFailure;
      worker.onmessageerror = workerFailure;
    } catch {
      reject({
        code: "WORKER_CRASH",
        message: "브라우저 스캔 PDF 압축 작업기를 시작하지 못했어요.",
        retryable: true,
      });
    }
  }

  if (!settled && worker !== undefined && captured !== undefined) {
    notifyProgress(captured.onProgress, { phase: "validating", fraction: 0 });
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
          // Cancellation remains authoritative if the Worker port is already closed.
        }
      }
      settle({ status: "cancelled" });
    },
  };
}

export type {
  PdfCompressScannedErrorPayload,
  PdfCompressScannedJobHandle,
  PdfCompressScannedJobOutcome,
  PdfCompressScannedProgress,
  PdfCompressScannedResult,
  PdfCompressScannedSpecV1,
};
