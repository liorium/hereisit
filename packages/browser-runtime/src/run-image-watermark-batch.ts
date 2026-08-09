import { inspectImageHeader } from "@hereisit/image-tool";
import {
  IMAGE_WATERMARK_TOOL_ID,
  IMAGE_WATERMARK_TOOL_VERSION,
  type ImageWatermarkBatchHandle,
  type ImageWatermarkBatchItem,
  type ImageWatermarkBatchItemResult,
  type ImageWatermarkErrorPayload,
  type ImageWatermarkPhase,
  type ImageWatermarkResult,
  type ImageWatermarkRuntimeEvent,
  type ImageWatermarkSpecV1,
  type ImageWatermarkWorkerRequest,
  imageWatermarkSpecSchema,
  type ParsedImageWatermarkSpecV1,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";

export interface RunImageWatermarkBatchOptions {
  logoFile?: File;
  concurrency?: number | "auto";
  onEvent?: (event: ImageWatermarkRuntimeEvent) => void;
}

const MEBIBYTE = 1024 * 1024;
const MAX_BATCH_ITEMS = 100;
const MAX_SOURCE_BYTES = 50 * MEBIBYTE;
const MAX_BATCH_INPUT_BYTES = 250 * MEBIBYTE;
const MAX_LOGO_BYTES = 10 * MEBIBYTE;
const MAX_RESULT_BYTES = 100 * MEBIBYTE;
const MAX_BATCH_RESULT_BYTES = 500 * MEBIBYTE;
const MAX_WORKERS = 2;
const JOB_TIMEOUT_MS = 180_000;
const MAX_SETUP_REPLACEMENTS = 1;
const MAX_ID_LENGTH = 128;
const MAX_INPUT_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const MAX_PUBLIC_MESSAGE_LENGTH = 300;
const MAX_PUBLIC_NAME_LENGTH = 512;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const MEMORY_LIMIT_ERROR: ImageWatermarkErrorPayload = {
  code: "MEMORY_LIMIT",
  message: "이미지는 파일당 50MB, 배치 합계 250MB 이하여야 해요.",
  retryable: false,
};
const INVALID_SPEC_ERROR: ImageWatermarkErrorPayload = {
  code: "INVALID_SPEC",
  message: "이미지 워터마크 요청이 올바르지 않아요.",
  retryable: false,
};
const UNSUPPORTED_INPUT_ERROR: ImageWatermarkErrorPayload = {
  code: "UNSUPPORTED_INPUT",
  message: "이 브라우저는 로컬 이미지 워터마크 처리를 지원하지 않아요.",
  retryable: false,
};
const LOGO_REQUIRED_ERROR: ImageWatermarkErrorPayload = {
  code: "LOGO_REQUIRED",
  message: "사용할 로고 이미지를 선택해 주세요.",
  retryable: false,
};
const CORRUPT_INPUT_ERROR: ImageWatermarkErrorPayload = {
  code: "CORRUPT_INPUT",
  message: "이미지 파일을 읽지 못했어요.",
  retryable: true,
};
const WORKER_FAILURE_ERROR: ImageWatermarkErrorPayload = {
  code: "WORKER_CRASH",
  message: "브라우저 이미지 워터마크 작업기가 중단됐어요.",
  retryable: true,
};
const RESULT_MEMORY_LIMIT_ERROR: ImageWatermarkErrorPayload = {
  code: "MEMORY_LIMIT",
  message: "이미지 결과는 파일당 100MB 이하여야 해요.",
  retryable: false,
};
const BATCH_RESULT_MEMORY_LIMIT_ERROR: ImageWatermarkErrorPayload = {
  code: "MEMORY_LIMIT",
  message: "배치 결과는 총 500MB 이하여야 해요.",
  retryable: false,
};

interface CapturedFile {
  name: string;
  mimeHint: string;
  size: number;
  file: File;
}

interface CapturedItem extends CapturedFile {
  index: number;
  itemId: string;
  spec: ParsedImageWatermarkSpecV1;
  needsLogo: boolean;
}

type SlotState = "starting" | "ready" | "configuring-logo" | "idle" | "running";

interface WorkerSlot {
  worker: Worker;
  state: SlotState;
  generation: number;
  logoConfigured: boolean;
  itemIndex?: number;
  jobId?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
  lastSequence: number;
  lastFraction: number;
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (!isObjectRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every(
      (key) => ownKeys.includes(key) && Object.prototype.propertyIsEnumerable.call(value, key),
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

function isSafePublicText(value: unknown, maximum: number): value is string {
  return (
    isBoundedString(value, 1, maximum) &&
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

function validatedReadBuffer(value: unknown, expectedByteLength: number): ArrayBuffer | undefined {
  try {
    return isOrdinaryArrayBuffer(value) && arrayBufferByteLength(value) === expectedByteLength
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function releaseCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas === undefined) return;
  try {
    canvas.width = 0;
  } catch {
    // Both axes receive independent best-effort release attempts.
  }
  try {
    canvas.height = 0;
  } catch {
    // Both axes receive independent best-effort release attempts.
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

export function supportsBrowserImageWatermarkRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined" && supportsOffscreenCanvas();
}

function makeId(prefix: string): string {
  let suffix: string;
  try {
    suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    suffix = `${Date.now()}-${Math.random()}`;
  }
  return `${prefix}-${suffix}`;
}

function autoConcurrency(): number {
  const memory = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)
    ?.deviceMemory;
  if (memory === undefined || memory <= 4) return 1;
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

function requestedConcurrency(value: RunImageWatermarkBatchOptions["concurrency"]): number {
  if (value === undefined || value === "auto") return autoConcurrency();
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.min(MAX_WORKERS, Math.floor(value)));
}

function captureFile(value: unknown): CapturedFile | undefined {
  if (typeof File === "undefined" || !(value instanceof File)) return undefined;
  try {
    const { name, type: mimeHint, size } = value;
    if (
      !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
      !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
      !Number.isSafeInteger(size)
    ) {
      return undefined;
    }
    return { name, mimeHint, size, file: value };
  } catch {
    return undefined;
  }
}

function captureItem(
  value: unknown,
  index: number,
): { item?: CapturedItem; result?: ImageWatermarkBatchItemResult; size?: number } {
  const fallbackId = `item-${index + 1}`;
  if (!isObjectRecord(value)) {
    return {
      result: { itemId: fallbackId, status: "rejected", error: INVALID_SPEC_ERROR },
    };
  }
  let itemId = fallbackId;
  try {
    if (typeof value.itemId === "string") itemId = value.itemId;
    const file = captureFile(value.file);
    const parsedSpec = imageWatermarkSpecSchema.safeParse(value.spec as ImageWatermarkSpecV1);
    if (!isSafeId(itemId) || file === undefined || !parsedSpec.success) {
      return {
        result: { itemId, status: "rejected", error: INVALID_SPEC_ERROR },
        ...(file === undefined ? {} : { size: file.size }),
      };
    }
    if (file.size < 1 || file.size > MAX_SOURCE_BYTES) {
      return {
        result: { itemId, status: "rejected", error: MEMORY_LIMIT_ERROR },
        size: file.size,
      };
    }
    return {
      item: {
        ...file,
        index,
        itemId,
        spec: parsedSpec.data,
        needsLogo: parsedSpec.data.watermark.kind === "logo",
      },
      size: file.size,
    };
  } catch {
    return {
      result: { itemId, status: "rejected", error: INVALID_SPEC_ERROR },
    };
  }
}

function captureLogo(value: unknown): { logo?: CapturedFile; error?: ImageWatermarkErrorPayload } {
  if (value === undefined) return { error: LOGO_REQUIRED_ERROR };
  const logo = captureFile(value);
  if (logo === undefined) return { error: INVALID_SPEC_ERROR };
  if (logo.size < 1 || logo.size > MAX_LOGO_BYTES) return { error: MEMORY_LIMIT_ERROR };
  const normalizedMime = logo.mimeHint.trim().toLowerCase();
  const hasSupportedFallbackExtension =
    normalizedMime === "" && /\.(?:jpe?g|png|webp)$/i.test(logo.name);
  if (
    !hasSupportedFallbackExtension &&
    normalizedMime !== "image/jpeg" &&
    normalizedMime !== "image/png" &&
    normalizedMime !== "image/webp"
  ) {
    return { error: UNSUPPORTED_INPUT_ERROR };
  }
  return { logo };
}

function decodeReady(value: Record<PropertyKey, unknown>): boolean | undefined {
  if (
    !hasExactKeys(value, ["protocol", "type", "capabilities"]) ||
    value.protocol !== WORKER_PROTOCOL_VERSION ||
    value.type !== "ready"
  ) {
    return undefined;
  }
  const capabilities = value.capabilities;
  if (
    !isPlainRecord(capabilities) ||
    !hasExactKeys(capabilities, ["decode", "encode", "offscreenCanvas"])
  ) {
    return undefined;
  }
  const decode = capabilities.decode;
  const encode = capabilities.encode;
  if (
    !Array.isArray(decode) ||
    !decode.every((entry) => typeof entry === "string") ||
    !Array.isArray(encode) ||
    !encode.every((entry) => typeof entry === "string") ||
    typeof capabilities.offscreenCanvas !== "boolean"
  ) {
    return undefined;
  }
  const required = ["image/jpeg", "image/png", "image/webp"];
  return (
    capabilities.offscreenCanvas &&
    required.every((mime) => decode.includes(mime)) &&
    required.every((mime) => encode.includes(mime))
  );
}

const ERROR_CODES = new Set<ImageWatermarkErrorPayload["code"]>([
  "INVALID_SPEC",
  "UNSUPPORTED_INPUT",
  "ANIMATED_INPUT",
  "CORRUPT_INPUT",
  "DIMENSION_LIMIT",
  "MEMORY_LIMIT",
  "DECODE_FAILED",
  "ENCODE_FAILED",
  "LOGO_REQUIRED",
  "CANCELLED",
  "WORKER_CRASH",
]);

const PHASES = new Set<ImageWatermarkPhase>([
  "validating",
  "decoding",
  "compositing",
  "encoding",
  "finalizing",
]);

function decodeError(value: unknown): ImageWatermarkErrorPayload | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["code", "message", "retryable"])) {
    return undefined;
  }
  const code = value.code;
  const message = value.message;
  const retryable = value.retryable;
  if (
    typeof code !== "string" ||
    !ERROR_CODES.has(code as ImageWatermarkErrorPayload["code"]) ||
    !isSafePublicText(message, MAX_PUBLIC_MESSAGE_LENGTH) ||
    typeof retryable !== "boolean"
  ) {
    return undefined;
  }
  return { code: code as ImageWatermarkErrorPayload["code"], message, retryable };
}

function decodeProgress(
  value: Record<PropertyKey, unknown>,
): { sequence: number; phase: ImageWatermarkPhase; fraction: number } | undefined {
  if (
    !hasExactKeys(value, ["protocol", "type", "jobId", "sequence", "phase", "fraction"]) ||
    value.protocol !== WORKER_PROTOCOL_VERSION ||
    value.type !== "progress"
  ) {
    return undefined;
  }
  const sequence = value.sequence;
  const phase = value.phase;
  const fraction = value.fraction;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    typeof phase !== "string" ||
    !PHASES.has(phase as ImageWatermarkPhase) ||
    typeof fraction !== "number" ||
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    fraction > 1
  ) {
    return undefined;
  }
  return { sequence, phase: phase as ImageWatermarkPhase, fraction };
}

function decodeWarnings(value: unknown): ImageWatermarkResult["warnings"] | undefined {
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const allowed = new Set<ImageWatermarkResult["warnings"][number]>([
    "SOURCE_FORMAT_CONVERTED",
    "COLOR_PROFILE_NORMALIZED",
  ]);
  const decoded: ImageWatermarkResult["warnings"] = [];
  for (const warning of value) {
    if (
      typeof warning !== "string" ||
      !allowed.has(warning as ImageWatermarkResult["warnings"][number]) ||
      decoded.includes(warning as ImageWatermarkResult["warnings"][number])
    ) {
      return undefined;
    }
    decoded.push(warning as ImageWatermarkResult["warnings"][number]);
  }
  return decoded;
}

function decodeTiming(value: unknown): ImageWatermarkResult["timing"] | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["inspectMs", "decodeMs", "compositeMs", "encodeMs", "totalMs"])
  ) {
    return undefined;
  }
  const inspectMs = value.inspectMs;
  const decodeMs = value.decodeMs;
  const compositeMs = value.compositeMs;
  const encodeMs = value.encodeMs;
  const totalMs = value.totalMs;
  const timings = [inspectMs, decodeMs, compositeMs, encodeMs, totalMs];
  if (
    !timings.every(
      (timing) =>
        typeof timing === "number" &&
        Number.isFinite(timing) &&
        timing >= 0 &&
        timing <= JOB_TIMEOUT_MS,
    )
  ) {
    return undefined;
  }
  return {
    inspectMs: inspectMs as number,
    decodeMs: decodeMs as number,
    compositeMs: compositeMs as number,
    encodeMs: encodeMs as number,
    totalMs: totalMs as number,
  };
}

