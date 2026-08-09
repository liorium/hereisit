/// <reference lib="webworker" />

import {
  IMAGE_WATERMARK_TOOL_ID,
  IMAGE_WATERMARK_TOOL_VERSION,
  type ImageWatermarkErrorPayload,
  type ImageWatermarkInput,
  type ImageWatermarkPhase,
  type ImageWatermarkWorkerEvent,
  type ImageWatermarkWorkerFileInput,
  imageWatermarkSpecSchema,
  type ParsedImageWatermarkSpecV1,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import {
  closePreparedImageWatermarkLogo,
  ImageWatermarkPipelineError,
  type PreparedImageWatermarkLogo,
  prepareImageWatermarkLogo,
  processImageWatermarkPipeline,
  toImageWatermarkErrorPayload,
} from "./image-watermark-pipeline";

const MEBIBYTE = 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * MEBIBYTE;
const MAX_LOGO_BYTES = 10 * MEBIBYTE;
const MAX_ID_LENGTH = 128;
const MAX_INPUT_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const INVALID_SPEC_MESSAGE = "이미지 워터마크 요청이 올바르지 않아요.";
const CONCURRENT_RUN_MESSAGE = "이미지 워터마크 작업기가 이미 다른 요청을 처리하고 있어요.";
const CONCURRENT_LOGO_MESSAGE = "이미지 워터마크 작업 중에는 로고를 바꿀 수 없어요.";
const LOGO_REQUIRED_MESSAGE = "사용할 로고 이미지를 다시 선택해 주세요.";
const CANCELLED_MESSAGE = "이미지 워터마크 작업을 중단했어요.";
const WORKER_CRASH_MESSAGE = "이미지 워터마크 작업을 완료하지 못했어요.";
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface ConfigureLogoEnvelope {
  assetId: string;
  tool: unknown;
  toolVersion: unknown;
  input: ImageWatermarkWorkerFileInput;
}

interface RunEnvelope {
  jobId: string;
  tool: unknown;
  toolVersion: unknown;
  input: ImageWatermarkWorkerFileInput;
  spec: unknown;
  logoAssetId: string | undefined;
}

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

interface ActiveLogoConfiguration {
  assetId: string;
  controller: AbortController;
}

let activeJob: { jobId: string; controller: AbortController } | undefined;
let configuredLogo: { assetId: string; prepared: PreparedImageWatermarkLogo } | undefined;
let activeLogoConfiguration: ActiveLogoConfiguration | undefined;

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

function arrayBufferByteLength(value: ArrayBuffer): number {
  if (ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) {
    throw new TypeError("ArrayBuffer byte length is unavailable.");
  }
  return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []) as number;
}

function parseFileInput(
  value: unknown,
  maximumBytes: number,
): ImageWatermarkWorkerFileInput | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["name", "mimeHint", "byteLength", "file"])) {
    return undefined;
  }
  const { name, mimeHint, byteLength, file } = value;
  if (
    typeof File === "undefined" ||
    !(file instanceof File) ||
    !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
    !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > maximumBytes ||
    file.name !== name ||
    file.type !== mimeHint ||
    file.size !== byteLength
  ) {
    return undefined;
  }
  return { name, mimeHint, byteLength, file };
}

async function readFileInput(
  input: ImageWatermarkWorkerFileInput,
  signal: AbortSignal,
): Promise<ImageWatermarkInput> {
  let bytes: unknown;
  try {
    signal.throwIfAborted();
    bytes = await input.file.arrayBuffer();
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ImageWatermarkPipelineError("CORRUPT_INPUT", "이미지 파일을 읽지 못했어요.", true);
  }
  try {
    if (!isOrdinaryArrayBuffer(bytes) || arrayBufferByteLength(bytes) !== input.byteLength) {
      throw new ImageWatermarkPipelineError(
        "CORRUPT_INPUT",
        "이미지 파일 크기를 확인하지 못했어요.",
      );
    }
  } catch (error) {
    if (error instanceof ImageWatermarkPipelineError) throw error;
    throw new ImageWatermarkPipelineError("CORRUPT_INPUT", "이미지 파일 크기를 확인하지 못했어요.");
  }
  return { name: input.name, mimeHint: input.mimeHint, byteLength: input.byteLength, bytes };
}

function parseConfigureLogoEnvelope(
  value: Record<PropertyKey, unknown>,
  assetId: string,
): ConfigureLogoEnvelope | undefined {
  if (!hasExactKeys(value, ["protocol", "type", "assetId", "tool", "toolVersion", "input"])) {
    return undefined;
  }
  const tool = value.tool;
  const toolVersion = value.toolVersion;
  const rawInput = value.input;
  const input = parseFileInput(rawInput, MAX_LOGO_BYTES);
  if (input === undefined) return undefined;
  return { assetId, tool, toolVersion, input };
}

