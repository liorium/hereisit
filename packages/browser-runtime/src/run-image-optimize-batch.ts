import {
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_FILES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
  type ImageOptimizeInspection,
  type ImageOptimizeLosslessResult,
  type ImageOptimizeWorkerError,
  type ImageOptimizeWorkerRequest,
} from "@hereisit/tool-contracts/image-optimize";

const JOB_TIMEOUT_MS = 180_000;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const INVALID_SPEC_ERROR: ImageOptimizeWorkerError = {
  code: "INVALID_SPEC",
  message: "이미지 요청이 올바르지 않습니다.",
  retryable: false,
};
const MEMORY_LIMIT_ERROR: ImageOptimizeWorkerError = {
  code: "MEMORY_LIMIT",
  message: "파일은 30MB 이하만 처리할 수 있습니다.",
  retryable: false,
};
const WORKER_FAILURE_ERROR: ImageOptimizeWorkerError = {
  code: "WORKER_CRASH",
  message: "브라우저 작업기가 중단되었습니다.",
  retryable: true,
};

export type ImageOptimizeInspectionBatchResult =
  | {
      readonly itemId: string;
      readonly status: "fulfilled";
      readonly value: ImageOptimizeInspection;
    }
  | { readonly itemId: string; readonly status: "rejected"; readonly message: string }
  | { readonly itemId: string; readonly status: "cancelled" };

export interface ImageOptimizeInspectionBatchHandle {
  readonly result: Promise<readonly ImageOptimizeInspectionBatchResult[]>;
  cancel(): void;
}

export type LocalImageOptimizeResult =
  | {
      readonly status: "fulfilled";
      readonly itemId: string;
      readonly mime: "image/jpeg" | "image/png";
      readonly bytes: ArrayBuffer;
      readonly byteLength: number;
      readonly width: number;
      readonly height: number;
      readonly warnings: readonly [];
    }
  | {
      readonly status: "unsupported";
      readonly itemId: string;
      readonly reason: "LOSSLESS_SERVER_REQUIRED";
    }
  | { readonly status: "cancelled"; readonly itemId: string }
  | { readonly status: "rejected"; readonly itemId: string; readonly message: string };

export type LocalImageOptimizeRuntimeEvent =
  | {
      readonly type: "item-progress";
      readonly itemId: string;
      readonly phase: "inspecting" | "optimizing" | "verifying";
      readonly fraction: null;
    }
  | {
      readonly type: "item-complete";
      readonly itemId: string;
      readonly result: LocalImageOptimizeResult;
    }
  | { readonly type: "batch-progress"; readonly completed: number; readonly total: number };

export interface LocalImageOptimizeBatchHandle {
  readonly result: Promise<readonly LocalImageOptimizeResult[]>;
  cancel(): void;
}

interface CapturedItem {
  itemId: string;
  file: File;
  name: string;
  mimeHint: string;
  byteLength: number;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every(
      (key) => actual.includes(key) && Object.prototype.propertyIsEnumerable.call(value, key),
    )
  );
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isSafeId(value: unknown): value is string {
  return (
    isBoundedString(value, 1, MAX_ID_LENGTH) &&
    value.trim().length > 0 &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function isOrdinaryArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer &&
    Object.getPrototypeOf(value) === ArrayBuffer.prototype &&
    Reflect.ownKeys(value).length === 0
  );
}

function byteLength(value: ArrayBuffer): number {
  if (ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) throw new TypeError();
  return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []) as number;
}

function safeMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 300 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function parseError(value: unknown): ImageOptimizeWorkerError | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["code", "message", "retryable"]))
    return undefined;
  const codes: readonly ImageOptimizeWorkerError["code"][] = [
    "INVALID_SPEC",
    "UNSUPPORTED_INPUT",
    "ANIMATED_INPUT",
    "CORRUPT_INPUT",
    "DIMENSION_LIMIT",
    "MEMORY_LIMIT",
    "DECODE_FAILED",
    "ENCODE_FAILED",
    "NO_SIZE_REDUCTION",
    "CANCELLED",
    "WORKER_CRASH",
  ];
  if (
    typeof value.code !== "string" ||
    !codes.includes(value.code as ImageOptimizeWorkerError["code"]) ||
    !safeMessage(value.message) ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code: value.code as ImageOptimizeWorkerError["code"],
    message: value.message,
    retryable: value.retryable,
  };
}

