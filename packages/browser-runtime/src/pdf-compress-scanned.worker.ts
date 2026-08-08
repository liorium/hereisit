/// <reference lib="webworker" />

import { PDFDocument } from "@cantoo/pdf-lib";
import { MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES } from "@hereisit/pdf-tool";
import {
  PDF_COMPRESS_SCANNED_TOOL_ID,
  PDF_COMPRESS_SCANNED_TOOL_VERSION,
  type PdfCompressScannedErrorPayload,
  type PdfCompressScannedFileRunRequest,
  type PdfCompressScannedProgress,
  type PdfCompressScannedRunRequest,
  type PdfCompressScannedWorkerEvent,
  pdfCompressScannedSpecV2Schema,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import {
  runPdfCompressScannedPipeline,
  toPdfCompressScannedErrorPayload,
} from "./pdf-compress-scanned-pipeline";
import { probePdfRasterParserWorker } from "./pdf-raster-runtime";

const MAX_JOB_ID_LENGTH = 128;
const MAX_INPUT_NAME_LENGTH = 512;
const MAX_MIME_HINT_LENGTH = 100;
const WORKER_READINESS_MESSAGE = "PDF 압축 작업기를 준비하지 못했어요.";
const UNSUPPORTED_BROWSER_MESSAGE = "이 브라우저는 로컬 PDF 압축을 지원하지 않아요.";
const INVALID_SPEC_MESSAGE = "PDF 압축 요청이 올바르지 않아요.";
const CONCURRENT_RUN_MESSAGE = "PDF 압축 작업기가 이미 다른 요청을 처리하고 있어요.";
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

const scope = self as unknown as DedicatedWorkerGlobalScope;

type ReadinessState = "pending" | "ready" | "failed";

interface RunEnvelope {
  jobId: string;
  tool: unknown;
  toolVersion: unknown;
  input: PdfCompressScannedRunRequest["input"] | PdfCompressScannedFileRunRequest["input"];
  spec: unknown;
}

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

interface CanvasProbeResult {
  offscreenCanvas: boolean;
  jpegEncoder: boolean;
}

let readinessState: ReadinessState = "pending";
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

function isJobId(value: unknown): value is string {
  return isBoundedString(value, 1, MAX_JOB_ID_LENGTH);
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

function post(event: PdfCompressScannedWorkerEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
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

async function probeWorkerCanvas(): Promise<CanvasProbeResult> {
  if (typeof OffscreenCanvas === "undefined") {
    return { offscreenCanvas: false, jpegEncoder: false };
  }
  let canvas: OffscreenCanvas | undefined;
  try {
    canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d");
    if (context === null || typeof canvas.convertToBlob !== "function") {
      return { offscreenCanvas: false, jpegEncoder: false };
    }
    let blob: Blob;
    try {
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    } catch {
      return { offscreenCanvas: true, jpegEncoder: false };
    }
    return {
      offscreenCanvas: true,
      jpegEncoder:
        blob instanceof Blob &&
        blob.type === "image/jpeg" &&
        Number.isSafeInteger(blob.size) &&
        blob.size >= 1,
    };
  } catch {
    return { offscreenCanvas: false, jpegEncoder: false };
  } finally {
    releaseCanvas(canvas);
  }
}

async function probePdfAssembly(): Promise<void> {
  let document: PDFDocument | undefined;
  try {
    document = await PDFDocument.create({ updateMetadata: false });
    const serialized = await document.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 50,
      updateFieldAppearances: false,
    });
    if (!(serialized instanceof Uint8Array) || serialized.byteLength < 1) {
      throw new Error("INVALID_PDF_ASSEMBLY_PROBE");
    }
  } finally {
    document = undefined;
  }
}

function failedReadiness(jobId: string): void {
  post({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "failed",
    jobId,
    error: {
      code: "WORKER_CRASH",
      message: WORKER_READINESS_MESSAGE,
      retryable: true,
    },
  });
}

function invalidSpec(jobId: string, message = INVALID_SPEC_MESSAGE): void {
  post({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "failed",
    jobId,
    error: { code: "INVALID_SPEC", message, retryable: false },
  });
}

function parseInput(value: unknown): PdfCompressScannedRunRequest["input"] | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["name", "mimeHint", "byteLength", "bytes"])) {
    return undefined;
  }
  const name = value.name;
  const mimeHint = value.mimeHint;
  const byteLength = value.byteLength;
  const bytes = value.bytes;
  if (
    !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
    !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
    !isOrdinaryArrayBuffer(bytes) ||
    !Number.isSafeInteger(byteLength) ||
    typeof byteLength !== "number" ||
    byteLength < 1 ||
    byteLength > MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES ||
    byteLength !== arrayBufferByteLength(bytes)
  ) {
    return undefined;
  }
  return {
    name,
    mimeHint,
    byteLength,
    bytes,
  };
}

