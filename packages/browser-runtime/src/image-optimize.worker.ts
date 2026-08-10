/// <reference lib="webworker" />

import {
  inspectImageHeader,
  readJpegExifOrientation,
  stripJpegMetadata,
  stripPngMetadata,
} from "@hereisit/image-tool";
import {
  IMAGE_OPTIMIZE_MAX_DIMENSION,
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
  type ImageOptimizeInspection,
  type ImageOptimizeLosslessResult,
  type ImageOptimizeWorkerError,
  type ImageOptimizeWorkerEvent,
  type ImageOptimizeWorkerFileInput,
} from "@hereisit/tool-contracts/image-optimize";

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

let activeJob: ActiveJob | undefined;

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

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function candidateJobId(value: unknown): string | undefined {
  try {
    const jobId = ownValue(value, "jobId");
    return isSafeId(jobId) ? jobId : undefined;
  } catch (_error) {
    return undefined;
  }
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

function parseInput(
  value: unknown,
): { input?: ImageOptimizeWorkerFileInput; memoryLimit?: true } | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["name", "mimeHint", "byteLength", "file"])) {
    return undefined;
  }
  const { name, mimeHint, byteLength: declaredLength, file } = value;
  if (
    typeof File === "undefined" ||
    !(file instanceof File) ||
    !isBoundedString(name, 1, MAX_NAME_LENGTH) ||
    !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
    typeof declaredLength !== "number" ||
    !Number.isSafeInteger(declaredLength) ||
    file.name !== name ||
    file.type !== mimeHint ||
    file.size !== declaredLength
  ) {
    return undefined;
  }
  if (declaredLength < 1 || declaredLength > IMAGE_OPTIMIZE_MAX_FILE_BYTES) {
    return { memoryLimit: true };
  }
  return { input: { name, mimeHint, byteLength: declaredLength, file } };
}

function parseRequest(
  value: unknown,
):
  | { type: "inspect" | "lossless"; jobId: string; input: ImageOptimizeWorkerFileInput }
  | { type: "inspect" | "lossless"; jobId: string; memoryLimit: true }
  | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["protocol", "type", "jobId", "input"])) {
    return undefined;
  }
  const { protocol, type, jobId, input } = value;
  if (protocol !== 1 || (type !== "inspect" && type !== "lossless") || !isSafeId(jobId)) {
    return undefined;
  }
  const parsed = parseInput(input);
  if (parsed === undefined) return undefined;
  return parsed.memoryLimit === true
    ? { type, jobId, memoryLimit: true }
    : { type, jobId, input: parsed.input as ImageOptimizeWorkerFileInput };
}

function parseCancel(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["protocol", "type", "jobId"]))
    return undefined;
  const { protocol, type, jobId } = value;
  return protocol === 1 && type === "cancel" && isSafeId(jobId) ? jobId : undefined;
}

function post(event: ImageOptimizeWorkerEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(event, transfer);
}

function safePost(event: ImageOptimizeWorkerEvent, transfer: Transferable[] = []): void {
  try {
    post(event, transfer);
  } catch {
    // The broken channel cannot safely be recovered in this Worker.
  }
}

