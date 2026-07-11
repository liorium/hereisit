/// <reference lib="webworker" />

import {
  PDF_IMAGES_TO_PDF_TOOL_ID,
  PDF_MERGE_TOOL_ID,
  PDF_SPLIT_TOOL_ID,
  PDF_TOOL_VERSION,
  type PdfPipelineSpecV1,
  type PdfToolId,
  type PdfWorkerEvent,
  type PdfWorkerRequest,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import { runPdfPipeline, toPdfErrorPayload } from "./pdf-pipeline";

const scope = self as DedicatedWorkerGlobalScope;
const cancelledJobs = new Set<string>();
const supportedTools = [PDF_MERGE_TOOL_ID, PDF_SPLIT_TOOL_ID, PDF_IMAGES_TO_PDF_TOOL_ID] as const;

function toolMatchesSpec(tool: PdfToolId, spec: PdfPipelineSpecV1): boolean {
  return (
    (tool === PDF_MERGE_TOOL_ID && spec.operation === "merge") ||
    (tool === PDF_SPLIT_TOOL_ID && spec.operation === "split") ||
    (tool === PDF_IMAGES_TO_PDF_TOOL_ID && spec.operation === "images-to-pdf")
  );
}

function post(event: PdfWorkerEvent, transfer: Transferable[] = []): void {
  scope.postMessage(event, transfer);
}

scope.onmessage = (message: MessageEvent<PdfWorkerRequest>) => {
  const request = message.data;
  if (request.protocol !== WORKER_PROTOCOL_VERSION) return;
  if (request.type === "cancel") {
    cancelledJobs.add(request.jobId);
    return;
  }

  const { jobId } = request;
  let sequence = 0;
  void (async () => {
    try {
      if (
        request.toolVersion !== PDF_TOOL_VERSION ||
        !toolMatchesSpec(request.tool, request.spec)
      ) {
        throw new Error("INVALID_SPEC");
      }
      const result = await runPdfPipeline(request.inputs, request.spec, {
        onProgress: (phase, fraction) => {
          if (cancelledJobs.has(jobId)) return;
          post({
            protocol: WORKER_PROTOCOL_VERSION,
            type: "progress",
            jobId,
            sequence: sequence++,
            phase,
            fraction,
          });
        },
      });
      if (cancelledJobs.has(jobId)) return;
      post(
        {
          protocol: WORKER_PROTOCOL_VERSION,
          type: "complete",
          jobId,
          result,
        },
        [result.bytes],
      );
    } catch (error) {
      if (cancelledJobs.has(jobId)) return;
      post({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "failed",
        jobId,
        error:
          error instanceof Error && error.message === "INVALID_SPEC"
            ? {
                code: "INVALID_SPEC",
                message: "PDF 작업 설정이 올바르지 않아요.",
                retryable: false,
              }
            : toPdfErrorPayload(error),
      });
    } finally {
      cancelledJobs.delete(jobId);
    }
  })();
};

post({
  protocol: WORKER_PROTOCOL_VERSION,
  type: "ready",
  capabilities: { operations: supportedTools },
});
