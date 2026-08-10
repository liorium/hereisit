import {
  type BatchHandle,
  type BatchImageItem,
  type BatchItemResult,
  type BatchRuntimeEvent,
  IMAGE_TOOL_ID,
  IMAGE_TOOL_VERSION,
  type ImagePhase,
  type ImagePipelineResult,
  type ImageWarning,
  type ToolErrorPayload,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
  type WorkerRequest,
} from "@hereisit/tool-contracts";

export interface RunImageBatchOptions {
  concurrency?: number | "auto";
  onEvent?: (event: BatchRuntimeEvent) => void;
}

const MAX_WORKERS = 2;
const MAX_RESULT_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_OUTPUT_BYTES = 500 * 1024 * 1024;
const JOB_TIMEOUT_MS = 180_000;
const MAX_ID_LENGTH = 128;
const MAX_PUBLIC_TEXT_LENGTH = 300;
const MAX_PUBLIC_NAME_LENGTH = 512;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const WORKER_FAILURE_ERROR: ToolErrorPayload = {
  code: "WORKER_CRASH",
  message: "브라우저 작업기가 중단되었습니다.",
  retryable: true,
};
const RESULT_MEMORY_LIMIT_ERROR: ToolErrorPayload = {
  code: "MEMORY_LIMIT",
  message: "이미지 결과는 파일당 100MB 이하여야 합니다.",
  retryable: false,
};
const BATCH_RESULT_MEMORY_LIMIT_ERROR: ToolErrorPayload = {
  code: "MEMORY_LIMIT",
  message: "배치 결과가 총 500MB 제한을 넘었습니다.",
  retryable: false,
};

interface WorkerSlot {
  worker: Worker;
  itemIndex?: number;
  jobId?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
  lastSequence: number;
  lastFraction: number;
}

type ParsedWorkerEvent =
  | Extract<WorkerEvent, { type: "ready" }>
  | Extract<WorkerEvent, { type: "progress" }>
  | Extract<WorkerEvent, { type: "complete" }>
  | Extract<WorkerEvent, { type: "failed" }>;

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

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim().length > 0 &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function isSafePublicText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code > 31 &&
        code !== 127 &&
        (code < 0x80 || code > 0x9f) &&
        code !== 0x061c &&
        code !== 0x200e &&
        code !== 0x200f &&
        (code < 0x202a || code > 0x202e) &&
        (code < 0x2066 || code > 0x2069)
      );
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

function arrayBufferByteLength(value: ArrayBuffer): number {
  if (ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined)
    throw new TypeError("ArrayBuffer unavailable.");
  return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []) as number;
}

function parseToolError(value: unknown): ToolErrorPayload | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["code", "message", "retryable"])) {
    return undefined;
  }
  const codes: readonly ToolErrorPayload["code"][] = [
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
    !codes.includes(value.code as ToolErrorPayload["code"]) ||
    !isSafePublicText(value.message, MAX_PUBLIC_TEXT_LENGTH) ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    code: value.code as ToolErrorPayload["code"],
    message: value.message,
    retryable: value.retryable,
  };
}