function failed(
  jobId: string,
  code: ImageOptimizeWorkerError["code"],
  message: string,
  retryable: boolean,
): void {
  safePost({ protocol: 1, type: "failed", jobId, error: { code, message, retryable } });
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let offset = 0; offset + needle.length <= bytes.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

async function read(
  input: ImageOptimizeWorkerFileInput,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  let bytes: unknown;
  try {
    signal.throwIfAborted();
    bytes = await input.file.arrayBuffer();
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("read");
  }
  if (!isOrdinaryArrayBuffer(bytes) || byteLength(bytes) !== input.byteLength)
    throw new Error("bytes");
  return bytes;
}

function inspection(bytes: ArrayBuffer): ImageOptimizeInspection {
  const result = inspectImageHeader(bytes);
  return {
    mime: result.mime,
    width: result.width,
    height: result.height,
    animated: result.animated,
  };
}

function losslessResult(
  bytes: ArrayBuffer,
  result: ImageOptimizeInspection,
): ImageOptimizeLosslessResult | "unsupported" {
  if (result.mime === "image/webp" || result.mime === "image/heic") {
    return "unsupported";
  }
  if (
    (result.mime === "image/jpeg" &&
      (readJpegExifOrientation(bytes) !== 1 ||
        containsAscii(new Uint8Array(bytes), "ICC_PROFILE\0"))) ||
    (result.mime === "image/png" && containsAscii(new Uint8Array(bytes), "iCCP"))
  ) {
    return "unsupported";
  }
  const output = result.mime === "image/jpeg" ? stripJpegMetadata(bytes) : stripPngMetadata(bytes);
  if (!isOrdinaryArrayBuffer(output) || byteLength(output) < 1) throw new Error("output");
  const verified = inspection(output);
  if (
    verified.mime !== result.mime ||
    verified.width !== result.width ||
    verified.height !== result.height ||
    verified.animated
  )
    throw new Error("output");
  return {
    bytes: output,
    byteLength: byteLength(output),
    mime: verified.mime as "image/jpeg" | "image/png",
    width: verified.width,
    height: verified.height,
    warnings: [],
  };
}

async function run(request: Exclude<ReturnType<typeof parseRequest>, undefined>): Promise<void> {
  if ("memoryLimit" in request) {
    failed(request.jobId, "MEMORY_LIMIT", "파일은 30MB 이하만 처리할 수 있습니다.", false);
    return;
  }
  if (activeJob !== undefined) {
    failed(request.jobId, "WORKER_CRASH", "이미지 작업기가 사용 중입니다.", true);
    return;
  }
  const job: ActiveJob = { jobId: request.jobId, controller: new AbortController() };
  activeJob = job;
  let sequence = 0;
  try {
    const emit = (phase: "inspecting" | "optimizing" | "verifying") =>
      post({
        protocol: 1,
        type: "progress",
        jobId: job.jobId,
        sequence: sequence++,
        phase,
        fraction: null,
      });
    emit("inspecting");
    const bytes = await read(request.input, job.controller.signal);
    job.controller.signal.throwIfAborted();
    const inspected = inspection(bytes);
    if (request.type === "inspect") {
      post({ protocol: 1, type: "inspected", jobId: job.jobId, result: inspected });
      return;
    }
    if (
      inspected.width > IMAGE_OPTIMIZE_MAX_DIMENSION ||
      inspected.height > IMAGE_OPTIMIZE_MAX_DIMENSION ||
      inspected.width * inspected.height > IMAGE_OPTIMIZE_MAX_PIXELS
    ) {
      failed(job.jobId, "DIMENSION_LIMIT", "이미지는 4천만 픽셀을 초과할 수 없습니다.", false);
      return;
    }
    if (inspected.animated) {
      failed(job.jobId, "ANIMATED_INPUT", "애니메이션 이미지는 처리할 수 없습니다.", false);
      return;
    }
    if (inspected.mime === "image/heic") {
      failed(job.jobId, "UNSUPPORTED_INPUT", "지원하지 않는 이미지입니다.", false);
      return;
    }
    emit("optimizing");
    const result = losslessResult(bytes, inspected);
    job.controller.signal.throwIfAborted();
    if (result === "unsupported") {
      post({
        protocol: 1,
        type: "unsupported",
        jobId: job.jobId,
        reason: "LOSSLESS_SERVER_REQUIRED",
      });
      return;
    }
    emit("verifying");
    job.controller.signal.throwIfAborted();
    post({ protocol: 1, type: "complete", jobId: job.jobId, result }, [result.bytes]);
  } catch {
    if (job.controller.signal.aborted) {
      failed(job.jobId, "CANCELLED", "작업을 중단했습니다.", false);
    } else {
      failed(job.jobId, "CORRUPT_INPUT", "이미지를 확인할 수 없습니다.", false);
    }
  } finally {
    if (activeJob === job) activeJob = undefined;
  }
}

workerScope.onmessage = (message: MessageEvent<unknown>) => {
  const value = message.data;
  try {
    const cancelJobId = parseCancel(value);
    if (cancelJobId !== undefined) {
      if (activeJob?.jobId === cancelJobId) activeJob.controller.abort();
      return;
    }
    const request = parseRequest(value);
    if (request !== undefined) {
      void run(request);
      return;
    }
    const jobId = candidateJobId(value);
    if (jobId !== undefined)
      failed(jobId, "INVALID_SPEC", "이미지 요청이 올바르지 않습니다.", false);
  } catch {
    const jobId = candidateJobId(value);
    if (jobId !== undefined)
      failed(jobId, "INVALID_SPEC", "이미지 요청이 올바르지 않습니다.", false);
  }
};