function parseRunEnvelope(
  value: Record<PropertyKey, unknown>,
  jobId: string,
): RunEnvelope | undefined {
  const keys = ["protocol", "type", "jobId", "tool", "toolVersion", "input", "spec"];
  const keysWithLogo = [...keys, "logoAssetId"];
  const hasLogoAssetId = hasExactKeys(value, keysWithLogo);
  if (!hasLogoAssetId && !hasExactKeys(value, keys)) return undefined;

  const tool = value.tool;
  const toolVersion = value.toolVersion;
  const rawInput = value.input;
  const spec = value.spec;
  const rawLogoAssetId = hasLogoAssetId ? value.logoAssetId : undefined;
  if (rawLogoAssetId !== undefined && !isSafeId(rawLogoAssetId)) return undefined;
  const input = parseFileInput(rawInput, MAX_SOURCE_BYTES);
  if (input === undefined) return undefined;
  return { jobId, tool, toolVersion, input, spec, logoAssetId: rawLogoAssetId };
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

function supportsWorkerCanvas(): boolean {
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

function post(event: ImageWatermarkWorkerEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
}

function safePost(event: ImageWatermarkWorkerEvent): void {
  try {
    post(event);
  } catch {
    // A broken message channel cannot be recovered inside this Worker.
  }
}

function fallbackWorkerError(): ImageWatermarkErrorPayload {
  return { code: "WORKER_CRASH", message: WORKER_CRASH_MESSAGE, retryable: true };
}

function mapError(error: unknown): ImageWatermarkErrorPayload {
  try {
    return toImageWatermarkErrorPayload(error);
  } catch {
    return fallbackWorkerError();
  }
}

function invalidRun(jobId: string, message = INVALID_SPEC_MESSAGE): void {
  safePost({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "failed",
    jobId,
    error: { code: "INVALID_SPEC", message, retryable: false },
  });
}

function invalidLogo(assetId: string, message = INVALID_SPEC_MESSAGE): void {
  safePost({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "logo-failed",
    assetId,
    error: { code: "INVALID_SPEC", message, retryable: false },
  });
}

function missingLogo(jobId: string): void {
  safePost({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "failed",
    jobId,
    error: { code: "LOGO_REQUIRED", message: LOGO_REQUIRED_MESSAGE, retryable: false },
  });
}

function closeLogo(logo: PreparedImageWatermarkLogo | undefined): void {
  if (logo === undefined) return;
  try {
    closePreparedImageWatermarkLogo(logo);
  } catch {
    // Cleanup is best effort and must not expose or replace the bounded result.
  }
}

function clearConfiguredLogo(): void {
  const previous = configuredLogo;
  configuredLogo = undefined;
  if (previous !== undefined) closeLogo(previous.prepared);
}

function configureLogo(request: ConfigureLogoEnvelope): void {
  if (
    request.tool !== IMAGE_WATERMARK_TOOL_ID ||
    request.toolVersion !== IMAGE_WATERMARK_TOOL_VERSION
  ) {
    invalidLogo(request.assetId);
    return;
  }
  if (activeJob !== undefined || activeLogoConfiguration !== undefined) {
    invalidLogo(request.assetId, CONCURRENT_LOGO_MESSAGE);
    return;
  }

  clearConfiguredLogo();
  const configuration: ActiveLogoConfiguration = {
    assetId: request.assetId,
    controller: new AbortController(),
  };
  activeLogoConfiguration = configuration;

  void (async () => {
    let prepared: PreparedImageWatermarkLogo | undefined;
    try {
      const input = await readFileInput(request.input, configuration.controller.signal);
      prepared = await prepareImageWatermarkLogo(input, configuration.controller.signal);
      if (activeLogoConfiguration !== configuration) {
        closeLogo(prepared);
        prepared = undefined;
        return;
      }
      configuredLogo = { assetId: request.assetId, prepared };
      const cached = prepared;
      prepared = undefined;
      try {
        post({
          protocol: WORKER_PROTOCOL_VERSION,
          type: "logo-ready",
          assetId: request.assetId,
        });
      } catch {
        if (configuredLogo?.prepared === cached) configuredLogo = undefined;
        closeLogo(cached);
      }
    } catch (error) {
      if (activeLogoConfiguration !== configuration) return;
      safePost({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "logo-failed",
        assetId: request.assetId,
        error: mapError(error),
      });
    } finally {
      closeLogo(prepared);
      if (activeLogoConfiguration === configuration) activeLogoConfiguration = undefined;
    }
  })();
}

function postProgress(
  job: ActiveJob,
  sequence: number,
  phase: ImageWatermarkPhase,
  fraction: number,
): void {
  if (job.controller.signal.aborted || activeJob !== job) return;
  post({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "progress",
    jobId: job.jobId,
    sequence,
    phase,
    fraction,
  });
}

function parseWatermarkSpec(value: unknown): ParsedImageWatermarkSpecV1 | undefined {
  let parsed: ReturnType<typeof imageWatermarkSpecSchema.safeParse>;
  try {
    parsed = imageWatermarkSpecSchema.safeParse(value);
  } catch {
    return undefined;
  }
  return parsed.success ? parsed.data : undefined;
}

function startRun(request: RunEnvelope): void {
  if (activeJob?.jobId === request.jobId) return;

  const spec = parseWatermarkSpec(request.spec);
  if (
    request.tool !== IMAGE_WATERMARK_TOOL_ID ||
    request.toolVersion !== IMAGE_WATERMARK_TOOL_VERSION ||
    spec === undefined
  ) {
    invalidRun(request.jobId);
    return;
  }
  if (activeJob !== undefined || activeLogoConfiguration !== undefined) {
    invalidRun(request.jobId, CONCURRENT_RUN_MESSAGE);
    return;
  }

  let logo: PreparedImageWatermarkLogo | undefined;
  if (spec.watermark.kind === "logo") {
    if (
      request.logoAssetId === undefined ||
      configuredLogo === undefined ||
      configuredLogo.assetId !== request.logoAssetId
    ) {
      missingLogo(request.jobId);
      return;
    }
    logo = configuredLogo.prepared;
  }

  const job: ActiveJob = { jobId: request.jobId, controller: new AbortController() };
  activeJob = job;
  let sequence = 0;
  let terminalPosted = false;
  void (async () => {
    try {
      postProgress(job, sequence, "validating", 0.01);
      sequence += 1;
      const input = await readFileInput(request.input, job.controller.signal);
      const output = await processImageWatermarkPipeline(
        input,
        spec,
        logo,
        (phase, fraction) => {
          postProgress(job, sequence, phase, fraction);
          sequence += 1;
        },
        job.controller.signal,
      );
      if (job.controller.signal.aborted || activeJob !== job) return;
      post(
        {
          protocol: WORKER_PROTOCOL_VERSION,
          type: "complete",
          jobId: job.jobId,
          result: output,
        },
        [output.bytes],
      );
      terminalPosted = true;
    } catch (error) {
      if (job.controller.signal.aborted || activeJob !== job || terminalPosted) return;
      try {
        post({
          protocol: WORKER_PROTOCOL_VERSION,
          type: "failed",
          jobId: job.jobId,
          error: mapError(error),
        });
        terminalPosted = true;
      } catch {
        // The realm cannot settle a request after both terminal posts fail.
      }
    } finally {
      if (activeJob === job) activeJob = undefined;
    }
  })();
}

scope.onmessage = (message: MessageEvent<unknown>) => {
  try {
    const request = message.data;
    if (!isPlainRecord(request)) return;
    const protocol = request.protocol;
    const type = request.type;
    if (protocol !== WORKER_PROTOCOL_VERSION || typeof type !== "string") return;

    if (type === "cancel") {
      const jobId = request.jobId;
      if (!isSafeId(jobId) || !hasExactKeys(request, ["protocol", "type", "jobId"])) return;
      const job = activeJob;
      if (job?.jobId !== jobId || job.controller.signal.aborted) return;
      job.controller.abort();
      safePost({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "failed",
        jobId,
        error: { code: "CANCELLED", message: CANCELLED_MESSAGE, retryable: false },
      });
      return;
    }

    if (type === "configure-logo") {
      const assetId = request.assetId;
      if (!isSafeId(assetId)) return;
      const configuration = parseConfigureLogoEnvelope(request, assetId);
      if (configuration !== undefined) configureLogo(configuration);
      else invalidLogo(assetId);
      return;
    }

    if (type !== "run") return;
    const jobId = request.jobId;
    if (!isSafeId(jobId)) return;
    const run = parseRunEnvelope(request, jobId);
    if (run !== undefined) startRun(run);
    else invalidRun(jobId);
  } catch {
    // Worker messages are untrusted structured-clone input.
  }
};

safePost({
  protocol: WORKER_PROTOCOL_VERSION,
  type: "ready",
  capabilities: {
    decode: ["image/jpeg", "image/png", "image/webp"],
    encode: ["image/jpeg", "image/png", "image/webp"],
    offscreenCanvas: supportsWorkerCanvas(),
  },
});