function decodeResult(value: unknown, item: CapturedItem): ImageWatermarkResult | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "bytes",
      "suggestedName",
      "mime",
      "width",
      "height",
      "sourceByteLength",
      "byteLength",
      "format",
      "warnings",
      "timing",
    ])
  ) {
    return undefined;
  }
  const bytes = value.bytes;
  const suggestedName = value.suggestedName;
  const mime = value.mime;
  const width = value.width;
  const height = value.height;
  const sourceByteLength = value.sourceByteLength;
  const byteLength = value.byteLength;
  const format = value.format;
  const warnings = decodeWarnings(value.warnings);
  const timing = decodeTiming(value.timing);
  if (!isOrdinaryArrayBuffer(bytes)) return undefined;
  const actualByteLength = arrayBufferByteLength(bytes);
  let inspected: ReturnType<typeof inspectImageHeader>;
  try {
    inspected = inspectImageHeader(bytes);
  } catch {
    return undefined;
  }
  const formatMatchesMime =
    (mime === "image/jpeg" && format === "jpeg") ||
    (mime === "image/png" && format === "png") ||
    (mime === "image/webp" && format === "webp");
  if (
    !isSafePublicText(suggestedName, MAX_PUBLIC_NAME_LENGTH) ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16_384 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > 16_384 ||
    width * height > 25_000_000 ||
    sourceByteLength !== item.size ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength !== actualByteLength ||
    !formatMatchesMime ||
    inspected.format !== format ||
    inspected.mime !== mime ||
    inspected.width !== width ||
    inspected.height !== height ||
    inspected.animated ||
    warnings === undefined ||
    timing === undefined
  ) {
    return undefined;
  }
  return {
    bytes,
    suggestedName,
    mime,
    width,
    height,
    sourceByteLength: item.size,
    byteLength,
    format,
    warnings,
    timing,
  } as ImageWatermarkResult;
}

