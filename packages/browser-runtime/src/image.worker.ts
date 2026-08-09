/// <reference lib="webworker" />

import {
  IMAGE_TOOL_ID,
  IMAGE_TOOL_VERSION,
  type ImageWorkerFileInput,
  imagePipelineSpecSchema,
  type ToolErrorPayload,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
} from "@hereisit/tool-contracts";
import { ImagePipelineError, processImagePipeline } from "./image-pipeline";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const FALLBACK_ERROR_MESSAGE = "이미지를 처리하는 중 오류가 발생했습니다.";
const CANCELLED_MESSAGE = "작업을 중단했습니다.";
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

interface RunEnvelope {
  jobId: string;
  tool: unknown;
  toolVersion: unknown;
  input: ImageWorkerFileInput;
  spec: unknown;
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
  } catch {
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

function arrayBufferByteLength(value: ArrayBuffer): number {
  if (ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) throw new TypeError();
  return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []) as number;
}

function parseFileInput(value: unknown): ImageWorkerFileInput | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["name", "mimeHint", "byteLength", "file"])) {
    return undefined;
  }
  const { name, mimeHint, byteLength, file } = value;
  if (
    typeof File === "undefined" ||
    !(file instanceof File) ||
    !isBoundedString(name, 1, MAX_NAME_LENGTH) ||
    !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MAX_INPUT_BYTES ||
    file.name !== name ||
    file.type !== mimeHint ||
    file.size !== byteLength
  ) {
    return undefined;
  }
  return { name, mimeHint, byteLength, file };
}

function parseRunEnvelope(value: unknown): RunEnvelope | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (!hasExactKeys(value, ["protocol", "type", "jobId", "tool", "toolVersion", "input", "spec"])) {
    return undefined;
  }
  const { protocol, type, jobId, tool, toolVersion, input: rawInput, spec } = value;
  if (protocol !== WORKER_PROTOCOL_VERSION || type !== "run" || !isSafeId(jobId)) return undefined;
  const input = parseFileInput(rawInput);
  return input === undefined ? undefined : { jobId, tool, toolVersion, input, spec };
}

async function readFileInput(
  input: ImageWorkerFileInput,
  signal: AbortSignal,
): Promise<{ name: string; mimeHint: string; byteLength: number; bytes: ArrayBuffer }> {
  let bytes: unknown;
  try {
    signal.throwIfAborted();
    bytes = await input.file.arrayBuffer();
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ImagePipelineError("CORRUPT_INPUT", "이미지 파일을 읽지 못했습니다.", true);
  }
  try {
    if (!isOrdinaryArrayBuffer(bytes) || arrayBufferByteLength(bytes) !== input.byteLength) {
      throw new ImagePipelineError("CORRUPT_INPUT", "이미지 파일 크기를 확인하지 못했습니다.");
    }
  } catch (error) {
    if (error instanceof ImagePipelineError) throw error;
    throw new ImagePipelineError("CORRUPT_INPUT", "이미지 파일 크기를 확인하지 못했습니다.");
  }
  return { name: input.name, mimeHint: input.mimeHint, byteLength: input.byteLength, bytes };
}

function post(event: WorkerEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(event, transfer);
}

function safePost(event: WorkerEvent): void {
  try {
    post(event);
  } catch {
    // A broken message channel cannot be recovered inside this Worker.
  }
}

function serializeError(error: unknown): ToolErrorPayload {
  if (error instanceof ImagePipelineError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "WORKER_CRASH", message: FALLBACK_ERROR_MESSAGE, retryable: true };
}

function invalidRun(jobId: string, message = "이미지 변환 요청이 올바르지 않습니다."): void {
  safePost({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "failed",
    jobId,
    error: { code: "INVALID_SPEC", message, retryable: false },
  });
}

function parseCancel(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["protocol", "type", "jobId"]))
    return undefined;
  const { protocol, type, jobId } = value;
  return protocol === WORKER_PROTOCOL_VERSION && type === "cancel" && isSafeId(jobId)
    ? jobId
    : undefined;
}

function parseSpec(value: unknown) {
  try {
    const parsed = imagePipelineSpecSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function run(request: RunEnvelope): Promise<void> {
  if (request.tool !== IMAGE_TOOL_ID || request.toolVersion !== IMAGE_TOOL_VERSION) {
    invalidRun(request.jobId, "지원하지 않는 도구 버전입니다.");
    return;
  }
  if (activeJob !== undefined) {
    safePost({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "failed",
      jobId: request.jobId,
      error: { code: "WORKER_CRASH", message: FALLBACK_ERROR_MESSAGE, retryable: true },
    });
    return;
  }

  const parsedSpec = parseSpec(request.spec);
  if (parsedSpec === undefined) {
    invalidRun(request.jobId, "이미지 변환 설정이 올바르지 않습니다.");
    return;
  }

  const job: ActiveJob = { jobId: request.jobId, controller: new AbortController() };
  activeJob = job;
  let sequence = 0;
  try {
    job.controller.signal.throwIfAborted();
    const input = await readFileInput(request.input, job.controller.signal);
    job.controller.signal.throwIfAborted();
    const result = await processImagePipeline(input, parsedSpec, (phase, fraction) => {
      job.controller.signal.throwIfAborted();
      post({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "progress",
        jobId: request.jobId,
        sequence: sequence++,
        phase,
        fraction,
      });
    });
    job.controller.signal.throwIfAborted();
    post({ protocol: WORKER_PROTOCOL_VERSION, type: "complete", jobId: request.jobId, result }, [
      result.bytes,
    ]);
  } catch (error) {
    const payload: ToolErrorPayload = job.controller.signal.aborted
      ? { code: "CANCELLED", message: CANCELLED_MESSAGE, retryable: false }
      : serializeError(error);
    safePost({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "failed",
      jobId: request.jobId,
      error: payload,
    });
  } finally {
    if (activeJob === job) activeJob = undefined;
  }
}

workerScope.onmessage = (message: MessageEvent<unknown>) => {
  const request = message.data;
  try {
    const cancelJobId = parseCancel(request);
    if (cancelJobId !== undefined) {
      if (activeJob?.jobId === cancelJobId) activeJob.controller.abort();
      return;
    }

    const jobId = candidateJobId(request);
    const runRequest = parseRunEnvelope(request);
    if (runRequest === undefined) {
      if (jobId !== undefined) invalidRun(jobId);
      return;
    }
    void run(runRequest);
  } catch {
    const jobId = candidateJobId(request);
    if (jobId !== undefined) invalidRun(jobId);
  }
};

post({
  protocol: WORKER_PROTOCOL_VERSION,
  type: "ready",
  capabilities: {
    decode: ["image/jpeg", "image/png", "image/webp"],
    encode: ["image/jpeg", "image/png", "image/webp"],
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
  },
});
