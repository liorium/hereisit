/// <reference lib="webworker" />

import {
  PDF_THUMBNAIL_TOOL_ID,
  PDF_THUMBNAIL_TOOL_VERSION,
  type PdfThumbnailProgress,
  type PdfThumbnailRunRequest,
  type PdfThumbnailUpdate,
  type PdfThumbnailWorkerEvent,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import { runPdfThumbnailPipeline, toPdfThumbnailErrorPayload } from "./pdf-thumbnail-pipeline";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const scope = self as unknown as DedicatedWorkerGlobalScope;

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

let activeJob: ActiveJob | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function post(event: PdfThumbnailWorkerEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
}

function parseInput(value: unknown): PdfThumbnailRunRequest["input"] | undefined {
  if (!isRecord(value) || !(value.bytes instanceof ArrayBuffer)) return undefined;
  if (
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 512 ||
    typeof value.mimeHint !== "string" ||
    value.mimeHint.length > 100 ||
    !Number.isSafeInteger(value.byteLength) ||
    typeof value.byteLength !== "number" ||
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

function invalidRequest(jobId: string): void {
  post({
    protocol: WORKER_PROTOCOL_VERSION,
    type: "failed",
    jobId,
    error: {
      code: "INVALID_SPEC",
      message: "PDF 미리보기 요청이 올바르지 않아요.",
      retryable: false,
    },
  });
}

function startRun(request: Record<string, unknown>): void {
  const jobId = request.jobId;
  if (typeof jobId !== "string" || jobId.length < 1) return;
  const input = parseInput(request.input);
  if (input === undefined) return;
  if (
    request.tool !== PDF_THUMBNAIL_TOOL_ID ||
    request.toolVersion !== PDF_THUMBNAIL_TOOL_VERSION ||
    activeJob !== undefined
  ) {
    invalidRequest(jobId);
    return;
  }

  const job: ActiveJob = { jobId, controller: new AbortController() };
  activeJob = job;
  let sequence = 0;
  const postProgress = (progress: PdfThumbnailProgress): void => {
    if (activeJob !== job || job.controller.signal.aborted) return;
    post({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "progress",
      jobId,
      sequence,
      ...progress,
    });
    sequence += 1;
  };
  const postThumbnail = (update: PdfThumbnailUpdate): void => {
    if (activeJob !== job || job.controller.signal.aborted) return;
    post(
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "thumbnail",
        jobId,
        sequence,
        update,
      },
      update.status === "ready" ? [update.bytes] : [],
    );
    sequence += 1;
  };

  void (async () => {
    try {
      const result = await runPdfThumbnailPipeline(input, {
        signal: job.controller.signal,
        onThumbnail: postThumbnail,
        onProgress: postProgress,
      });
      if (activeJob !== job || job.controller.signal.aborted) return;
      post({ protocol: WORKER_PROTOCOL_VERSION, type: "complete", jobId, result });
    } catch (error) {
      if (activeJob !== job || job.controller.signal.aborted) return;
      post({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "failed",
        jobId,
        error: toPdfThumbnailErrorPayload(error),
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
      request.jobId.length < 1
    ) {
      return;
    }
    if (request.type === "cancel") {
      if (activeJob?.jobId === request.jobId) activeJob.controller.abort();
      return;
    }
    if (request.type === "run") startRun(request);
  } catch {
    // Structured-clone messages are untrusted and malformed values are ignored.
  }
};

post({
  protocol: WORKER_PROTOCOL_VERSION,
  type: "ready",
  capabilities: {
    tool: PDF_THUMBNAIL_TOOL_ID,
    toolVersion: PDF_THUMBNAIL_TOOL_VERSION,
  },
});