export function runImageWatermarkBatch(
  items: readonly ImageWatermarkBatchItem[],
  options: RunImageWatermarkBatchOptions = {},
): ImageWatermarkBatchHandle {
  if (items.length < 1 || items.length > MAX_BATCH_ITEMS) {
    throw new RangeError("Image watermark batches must contain between 1 and 100 items.");
  }

  let cancelled = false;
  let settled = false;
  let completed = 0;
  let outputBytes = 0;
  let resolveResult: (value: readonly ImageWatermarkBatchItemResult[]) => void = () => undefined;
  const result = new Promise<readonly ImageWatermarkBatchItemResult[]>((resolve) => {
    resolveResult = resolve;
  });
  const results: Array<ImageWatermarkBatchItemResult | undefined> = new Array(items.length);
  const capturedItems = new Map<number, CapturedItem>();
  const preflightResults = new Map<number, ImageWatermarkBatchItemResult>();
  const queue: number[] = [];
  const slots = new Set<WorkerSlot>();
  const logoAssetId = makeId("logo");
  let capturedLogo: CapturedFile | undefined;
  let desiredConcurrency = 0;
  let remainingSetupReplacements = MAX_SETUP_REPLACEMENTS;

  const emit = (event: ImageWatermarkRuntimeEvent): void => {
    try {
      if (typeof options.onEvent === "function") options.onEvent(event);
    } catch {
      // Observer failures never alter the batch lifecycle.
    }
  };

  const clearSlotTimeout = (slot: WorkerSlot): void => {
    if (slot.timeoutId !== undefined) {
      clearTimeout(slot.timeoutId);
      delete slot.timeoutId;
    }
  };

  const terminateSlot = (slot: WorkerSlot): void => {
    if (!slots.delete(slot)) return;
    clearSlotTimeout(slot);
    try {
      slot.worker.terminate();
    } catch {
      // Teardown cannot replace the selected public outcomes.
    }
  };

  const finishIfReady = (): void => {
    if (settled || completed !== items.length) return;
    settled = true;
    for (const slot of [...slots]) terminateSlot(slot);
    resolveResult(
      results.filter((entry): entry is ImageWatermarkBatchItemResult => entry !== undefined),
    );
  };

  const recordResult = (index: number, itemResult: ImageWatermarkBatchItemResult): void => {
    if (settled || results[index] !== undefined) return;
    results[index] = itemResult;
    completed += 1;
    emit({ type: "item-complete", itemId: itemResult.itemId, result: itemResult });
    emit({ type: "batch-progress", completed, total: items.length });
  };

  const rejectUnsettled = (error: ImageWatermarkErrorPayload): void => {
    for (let index = 0; index < items.length; index += 1) {
      if (results[index] !== undefined) continue;
      const captured = capturedItems.get(index);
      const raw = items[index] as unknown;
      const itemId =
        captured?.itemId ??
        (isObjectRecord(raw) && typeof raw.itemId === "string" ? raw.itemId : `item-${index + 1}`);
      recordResult(index, { itemId, status: "rejected", error });
    }
    queue.length = 0;
    finishIfReady();
  };

  const settleSlotItem = (
    slot: WorkerSlot,
    itemResult: ImageWatermarkBatchItemResult,
    reuseSlot = true,
  ): void => {
    const index = slot.itemIndex;
    if (index === undefined) return;
    clearSlotTimeout(slot);
    delete slot.itemIndex;
    delete slot.jobId;
    slot.lastSequence = -1;
    slot.lastFraction = -1;
    slot.state = "idle";
    recordResult(index, itemResult);
    finishIfReady();
    if (!settled && !cancelled && reuseSlot && slots.has(slot)) void assignNext(slot);
  };

  const failSlot = (slot: WorkerSlot, error: ImageWatermarkErrorPayload): void => {
    if (!slots.has(slot)) return;
    const setupFailure =
      slot.state === "starting" || slot.state === "ready" || slot.state === "configuring-logo";
    const index = slot.itemIndex;
    const captured = index === undefined ? undefined : capturedItems.get(index);
    slot.generation += 1;
    delete slot.itemIndex;
    delete slot.jobId;
    terminateSlot(slot);
    if (captured !== undefined && results[captured.index] === undefined) {
      recordResult(captured.index, {
        itemId: captured.itemId,
        status: "rejected",
        error,
      });
    }
    finishIfReady();
    if (settled || cancelled || queue.length === 0) return;
    if (setupFailure) {
      if (remainingSetupReplacements === 0) {
        rejectUnsettled(error);
        return;
      }
      remainingSetupReplacements -= 1;
    }
    if (!createSlot() && slots.size === 0) rejectUnsettled(WORKER_FAILURE_ERROR);
  };

  const armSlotTimeout = (slot: WorkerSlot): void => {
    clearSlotTimeout(slot);
    slot.timeoutId = setTimeout(() => {
      if (
        slot.state === "starting" ||
        slot.state === "ready" ||
        slot.state === "configuring-logo"
      ) {
        terminateSlot(slot);
        rejectUnsettled(WORKER_FAILURE_ERROR);
        return;
      }
      failSlot(slot, WORKER_FAILURE_ERROR);
    }, JOB_TIMEOUT_MS);
  };

  async function assignNext(slot: WorkerSlot): Promise<void> {
    if (settled || cancelled || slot.state !== "idle") return;
    const index = queue.shift();
    if (index === undefined) return;
    const captured = capturedItems.get(index);
    if (captured === undefined || results[index] !== undefined) {
      void assignNext(slot);
      return;
    }
    slot.generation += 1;
    const jobId = makeId("job");
    slot.itemIndex = index;
    slot.jobId = jobId;
    slot.state = "running";
    slot.lastSequence = -1;
    slot.lastFraction = -1;
    armSlotTimeout(slot);

    const request: ImageWatermarkWorkerRequest = {
      protocol: WORKER_PROTOCOL_VERSION,
      type: "run",
      jobId,
      tool: IMAGE_WATERMARK_TOOL_ID,
      toolVersion: IMAGE_WATERMARK_TOOL_VERSION,
      input: {
        name: captured.name,
        mimeHint: captured.mimeHint,
        byteLength: captured.size,
        file: captured.file,
      },
      spec: captured.spec,
      ...(captured.needsLogo ? { logoAssetId } : {}),
    };
    try {
      slot.worker.postMessage(request);
    } catch {
      failSlot(slot, WORKER_FAILURE_ERROR);
    }
  }

  const configureLogo = (slot: WorkerSlot): void => {
    if (
      settled ||
      cancelled ||
      slot.state !== "ready" ||
      capturedLogo === undefined
    ) {
      return;
    }
    const request: ImageWatermarkWorkerRequest = {
      protocol: WORKER_PROTOCOL_VERSION,
      type: "configure-logo",
      assetId: logoAssetId,
      tool: IMAGE_WATERMARK_TOOL_ID,
      toolVersion: IMAGE_WATERMARK_TOOL_VERSION,
      input: {
        name: capturedLogo.name,
        mimeHint: capturedLogo.mimeHint,
        byteLength: capturedLogo.size,
        file: capturedLogo.file,
      },
    };
    try {
      clearSlotTimeout(slot);
      slot.state = "configuring-logo";
      armSlotTimeout(slot);
      slot.worker.postMessage(request);
    } catch {
      failSlot(slot, WORKER_FAILURE_ERROR);
    }
  };

  const attachWorker = (slot: WorkerSlot): void => {
    slot.worker.onmessage = (message: MessageEvent<unknown>) => {
      if (settled || cancelled || !slots.has(slot)) return;
      try {
        const value = message.data;
        if (!isPlainRecord(value)) {
          failSlot(slot, WORKER_FAILURE_ERROR);
          return;
        }

        if (slot.state === "starting") {
          if (value.type !== "ready") {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          const supported = decodeReady(value);
          if (supported === undefined) {
            failSlot(slot, WORKER_FAILURE_ERROR);
          } else if (!supported) {
            terminateSlot(slot);
            rejectUnsettled(UNSUPPORTED_INPUT_ERROR);
          } else if (capturedLogo !== undefined) {
            clearSlotTimeout(slot);
            slot.state = "ready";
            armSlotTimeout(slot);
            configureLogo(slot);
          } else {
            clearSlotTimeout(slot);
            slot.state = "idle";
            void assignNext(slot);
          }
          return;
        }

        if (slot.state === "configuring-logo") {
          const eventAssetId = value.assetId;
          if (typeof eventAssetId === "string" && eventAssetId !== logoAssetId) return;
          if (eventAssetId !== logoAssetId) {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          const type = value.type;
          if (type === "logo-ready") {
            if (
              !hasExactKeys(value, ["protocol", "type", "assetId"]) ||
              value.protocol !== WORKER_PROTOCOL_VERSION
            ) {
              failSlot(slot, WORKER_FAILURE_ERROR);
              return;
            }
            clearSlotTimeout(slot);
            slot.logoConfigured = true;
            slot.state = "idle";
            void assignNext(slot);
          } else if (type === "logo-failed") {
            if (
              !hasExactKeys(value, ["protocol", "type", "assetId", "error"]) ||
              value.protocol !== WORKER_PROTOCOL_VERSION
            ) {
              failSlot(slot, WORKER_FAILURE_ERROR);
              return;
            }
            const error = decodeError(value.error);
            if (error === undefined) {
              failSlot(slot, WORKER_FAILURE_ERROR);
              return;
            }
            rejectUnsettled(error);
          } else {
            failSlot(slot, WORKER_FAILURE_ERROR);
          }
          return;
        }

        if (slot.state === "ready") {
          failSlot(slot, WORKER_FAILURE_ERROR);
          return;
        }

        if (slot.state === "idle") {
          if (typeof value.jobId === "string" || typeof value.assetId === "string") return;
          failSlot(slot, WORKER_FAILURE_ERROR);
          return;
        }

        const eventJobId = value.jobId;
        if (typeof eventJobId === "string" && eventJobId !== slot.jobId) return;
        if (eventJobId !== slot.jobId || slot.itemIndex === undefined) {
          failSlot(slot, WORKER_FAILURE_ERROR);
          return;
        }
        const captured = capturedItems.get(slot.itemIndex);
        if (captured === undefined) {
          failSlot(slot, WORKER_FAILURE_ERROR);
          return;
        }
        const type = value.type;
        if (type === "progress") {
          const progress = decodeProgress(value);
          if (progress === undefined) {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          if (progress.sequence <= slot.lastSequence || progress.fraction < slot.lastFraction) {
            return;
          }
          slot.lastSequence = progress.sequence;
          slot.lastFraction = progress.fraction;
          emit({
            type: "item-progress",
            itemId: captured.itemId,
            phase: progress.phase,
            fraction: progress.fraction,
          });
          return;
        }
        if (type === "complete") {
          if (
            !hasExactKeys(value, ["protocol", "type", "jobId", "result"]) ||
            value.protocol !== WORKER_PROTOCOL_VERSION
          ) {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          const decoded = decodeResult(value.result, captured);
          if (decoded === undefined) {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          if (decoded.byteLength > MAX_RESULT_BYTES) {
            settleSlotItem(slot, {
              itemId: captured.itemId,
              status: "rejected",
              error: RESULT_MEMORY_LIMIT_ERROR,
            });
          } else if (outputBytes + decoded.byteLength > MAX_BATCH_RESULT_BYTES) {
            settleSlotItem(slot, {
              itemId: captured.itemId,
              status: "rejected",
              error: BATCH_RESULT_MEMORY_LIMIT_ERROR,
            });
          } else {
            outputBytes += decoded.byteLength;
            settleSlotItem(slot, {
              itemId: captured.itemId,
              status: "fulfilled",
              value: decoded,
            });
          }
        } else if (type === "failed") {
          if (
            !hasExactKeys(value, ["protocol", "type", "jobId", "error"]) ||
            value.protocol !== WORKER_PROTOCOL_VERSION
          ) {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          const error = decodeError(value.error);
          if (error === undefined) {
            failSlot(slot, WORKER_FAILURE_ERROR);
            return;
          }
          settleSlotItem(slot, {
            itemId: captured.itemId,
            status: "rejected",
            error,
          });
        } else {
          failSlot(slot, WORKER_FAILURE_ERROR);
        }
      } catch {
        failSlot(slot, WORKER_FAILURE_ERROR);
      }
    };
    const workerFailure = (): void => {
      if (settled || cancelled || !slots.has(slot)) return;
      failSlot(slot, WORKER_FAILURE_ERROR);
    };
    slot.worker.onerror = workerFailure;
    slot.worker.onmessageerror = workerFailure;
  };

  function createSlot(): boolean {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./image-watermark.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-image-watermark-worker",
      });
    } catch {
      return false;
    }
    const slot: WorkerSlot = {
      worker,
      state: "starting",
      generation: 0,
      logoConfigured: false,
      lastSequence: -1,
      lastFraction: -1,
    };
    slots.add(slot);
    attachWorker(slot);
    armSlotTimeout(slot);
    return true;
  }

  let totalInputBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    const captured = captureItem(items[index], index);
    if (captured.size !== undefined && Number.isSafeInteger(captured.size) && captured.size > 0) {
      totalInputBytes += captured.size;
    }
    if (captured.item !== undefined) {
      capturedItems.set(index, captured.item);
      queue.push(index);
    } else if (captured.result !== undefined) {
      preflightResults.set(index, captured.result);
    }
  }

  const needsLogo = [...capturedItems.values()].some((captured) => captured.needsLogo);
  if (totalInputBytes > MAX_BATCH_INPUT_BYTES) {
    rejectUnsettled(MEMORY_LIMIT_ERROR);
  } else if (needsLogo) {
    const logo = captureLogo(options.logoFile);
    if (logo.error !== undefined) {
      rejectUnsettled(logo.error);
    } else {
      capturedLogo = logo.logo;
    }
  }

  if (!settled && queue.length > 0 && !supportsBrowserImageWatermarkRuntime()) {
    rejectUnsettled(UNSUPPORTED_INPUT_ERROR);
  }

  if (!settled) {
    for (const [index, itemResult] of preflightResults) recordResult(index, itemResult);
    if (queue.length === 0) {
      finishIfReady();
    } else {
      desiredConcurrency = Math.min(requestedConcurrency(options.concurrency), queue.length);
      for (let index = 0; index < desiredConcurrency; index += 1) {
        if (!createSlot()) break;
      }
      if (slots.size === 0) rejectUnsettled(WORKER_FAILURE_ERROR);
    }
  }

  return {
    result,
    cancel(): void {
      if (settled || cancelled) return;
      cancelled = true;
      for (const slot of [...slots]) {
        if (slot.state === "running" && slot.jobId !== undefined) {
          try {
            slot.worker.postMessage({
              protocol: WORKER_PROTOCOL_VERSION,
              type: "cancel",
              jobId: slot.jobId,
            });
          } catch {
            // Cancellation remains authoritative when a Worker port is already closed.
          }
        }
        terminateSlot(slot);
      }
      for (let index = 0; index < items.length; index += 1) {
        if (results[index] !== undefined) continue;
        const captured = capturedItems.get(index);
        const raw = items[index] as unknown;
        const itemId =
          captured?.itemId ??
          (isObjectRecord(raw) && typeof raw.itemId === "string"
            ? raw.itemId
            : `item-${index + 1}`);
        results[index] = { itemId, status: "cancelled" };
      }
      queue.length = 0;
      settled = true;
      resolveResult(
        results.filter((entry): entry is ImageWatermarkBatchItemResult => entry !== undefined),
      );
    },
  };
}