function parseInspection(value: unknown): ImageOptimizeInspection | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["mime", "width", "height", "animated"])) {
    return undefined;
  }
  const mimes = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
  const { mime, width, height, animated } = value;
  if (
    typeof mime !== "string" ||
    !mimes.includes(mime as ImageOptimizeInspection["mime"]) ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    typeof animated !== "boolean"
  ) {
    return undefined;
  }
  return {
    mime: mime as ImageOptimizeInspection["mime"],
    width,
    height,
    animated,
  };
}

function parseLosslessResult(value: unknown): ImageOptimizeLosslessResult | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["bytes", "byteLength", "mime", "width", "height", "warnings"])
  ) {
    return undefined;
  }
  const { bytes, byteLength: declaredLength, mime, width, height } = value;
  if (
    !isOrdinaryArrayBuffer(bytes) ||
    typeof declaredLength !== "number" ||
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 1 ||
    byteLength(bytes) !== declaredLength ||
    (mime !== "image/jpeg" && mime !== "image/png") ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    width * height > IMAGE_OPTIMIZE_MAX_PIXELS ||
    !Array.isArray(value.warnings) ||
    value.warnings.length !== 0
  ) {
    return undefined;
  }
  return {
    bytes,
    byteLength: declaredLength,
    mime,
    width,
    height,
    warnings: [],
  };
}

type ParsedEvent =
  | { type: "inspected"; jobId: string; result: ImageOptimizeInspection }
  | {
      type: "progress";
      jobId: string;
      sequence: number;
      phase: "inspecting" | "optimizing" | "verifying";
    }
  | { type: "complete"; jobId: string; result: ImageOptimizeLosslessResult }
  | { type: "unsupported"; jobId: string }
  | { type: "failed"; jobId: string; error: ImageOptimizeWorkerError };

function parseEvent(value: unknown): ParsedEvent | undefined {
  if (!isPlainRecord(value) || value.protocol !== 1 || !isSafeId(value.jobId)) return undefined;
  if (value.type === "inspected" && hasExactKeys(value, ["protocol", "type", "jobId", "result"])) {
    const result = parseInspection(value.result);
    return result === undefined ? undefined : { type: "inspected", jobId: value.jobId, result };
  }
  if (
    value.type === "progress" &&
    hasExactKeys(value, ["protocol", "type", "jobId", "sequence", "phase", "fraction"])
  ) {
    const phases = ["inspecting", "optimizing", "verifying"] as const;
    const { sequence, phase, fraction } = value;
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      typeof phase !== "string" ||
      !phases.includes(phase as (typeof phases)[number]) ||
      fraction !== null
    ) {
      return undefined;
    }
    return {
      type: "progress",
      jobId: value.jobId,
      sequence,
      phase: phase as (typeof phases)[number],
    };
  }
  if (value.type === "complete" && hasExactKeys(value, ["protocol", "type", "jobId", "result"])) {
    const result = parseLosslessResult(value.result);
    return result === undefined ? undefined : { type: "complete", jobId: value.jobId, result };
  }
  if (
    value.type === "unsupported" &&
    hasExactKeys(value, ["protocol", "type", "jobId", "reason"]) &&
    value.reason === "LOSSLESS_SERVER_REQUIRED"
  ) {
    return { type: "unsupported", jobId: value.jobId };
  }
  if (value.type === "failed" && hasExactKeys(value, ["protocol", "type", "jobId", "error"])) {
    const error = parseError(value.error);
    return error === undefined ? undefined : { type: "failed", jobId: value.jobId, error };
  }
  return undefined;
}

function captureItem(
  value: unknown,
  index: number,
): { itemId: string; item?: CapturedItem; error?: ImageOptimizeWorkerError } {
  const fallbackId = `item-${index + 1}`;
  try {
    if (
      !isPlainRecord(value) ||
      !isSafeId(value.itemId) ||
      typeof File === "undefined" ||
      !(value.file instanceof File)
    ) {
      return { itemId: fallbackId, error: INVALID_SPEC_ERROR };
    }
    const { itemId, file } = value;
    if (!hasExactKeys(value, ["itemId", "file"])) return { itemId, error: INVALID_SPEC_ERROR };
    const { name, type: mimeHint, size } = file;
    if (
      !isBoundedString(name, 1, MAX_NAME_LENGTH) ||
      !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
      !Number.isSafeInteger(size)
    ) {
      return { itemId, error: INVALID_SPEC_ERROR };
    }
    if (size < 1 || size > IMAGE_OPTIMIZE_MAX_FILE_BYTES)
      return { itemId, error: MEMORY_LIMIT_ERROR };
    return { itemId, item: { itemId, file, name, mimeHint, byteLength: size } };
  } catch {
    return { itemId: fallbackId, error: INVALID_SPEC_ERROR };
  }
}

function makeJobId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

export function supportsBrowserImageOptimizeRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined";
}

