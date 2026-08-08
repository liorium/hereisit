/// <reference lib="webworker" />

import {
  PDF_TO_IMAGES_TOOL_ID,
  PDF_TO_IMAGES_TOOL_VERSION,
  type PdfToImagesErrorPayload,
  type PdfToImagesFileRunRequest,
  type PdfToImagesProgress,
  type PdfToImagesRunRequest,
  type PdfToImagesWorkerEvent,
  pdfToImagesSpecSchema,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import {
  PdfToImagesPipelineError,
  runPdfToImagesPipeline,
  toPdfToImagesErrorPayload,
} from "./pdf-to-images-pipeline";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const scope = self as unknown as DedicatedWorkerGlobalScope;

interface RunEnvelope {
  jobId: string;
  tool: unknown;
  toolVersion: unknown;
  input: PdfToImagesRunRequest["input"] | PdfToImagesFileRunRequest["input"];
  spec: unknown;
}

function parseFileInput(value: unknown): PdfToImagesFileRunRequest["input"] | undefined {
  if (!isRecord(value) || !(value.file instanceof File)) return undefined;
  if (
    typeof value.name !== "string" ||
    typeof value.mimeHint !== "string" ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_INPUT_BYTES ||
    value.name !== value.file.name ||
    value.mimeHint !== value.file.type ||
    value.byteLength !== value.file.size
  ) {
    return undefined;
  }
  return {
    name: value.name,
    mimeHint: value.mimeHint,
    byteLength: value.byteLength,
    file: value.file,
  };
}

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

let activeJob: ActiveJob | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function releaseCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas === undefined) return;
  try {
    canvas.width = 0;
  } catch {
    // Capability detection is best effort and never blocks Worker readiness.
  }
  try {
    canvas.height = 0;
  } catch {
    // Capability detection is best effort and never blocks Worker readiness.
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

function post(event: PdfToImagesWorkerEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
}

function invalidSpec(jobId: string, message: string): void {
  const error: PdfToImagesErrorPayload = {
    code: "INVALID_SPEC",
    message,
    retryable: false,
  };
  post({ protocol: WORKER_PROTOCOL_VERSION, type: "failed", jobId, error });
}

function parseInput(value: unknown): PdfToImagesRunRequest["input"] | undefined {
  if (!isRecord(value) || !(value.bytes instanceof ArrayBuffer)) return undefined;
  if (
    typeof value.name !== "string" ||
    typeof value.mimeHint !== "string" ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_INPUT_BYTES ||
    value.byteLength !== value.bytes.byteLength
  ) {
    return undefined;
  }
  return {
    name: value.name,
    mimeHint: value.mimeHint,
    byteLength: value.byteLength,
    bytes: value.bytes,
  };
}

function parseRunEnvelope(value: Record<string, unknown>): RunEnvelope | undefined {
  if (typeof value.jobId !== "string" || value.jobId.length === 0) return undefined;
  const input = value.type === "run-file" ? parseFileInput(value.input) : parseInput(value.input);
  if (input === undefined) return undefined;
  return {
    jobId: value.jobId,
    tool: value.tool,
    toolVersion: value.toolVersion,
    input,
    spec: value.spec,
  };
}

function postProgress(job: ActiveJob, sequence: number, progress: PdfToImagesProgress): void {
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

  let parsedSpec: ReturnType<typeof pdfToImagesSpecSchema.safeParse>;
  try {
    parsedSpec = pdfToImagesSpecSchema.safeParse(request.spec);
  } catch {
    invalidSpec(request.jobId, "PDF 이미지 변환 요청이 올바르지 않아요.");
    return;
  }
  if (
    request.tool !== PDF_TO_IMAGES_TOOL_ID ||
    request.toolVersion !== PDF_TO_IMAGES_TOOL_VERSION ||
    !parsedSpec.success
  ) {
    invalidSpec(request.jobId, "PDF 이미지 변환 요청이 올바르지 않아요.");
    return;
  }
  if (activeJob !== undefined) {
    invalidSpec(request.jobId, "PDF 이미지 변환 작업기가 이미 다른 요청을 처리하고 있어요.");
    return;
  }

  const job: ActiveJob = { jobId: request.jobId, controller: new AbortController() };
  activeJob = job;
  let sequence = 0;
  void (async () => {
    try {
      let input: PdfToImagesRunRequest["input"];
      if ("file" in request.input) {
        let bytes: ArrayBuffer;
        try {
          bytes = await request.input.file.arrayBuffer();
        } catch {
          throw new PdfToImagesPipelineError(
            "CORRUPT_PDF",
            "선택한 PDF 파일을 읽지 못했어요.",
            true,
          );
        }
        if (bytes.byteLength !== request.input.byteLength) {
          throw new PdfToImagesPipelineError(
            "CORRUPT_PDF",
            "PDF 파일 크기 정보를 확인할 수 없어요.",
          );
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
      const result = await runPdfToImagesPipeline(input, parsedSpec.data, {
        signal: job.controller.signal,
        onProgress: (progress) => {
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
          result,
        },
        [result.bytes],
      );
    } catch (error) {
      if (job.controller.signal.aborted || activeJob !== job) return;
      post({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "failed",
        jobId: job.jobId,
        error: toPdfToImagesErrorPayload(error),
      });
    } finally {
      if (activeJob === job) activeJob = undefined;
    }
  })();
}

scope.onmessage = (message: MessageEvent<unknown>) => {
  try {
    const request = message.data;
    if (
      !isRecord(request) ||
      request.protocol !== WORKER_PROTOCOL_VERSION ||
      typeof request.type !== "string" ||
      typeof request.jobId !== "string" ||
      request.jobId.length === 0
    ) {
      return;
    }
    if (request.type === "cancel") {
      if (activeJob?.jobId === request.jobId) activeJob.controller.abort();
      return;
    }
    if (request.type !== "run" && request.type !== "run-file") return;
    const run = parseRunEnvelope(request);
    if (run === undefined) return;
    startRun(run);
  } catch {
    // Messages are untrusted structured-clone input; malformed values are ignored safely.
  }
};

post({
  protocol: WORKER_PROTOCOL_VERSION,
  type: "ready",
  capabilities: {
    offscreenCanvas: supportsWorkerCanvas(),
    formats: ["jpeg", "png"],
  },
});