function parseFileInput(value: unknown): PdfCompressScannedFileRunRequest["input"] | undefined {
  if (
    typeof File === "undefined" ||
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["name", "mimeHint", "byteLength", "file"])
  ) {
    return undefined;
  }
  const name = value.name;
  const mimeHint = value.mimeHint;
  const byteLength = value.byteLength;
  const file = value.file;
  if (
    !isBoundedString(name, 1, MAX_INPUT_NAME_LENGTH) ||
    !isBoundedString(mimeHint, 0, MAX_MIME_HINT_LENGTH) ||
    !(file instanceof File) ||
    !Number.isSafeInteger(byteLength) ||
    typeof byteLength !== "number" ||
    byteLength < 1 ||
    byteLength > MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES ||
    name !== file.name ||
    mimeHint !== file.type ||
    byteLength !== file.size
  ) {
    return undefined;
  }
  return { name, mimeHint, byteLength, file };
}

function captureSpec(value: unknown): unknown {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["version", "preset"])) return undefined;
  const version = value.version;
  const preset = value.preset;
  return { version, preset };
}

function parseRunEnvelope(
  value: Record<PropertyKey, unknown>,
  jobId: string,
): RunEnvelope | undefined {
  if (!hasExactKeys(value, ["protocol", "type", "jobId", "tool", "toolVersion", "input", "spec"])) {
    return undefined;
  }
  const tool = value.tool;
  const toolVersion = value.toolVersion;
  const rawInput = value.input;
  const rawSpec = value.spec;
  const input = parseFileInput(rawInput) ?? parseInput(rawInput);
  if (input === undefined) return undefined;
  return {
    jobId,
    tool,
    toolVersion,
    input,
    spec: captureSpec(rawSpec),
  };
}

function postProgress(
  job: ActiveJob,
  sequence: number,
  progress: PdfCompressScannedProgress,
): void {
  if (job.controller.signal.aborted || activeJob !== job) return;
  post({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "progress",
    jobId: job.jobId,
    sequence,
    ...progress,
  });
}

