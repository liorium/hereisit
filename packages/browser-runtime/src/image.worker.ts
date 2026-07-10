/// <reference lib="webworker" />

import {
  IMAGE_TOOL_ID,
  IMAGE_TOOL_VERSION,
  type ToolErrorPayload,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
  type WorkerRequest,
} from "@hereisit/tool-contracts";
import { ImagePipelineError, processImagePipeline } from "./image-pipeline";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const cancelledJobs = new Set<string>();

function post(event: WorkerEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(event, transfer);
}

function serializeError(error: unknown): ToolErrorPayload {
  if (error instanceof ImagePipelineError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "WORKER_CRASH",
    message: error instanceof Error ? error.message : "이미지를 처리하는 중 오류가 발생했습니다.",
    retryable: true,
  };
}

workerScope.onmessage = async (message: MessageEvent<WorkerRequest>) => {
  const request = message.data;
  if (request.protocol !== WORKER_PROTOCOL_VERSION) return;

  if (request.type === "cancel") {
    cancelledJobs.add(request.jobId);
    return;
  }

  if (request.tool !== IMAGE_TOOL_ID || request.toolVersion !== IMAGE_TOOL_VERSION) {
    post({
      protocol: 1,
      type: "failed",
      jobId: request.jobId,
      error: { code: "INVALID_SPEC", message: "지원하지 않는 도구 버전입니다.", retryable: false },
    });
    return;
  }

  let sequence = 0;
  try {
    const result = await processImagePipeline(request.input, request.spec, (phase, fraction) => {
      if (cancelledJobs.has(request.jobId)) {
        throw new ImagePipelineError("CANCELLED", "작업을 중단했습니다.");
      }
      post({
        protocol: 1,
        type: "progress",
        jobId: request.jobId,
        sequence: sequence++,
        phase,
        fraction,
      });
    });

    post({ protocol: 1, type: "complete", jobId: request.jobId, result }, [result.bytes]);
  } catch (error) {
    post({
      protocol: 1,
      type: "failed",
      jobId: request.jobId,
      error: serializeError(error),
    });
  } finally {
    cancelledJobs.delete(request.jobId);
  }
};

post({
  protocol: 1,
  type: "ready",
  capabilities: {
    decode: ["image/jpeg", "image/png", "image/webp"],
    encode: ["image/jpeg", "image/png", "image/webp"],
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
  },
});