function parsePipelineResult(value: unknown): ImagePipelineResult | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "bytes",
      "suggestedName",
      "mime",
      "width",
      "height",
      "byteLength",
      "warnings",
      "timing",
    ])
  ) {
    return undefined;
  }
  const {
    bytes,
    suggestedName,
    mime,
    width,
    height,
    byteLength,
    warnings: rawWarnings,
    timing,
  } = value;
  const mimes = ["image/jpeg", "image/png", "image/webp"] as const;
  const warnings = [
    "TARGET_SIZE_NOT_REACHED",
    "UPSCALING_SKIPPED",
    "COLOR_PROFILE_NORMALIZED",
  ] as const;
  const phases = ["inspectMs", "decodeMs", "transformMs", "encodeMs", "totalMs"] as const;
  if (
    !isOrdinaryArrayBuffer(bytes) ||
    !isSafePublicText(suggestedName, MAX_PUBLIC_NAME_LENGTH) ||
    typeof mime !== "string" ||
    !mimes.includes(mime as ImagePipelineResult["mime"]) ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16_384 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > 16_384 ||
    width * height > 25_000_000 ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    arrayBufferByteLength(bytes) !== byteLength ||
    !Array.isArray(rawWarnings) ||
    rawWarnings.length > warnings.length ||
    !rawWarnings.every(
      (warning) =>
        typeof warning === "string" &&
        warnings.includes(warning as ImageWarning) &&
        rawWarnings.indexOf(warning) === rawWarnings.lastIndexOf(warning),
    ) ||
    !isPlainRecord(timing) ||
    !hasExactKeys(timing, [...phases, "encodeAttempts"]) ||
    !phases.every(
      (key) =>
        typeof timing[key] === "number" &&
        Number.isFinite(timing[key]) &&
        timing[key] >= 0 &&
        timing[key] <= JOB_TIMEOUT_MS,
    ) ||
    typeof timing.encodeAttempts !== "number" ||
    !Number.isSafeInteger(timing.encodeAttempts) ||
    timing.encodeAttempts < 1
  ) {
    return undefined;
  }
  return {
    bytes,
    suggestedName,
    mime: mime as ImagePipelineResult["mime"],
    width,
    height,
    byteLength,
    warnings: rawWarnings as ImageWarning[],
    timing: {
      inspectMs: timing.inspectMs as number,
      decodeMs: timing.decodeMs as number,
      transformMs: timing.transformMs as number,
      encodeMs: timing.encodeMs as number,
      totalMs: timing.totalMs as number,
      encodeAttempts: timing.encodeAttempts,
    },
  };
}

function parseWorkerEvent(value: unknown): ParsedWorkerEvent | undefined {
  if (!isPlainRecord(value) || value.protocol !== WORKER_PROTOCOL_VERSION) return undefined;
  if (value.type === "ready") {
    if (
      !hasExactKeys(value, ["protocol", "type", "capabilities"]) ||
      !isPlainRecord(value.capabilities) ||
      !hasExactKeys(value.capabilities, ["decode", "encode", "offscreenCanvas"]) ||
      !Array.isArray(value.capabilities.decode) ||
      !value.capabilities.decode.every((mime) => typeof mime === "string") ||
      !Array.isArray(value.capabilities.encode) ||
      !value.capabilities.encode.every((mime) => typeof mime === "string") ||
      typeof value.capabilities.offscreenCanvas !== "boolean"
    ) {
      return undefined;
    }
    return value as Extract<WorkerEvent, { type: "ready" }>;
  }
  if (!isSafeId(value.jobId)) return undefined;
  if (value.type === "progress") {
    const phase: readonly ImagePhase[] = [
      "validating",
      "decoding",
      "transforming",
      "encoding",
      "finalizing",
    ];
    const { sequence, phase: rawPhase, fraction } = value;
    if (
      !hasExactKeys(value, ["protocol", "type", "jobId", "sequence", "phase", "fraction"]) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      typeof rawPhase !== "string" ||
      !phase.includes(rawPhase as ImagePhase) ||
      typeof fraction !== "number" ||
      !Number.isFinite(fraction) ||
      fraction < 0 ||
      fraction > 1
    ) {
      return undefined;
    }
    return {
      protocol: 1,
      type: "progress",
      jobId: value.jobId,
      sequence,
      phase: rawPhase as ImagePhase,
      fraction,
    };
  }
  if (value.type === "complete") {
    if (!hasExactKeys(value, ["protocol", "type", "jobId", "result"])) return undefined;
    const result = parsePipelineResult(value.result);
    return result === undefined
      ? undefined
      : { protocol: 1, type: "complete", jobId: value.jobId, result };
  }
  if (value.type === "failed") {
    if (!hasExactKeys(value, ["protocol", "type", "jobId", "error"])) return undefined;
    const error = parseToolError(value.error);
    return error === undefined
      ? undefined
      : { protocol: 1, type: "failed", jobId: value.jobId, error };
  }
  return undefined;
}

function makeJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function autoConcurrency(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  const memory = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)
    ?.deviceMemory;
  if (memory === undefined || memory <= 4) return 1;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