function startRun(request: RunEnvelope): void {
  if (activeJob?.jobId === request.jobId) return;

  let parsedSpec: ReturnType<typeof pdfCompressScannedSpecV2Schema.safeParse>;
  try {
    parsedSpec = pdfCompressScannedSpecV2Schema.safeParse(request.spec);
  } catch {
    invalidSpec(request.jobId);
    return;
  }
  if (
    request.tool !== PDF_COMPRESS_SCANNED_TOOL_ID ||
    request.toolVersion !== PDF_COMPRESS_SCANNED_TOOL_VERSION ||
    !parsedSpec.success
  ) {
    invalidSpec(request.jobId);
    return;
  }
  if (activeJob !== undefined) {
    invalidSpec(request.jobId, CONCURRENT_RUN_MESSAGE);
    return;
  }

  const job: ActiveJob = { jobId: request.jobId, controller: new AbortController() };
  activeJob = job;
  let sequence = 0;
  void (async () => {
    try {
      let input: PdfCompressScannedRunRequest["input"];
      if ("file" in request.input) {
        let bytes: ArrayBuffer;
        try {
          bytes = await request.input.file.arrayBuffer();
        } catch {
          if (job.controller.signal.aborted || activeJob !== job) return;
          post({
            protocol: WORKER_PROTOCOL_VERSION,
            type: "failed",
            jobId: job.jobId,
            error: {
              code: "CORRUPT_PDF",
              message: "선택한 PDF 파일을 읽지 못했어요.",
              retryable: true,
            },
          });
          return;
        }
        if (job.controller.signal.aborted || activeJob !== job) return;
        if (
          !isOrdinaryArrayBuffer(bytes) ||
          arrayBufferByteLength(bytes) !== request.input.byteLength
        ) {
          post({
            protocol: WORKER_PROTOCOL_VERSION,
            type: "failed",
            jobId: job.jobId,
            error: {
              code: "CORRUPT_PDF",
              message: "PDF 파일 크기 정보를 확인할 수 없어요.",
              retryable: false,
            },
          });
          return;
        }
        input = {
          name: request.input.name,
          mimeHint: request.input.mimeHint,
          byteLength: request.input.byteLength,
          bytes,
        };
      } else {
        input = request.input;
      }
      const output = await runPdfCompressScannedPipeline(input, parsedSpec.data, {
        signal: job.controller.signal,
        onProgress(progress) {
          postProgress(job, sequence, progress);
          sequence += 1;
        },
      });
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
    } catch (error) {
      if (job.controller.signal.aborted || activeJob !== job) return;
      let payload: PdfCompressScannedErrorPayload;
      try {
        payload = toPdfCompressScannedErrorPayload(error);
      } catch {
        payload = {
          code: "WORKER_CRASH",
          message: "PDF 압축 작업을 완료하지 못했어요.",
          retryable: true,
        };
      }
      post({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "failed",
        jobId: job.jobId,
        error: payload,
      });
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
    const jobId = request.jobId;
    if (protocol !== WORKER_PROTOCOL_VERSION || typeof type !== "string" || !isJobId(jobId)) {
      return;
    }
    if (type === "cancel") {
      if (!hasExactKeys(request, ["protocol", "type", "jobId"])) return;
      if (activeJob?.jobId === jobId) activeJob.controller.abort();
      return;
    }
    if (type !== "run") return;
    const run = parseRunEnvelope(request, jobId);
    if (run === undefined) return;
    if (readinessState !== "ready") {
      failedReadiness(run.jobId);
      return;
    }
    startRun(run);
  } catch {
    // Worker messages are untrusted structured-clone input.
  }
};

void (async () => {
  const [canvasProbe, parserProbe, assemblyProbe] = await Promise.allSettled([
    probeWorkerCanvas(),
    probePdfRasterParserWorker(),
    probePdfAssembly(),
  ]);
  const canvas =
    canvasProbe.status === "fulfilled"
      ? canvasProbe.value
      : { offscreenCanvas: false, jpegEncoder: false };
  const capabilities = {
    offscreenCanvas: canvas.offscreenCanvas,
    jpegEncoder: canvas.jpegEncoder,
    pdfjsWorker: parserProbe.status === "fulfilled",
    pdfAssembly: assemblyProbe.status === "fulfilled",
  };

  let error: PdfCompressScannedErrorPayload | null = null;
  if (!capabilities.offscreenCanvas || !capabilities.jpegEncoder) {
    error = {
      code: "UNSUPPORTED_BROWSER",
      message: UNSUPPORTED_BROWSER_MESSAGE,
      retryable: false,
    };
  } else if (!capabilities.pdfjsWorker || !capabilities.pdfAssembly) {
    error = {
      code: "WORKER_CRASH",
      message: WORKER_READINESS_MESSAGE,
      retryable: true,
    };
  }
  readinessState = error === null ? "ready" : "failed";
  post({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "ready",
    capabilities,
    error,
  });
})();