function runBatch<Result>(
  values: readonly { itemId: string; file: File }[],
  type: "inspect" | "lossless",
  callbacks: {
    complete(itemId: string, event: ParsedEvent): Result;
    rejected(itemId: string, error: ImageOptimizeWorkerError): Result;
    cancelled(itemId: string): Result;
    settled?(result: Result): void;
    emit?(event: ParsedEvent, itemId: string): void;
    progress?(completed: number, total: number): void;
  },
): { result: Promise<readonly Result[]>; cancel(): void } {
  let cancelled = false;
  let settled = false;
  let nextIndex = 0;
  let completed = 0;
  let currentIndex: number | undefined;
  let currentJobId: string | undefined;
  let lastSequence = -1;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let worker: Worker | undefined;
  const results: Array<Result | undefined> = new Array(values.length);
  const captured = values.map(captureItem);
  let resolveResult: (value: readonly Result[]) => void = () => undefined;
  const result = new Promise<readonly Result[]>((resolve) => {
    resolveResult = resolve;
  });

  const emit = (event: ParsedEvent, itemId: string) => {
    try {
      callbacks.emit?.(event, itemId);
    } catch {
      // Observers cannot own a processing batch.
    }
  };
  const emitProgress = () => {
    try {
      callbacks.progress?.(completed, values.length);
    } catch {
      // Observers cannot own a processing batch.
    }
  };
  const terminate = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    if (worker !== undefined) worker.terminate();
    worker = undefined;
  };
  const finish = () => {
    if (settled || completed !== values.length) return;
    settled = true;
    terminate();
    resolveResult(results.filter((entry): entry is Result => entry !== undefined));
  };
  const settle = (index: number, value: Result) => {
    if (results[index] !== undefined) return;
    results[index] = value;
    completed += 1;
    currentIndex = undefined;
    currentJobId = undefined;
    lastSequence = -1;
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    try {
      callbacks.settled?.(value);
    } catch {
      // Observers cannot own a processing batch.
    }
    emitProgress();
  };
  const settleUnstarted = (error: ImageOptimizeWorkerError) => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const capturedItem = captured[index];
      if (capturedItem === undefined || results[index] !== undefined) continue;
      settle(index, callbacks.rejected(capturedItem.itemId, error));
    }
  };
  const failWorker = (error: ImageOptimizeWorkerError) => {
    if (settled) return;
    if (currentIndex !== undefined) {
      const capturedItem = captured[currentIndex];
      if (capturedItem !== undefined)
        settle(currentIndex, callbacks.rejected(capturedItem.itemId, error));
    }
    terminate();
    settleUnstarted(error);
    finish();
  };
  const startNext = () => {
    if (settled || cancelled || currentIndex !== undefined) return;
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const capturedItem = captured[index];
      if (capturedItem === undefined || results[index] !== undefined) continue;
      if (capturedItem.error !== undefined || capturedItem.item === undefined) {
        settle(
          index,
          callbacks.rejected(capturedItem.itemId, capturedItem.error ?? INVALID_SPEC_ERROR),
        );
        continue;
      }
      currentIndex = index;
      currentJobId = makeJobId();
      const request: ImageOptimizeWorkerRequest = {
        protocol: 1,
        type,
        jobId: currentJobId,
        input: {
          name: capturedItem.item.name,
          mimeHint: capturedItem.item.mimeHint,
          byteLength: capturedItem.item.byteLength,
          file: capturedItem.item.file,
        },
      };
      timeout = setTimeout(
        () =>
          failWorker({ ...WORKER_FAILURE_ERROR, message: "이미지 작업 시간이 제한을 넘었습니다." }),
        JOB_TIMEOUT_MS,
      );
      try {
        worker?.postMessage(request);
      } catch {
        failWorker(WORKER_FAILURE_ERROR);
      }
      return;
    }
    finish();
  };

  if (values.length === 0) {
    settled = true;
    resolveResult([]);
  } else if (values.length > IMAGE_OPTIMIZE_MAX_FILES) {
    for (let index = 0; index < values.length; index += 1) {
      const item = captured[index];
      if (item !== undefined) settle(index, callbacks.rejected(item.itemId, MEMORY_LIMIT_ERROR));
    }
    finish();
  } else if (!supportsBrowserImageOptimizeRuntime()) {
    for (let index = 0; index < values.length; index += 1) {
      const item = captured[index];
      if (item !== undefined) {
        settle(
          index,
          callbacks.rejected(item.itemId, {
            code: "UNSUPPORTED_INPUT",
            message: "이 브라우저는 로컬 이미지 처리를 지원하지 않습니다.",
            retryable: false,
          }),
        );
      }
    }
    finish();
  } else {
    try {
      worker = new Worker(new URL("./image-optimize.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-image-optimize-worker",
      });
      worker.onmessage = (message: MessageEvent<unknown>) => {
        try {
          if (settled || cancelled || currentIndex === undefined || currentJobId === undefined)
            return;
          const event = parseEvent(message.data);
          if (event === undefined) return failWorker(WORKER_FAILURE_ERROR);
          if (event.jobId !== currentJobId) return;
          const index = currentIndex;
          const item = captured[index];
          if (item === undefined) return failWorker(WORKER_FAILURE_ERROR);
          if (event.type === "progress") {
            if (event.sequence <= lastSequence) return failWorker(WORKER_FAILURE_ERROR);
            lastSequence = event.sequence;
            emit(event, item.itemId);
            return;
          }
          if (
            (type === "inspect" && event.type !== "inspected" && event.type !== "failed") ||
            (type === "lossless" && event.type === "inspected")
          ) {
            return failWorker(WORKER_FAILURE_ERROR);
          }
          if (
            event.type === "complete" &&
            (item.item === undefined || event.result.byteLength > item.item.byteLength)
          ) {
            return failWorker(WORKER_FAILURE_ERROR);
          }
          if (event.type === "failed") {
            settle(index, callbacks.rejected(item.itemId, event.error));
          } else {
            settle(index, callbacks.complete(item.itemId, event));
          }
          startNext();
        } catch {
          failWorker(WORKER_FAILURE_ERROR);
        }
      };
      worker.onerror = () => failWorker(WORKER_FAILURE_ERROR);
      worker.onmessageerror = () => failWorker(WORKER_FAILURE_ERROR);
      startNext();
    } catch {
      failWorker({ ...WORKER_FAILURE_ERROR, message: "브라우저 작업기를 시작하지 못했습니다." });
    }
  }

  return {
    result,
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      if (worker !== undefined && currentJobId !== undefined) {
        try {
          worker.postMessage({ protocol: 1, type: "cancel", jobId: currentJobId });
        } catch {
          // Termination below is the authoritative cancellation path.
        }
      }
      terminate();
      for (let index = 0; index < values.length; index += 1) {
        if (results[index] !== undefined) continue;
        const item = captured[index];
        if (item !== undefined) settle(index, callbacks.cancelled(item.itemId));
      }
      settled = true;
      resolveResult(results.filter((entry): entry is Result => entry !== undefined));
    },
  };
}

