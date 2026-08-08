/// <reference lib="webworker" />

import {
  PDF_IMAGES_TO_PDF_TOOL_ID,
  PDF_MERGE_TOOL_ID,
  PDF_ORGANIZE_TOOL_ID,
  PDF_SPLIT_TOOL_ID,
  PDF_TOOL_VERSION,
  PDF_WATERMARK_TOOL_ID,
  type PdfInspectRequest,
  type PdfPipelineSpecV1,
  type PdfToolId,
  type PdfWorkerEvent,
  type PdfWorkerRequest,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import {
  inspectPdfInput,
  runPdfFilePipeline,
  runPdfPipeline,
  toPdfErrorPayload,
} from "./pdf-pipeline";

const scope = self as DedicatedWorkerGlobalScope;
const cancelledJobs = new Set<string>();
const supportedTools = [
  PDF_MERGE_TOOL_ID,
  PDF_SPLIT_TOOL_ID,
  PDF_IMAGES_TO_PDF_TOOL_ID,
  PDF_ORGANIZE_TOOL_ID,
  PDF_WATERMARK_TOOL_ID,
] as const;

function toolMatchesSpec(tool: PdfToolId, spec: PdfPipelineSpecV1): boolean {
  return (
    (tool === PDF_MERGE_TOOL_ID && spec.operation === "merge") ||
    (tool === PDF_SPLIT_TOOL_ID && spec.operation === "split") ||
    (tool === PDF_IMAGES_TO_PDF_TOOL_ID && spec.operation === "images-to-pdf") ||
    (tool === PDF_ORGANIZE_TOOL_ID && spec.operation === "organize") ||
    (tool === PDF_WATERMARK_TOOL_ID && spec.operation === "watermark")
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
      if (request.type === "inspect") {
        let input: PdfInspectRequest["input"];
        if ("file" in request.input) {
          const { file, name, mimeHint, byteLength } = request.input;
          if (
            !(file instanceof File) ||
            name !== file.name ||
            mimeHint !== file.type ||
            byteLength !== file.size
          ) {
            throw new Error("INVALID_FILE");
          }
          let bytes: ArrayBuffer;
          try {
            bytes = await file.arrayBuffer();
          } catch {
            throw new Error("INVALID_FILE");
          }
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== byteLength) {
            throw new Error("INVALID_FILE");
          }
          input = { name, mimeHint, byteLength, bytes };
        } else {
          input = request.input;
        }
        const result = await inspectPdfInput(input);
        if (cancelledJobs.has(jobId)) return;
        post({
          protocol: WORKER_PROTOCOL_VERSION,
          type: "inspected",
          jobId,
          result,
        });
        return;
      }
      if (
        request.toolVersion !== PDF_TOOL_VERSION ||
        !toolMatchesSpec(request.tool, request.spec) ||
        (request.type === "run-files" &&
          request.spec.operation !== "merge" &&
          request.spec.operation !== "split" &&
          request.spec.operation !== "images-to-pdf")
      ) {
        throw new Error("INVALID_SPEC");
      }
      const pipelineOptions = {
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
      } satisfies Parameters<typeof runPdfPipeline>[2];
      const result =
        request.type === "run-files"
          ? await runPdfFilePipeline(
              request.inputs.map((input) => {
                if (
                  !(input.file instanceof File) ||
                  input.name !== input.file.name ||
                  input.mimeHint !== input.file.type ||
                  input.byteLength !== input.file.size
                ) {
                  throw new Error("INVALID_FILE");
                }
                return {
                  name: input.name,
                  mimeHint: input.mimeHint,
                  byteLength: input.byteLength,
                  readBytes: () => input.file.arrayBuffer(),
                };
              }),
              request.spec,
              pipelineOptions,
            )
          : await runPdfPipeline(request.inputs, request.spec, pipelineOptions);
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
            : error instanceof Error && error.message === "INVALID_FILE"
              ? {
                  code: "CORRUPT_PDF",
                  message: "선택한 파일을 읽지 못했어요.",
                  retryable: true,
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