export function supportsBrowserImageRuntime(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof File !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}

export function runImageBatch(
  items: readonly BatchImageItem[],
  options: RunImageBatchOptions = {},
): BatchHandle {
  let cancelled = false;
  let settled = false;
  let nextIndex = 0;
  let completed = 0;
  let outputBytes = 0;
  let resolveResult: (value: readonly BatchItemResult[]) => void = () => undefined;
  const results: Array<BatchItemResult | undefined> = new Array(items.length);
  const slots = new Set<WorkerSlot>();
  const result = new Promise<readonly BatchItemResult[]>((resolve) => {
    resolveResult = resolve;
  });

  const emit = (event: BatchRuntimeEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      return;
    }
  };

  const clearSlotTimeout = (slot: WorkerSlot) => {
    if (slot.timeoutId !== undefined) clearTimeout(slot.timeoutId);
    delete slot.timeoutId;
  };

  const finishIfReady = () => {
    if (settled || completed !== items.length) return;
    settled = true;
    for (const slot of slots) {
      clearSlotTimeout(slot);
      slot.worker.terminate();
    }
    slots.clear();
    resolveResult(results.filter((entry): entry is BatchItemResult => entry !== undefined));
  };

  const settleItem = (
    index: number,
    itemResult: BatchItemResult,
    slot: WorkerSlot,
    reuseSlot = true,
  ) => {
    if (results[index] !== undefined) return;
    const item = items[index];
    if (item === undefined) return;
    results[index] = itemResult;
    completed += 1;
    emit({ type: "item-complete", itemId: item.itemId, result: itemResult });
    emit({ type: "batch-progress", completed, total: items.length });
    clearSlotTimeout(slot);
    delete slot.itemIndex;
    delete slot.jobId;
    slot.lastSequence = -1;
    slot.lastFraction = 0;
    finishIfReady();
    if (!settled && reuseSlot && slots.has(slot)) assignNext(slot);
  };

  const replaceCrashedWorker = (slot: WorkerSlot, error: ToolErrorPayload) => {
    if (!slots.has(slot)) return;
    const index = slot.itemIndex;
    clearSlotTimeout(slot);
    slot.worker.terminate();
    slots.delete(slot);
    if (index !== undefined) {
      const item = items[index];
      if (item !== undefined) {
        settleItem(index, { itemId: item.itemId, status: "rejected", error }, slot, false);
      }
    }
    if (!cancelled && !settled && nextIndex < items.length) createSlot();
  };

  const armSlotTimeout = (slot: WorkerSlot) => {
    clearSlotTimeout(slot);
    slot.timeoutId = setTimeout(() => {
      replaceCrashedWorker(slot, {
        ...WORKER_FAILURE_ERROR,
        message: "이미지 작업 시간이 제한을 넘었습니다.",
      });
    }, JOB_TIMEOUT_MS);
  };

  const attachWorker = (slot: WorkerSlot) => {
    slot.worker.onmessage = (message: MessageEvent<unknown>) => {
      if (cancelled || settled || !slots.has(slot)) return;
      try {
        const value = message.data;
        if (!isPlainRecord(value)) {
          if (slot.itemIndex !== undefined) replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
          return;
        }
        const jobId = value.jobId;
        if (typeof jobId === "string" && jobId !== slot.jobId) return;
        const event = parseWorkerEvent(value);
        if (event?.type === "ready") return;
        if (event === undefined || event.jobId !== slot.jobId || slot.itemIndex === undefined) {
          replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
          return;
        }
        const index = slot.itemIndex;
        const item = items[index];
        if (item === undefined) {
          replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
          return;
        }
        if (event.type === "progress") {
          if (event.sequence <= slot.lastSequence || event.fraction < slot.lastFraction) {
            replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
            return;
          }
          slot.lastSequence = event.sequence;
          slot.lastFraction = event.fraction;
          emit({
            type: "item-progress",
            itemId: item.itemId,
            phase: event.phase,
            fraction: event.fraction,
          });
          return;
        }
        if (event.type === "complete") {
          if (event.result.byteLength > MAX_RESULT_BYTES) {
            settleItem(
              index,
              { itemId: item.itemId, status: "rejected", error: RESULT_MEMORY_LIMIT_ERROR },
              slot,
            );
          } else if (outputBytes + event.result.byteLength > MAX_BATCH_OUTPUT_BYTES) {
            settleItem(
              index,
              { itemId: item.itemId, status: "rejected", error: BATCH_RESULT_MEMORY_LIMIT_ERROR },
              slot,
            );
          } else {
            outputBytes += event.result.byteLength;
            settleItem(
              index,
              { itemId: item.itemId, status: "fulfilled", value: event.result },
              slot,
            );
          }
          return;
        }
        settleItem(index, { itemId: item.itemId, status: "rejected", error: event.error }, slot);
      } catch {
        replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
      }
    };

    const handleWorkerFailure = () => {
      replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
    };
    slot.worker.onerror = handleWorkerFailure;
    slot.worker.onmessageerror = handleWorkerFailure;
  };

  function assignNext(slot: WorkerSlot): void {
    if (cancelled || settled || slot.itemIndex !== undefined || nextIndex >= items.length) return;
    const index = nextIndex++;
    const item = items[index];
    if (item === undefined) return;
    slot.itemIndex = index;
    slot.jobId = makeJobId();
    armSlotTimeout(slot);

    try {
      const request: WorkerRequest = {
        protocol: 1,
        type: "run",
        jobId: slot.jobId,
        tool: IMAGE_TOOL_ID,
        toolVersion: IMAGE_TOOL_VERSION,
        input: {
          name: item.file.name,
          mimeHint: item.file.type,
          byteLength: item.file.size,
          file: item.file,
        },
        spec: item.spec,
      };
      slot.worker.postMessage(request);
    } catch {
      replaceCrashedWorker(slot, WORKER_FAILURE_ERROR);
    }
  }

  function rejectRemaining(error: ToolErrorPayload): void {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined || results[index] !== undefined) continue;
      const itemResult: BatchItemResult = { itemId: item.itemId, status: "rejected", error };
      results[index] = itemResult;
      completed += 1;
      emit({ type: "item-complete", itemId: item.itemId, result: itemResult });
      emit({ type: "batch-progress", completed, total: items.length });
    }
    finishIfReady();
  }

  function createSlot(): void {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./image.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-image-worker",
      });
    } catch {
      if (slots.size === 0) {
        rejectRemaining({
          code: "WORKER_CRASH",
          message: "브라우저 작업기를 시작하지 못했습니다.",
          retryable: true,
        });
      }
      return;
    }
    const slot: WorkerSlot = { worker, lastSequence: -1, lastFraction: 0 };
    slots.add(slot);
    attachWorker(slot);
    assignNext(slot);
  }

  if (items.length === 0) {
    settled = true;
    resolveResult([]);
  } else if (!supportsBrowserImageRuntime()) {
    settled = true;
    resolveResult(
      items.map((item) => ({
        itemId: item.itemId,
        status: "rejected" as const,
        error: {
          code: "UNSUPPORTED_INPUT" as const,
          message: "이 브라우저는 로컬 이미지 처리를 지원하지 않습니다.",
          retryable: false,
        },
      })),
    );
  } else {
    const requested =
      options.concurrency === "auto" || options.concurrency === undefined
        ? autoConcurrency()
        : Number.isFinite(options.concurrency) && options.concurrency > 0
          ? options.concurrency
          : 1;
    const concurrency = Math.max(1, Math.min(MAX_WORKERS, Math.floor(requested), items.length));
    for (let index = 0; index < concurrency && !settled; index += 1) createSlot();
  }

  return {
    result,
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      for (const slot of slots) {
        clearSlotTimeout(slot);
        slot.worker.terminate();
      }
      slots.clear();
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (results[index] === undefined && item !== undefined) {
          results[index] = { itemId: item.itemId, status: "cancelled" };
        }
      }
      settled = true;
      resolveResult(results.filter((entry): entry is BatchItemResult => entry !== undefined));
    },
  };
}