export function inspectImageOptimizeFiles(
  items: readonly { itemId: string; file: File }[],
  options: { onProgress?: (completed: number, total: number) => void } = {},
): ImageOptimizeInspectionBatchHandle {
  return runBatch<ImageOptimizeInspectionBatchResult>(items, "inspect", {
    complete(itemId, event) {
      if (event.type !== "inspected")
        return { itemId, status: "rejected", message: WORKER_FAILURE_ERROR.message };
      return { itemId, status: "fulfilled", value: event.result };
    },
    rejected(itemId, error) {
      return { itemId, status: "rejected", message: error.message };
    },
    cancelled(itemId) {
      return { itemId, status: "cancelled" };
    },
    ...(options.onProgress === undefined ? {} : { progress: options.onProgress }),
  });
}

export function runLosslessImageOptimizeBatch(
  items: readonly { itemId: string; file: File }[],
  options: { onEvent?: (event: LocalImageOptimizeRuntimeEvent) => void } = {},
): LocalImageOptimizeBatchHandle {
  return runBatch<LocalImageOptimizeResult>(items, "lossless", {
    complete(itemId, event) {
      if (event.type === "unsupported") {
        return { itemId, status: "unsupported", reason: "LOSSLESS_SERVER_REQUIRED" };
      }
      if (event.type !== "complete")
        return { itemId, status: "rejected", message: WORKER_FAILURE_ERROR.message };
      return { itemId, status: "fulfilled", ...event.result };
    },
    rejected(itemId, error) {
      return error.code === "CANCELLED"
        ? { itemId, status: "cancelled" }
        : { itemId, status: "rejected", message: error.message };
    },
    cancelled(itemId) {
      return { itemId, status: "cancelled" };
    },
    settled(result) {
      options.onEvent?.({ type: "item-complete", itemId: result.itemId, result });
    },
    emit(event, itemId) {
      if (event.type !== "progress") return;
      options.onEvent?.({ type: "item-progress", itemId, phase: event.phase, fraction: null });
    },
    progress(completed, total) {
      options.onEvent?.({ type: "batch-progress", completed, total });
    },
  });
}
