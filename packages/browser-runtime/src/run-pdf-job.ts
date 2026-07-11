import {
  PDF_IMAGES_TO_PDF_TOOL_ID,
  PDF_MERGE_TOOL_ID,
  PDF_ORGANIZE_TOOL_ID,
  PDF_SPLIT_TOOL_ID,
  PDF_TOOL_VERSION,
  PDF_WATERMARK_TOOL_ID,
  type PdfInspectionHandle,
  type PdfInspectionOutcome,
  type PdfInspectRequest,
  type PdfJobHandle,
  type PdfJobOutcome,
  type PdfPhase,
  type PdfPipelineSpecV1,
  type PdfRunRequest,
  type PdfToolErrorPayload,
  type PdfToolId,
  type PdfWorkerEvent,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";

const JOB_TIMEOUT_MS = 180_000;
const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;

export interface RunPdfJobOptions {
  onProgress?: (event: { phase: PdfPhase; fraction: number }) => void;
}

function makeJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function toolForSpec(spec: PdfPipelineSpecV1): PdfToolId {
  if (spec.operation === "merge") return PDF_MERGE_TOOL_ID;
  if (spec.operation === "split") return PDF_SPLIT_TOOL_ID;
  if (spec.operation === "images-to-pdf") return PDF_IMAGES_TO_PDF_TOOL_ID;
  if (spec.operation === "organize") return PDF_ORGANIZE_TOOL_ID;
  return PDF_WATERMARK_TOOL_ID;
}

export function supportsBrowserPdfRuntime(): boolean {
  return typeof Worker !== "undefined" && typeof File !== "undefined";
}

export function runPdfJob(
  files: readonly File[],
  spec: PdfPipelineSpecV1,
  options: RunPdfJobOptions = {},
): PdfJobHandle {
  let settled = false;
  let cancelled = false;
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (outcome: PdfJobOutcome) => void = () => undefined;
  const result = new Promise<PdfJobOutcome>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (outcome: PdfJobOutcome) => {
    if (settled) return;
    settled = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    worker?.terminate();
    worker = undefined;
    resolveResult(outcome);
  };

  const reject = (error: PdfToolErrorPayload) => settle({ status: "rejected", error });

  if (!supportsBrowserPdfRuntime()) {
    reject({
      code: "WORKER_CRASH",
      message: "이 브라우저는 로컬 PDF 처리를 지원하지 않아요.",
      retryable: false,
    });
  } else {
    try {
      worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-pdf-worker",
      });
      worker.onmessage = (message: MessageEvent<PdfWorkerEvent>) => {
        if (settled || cancelled) return;
        const event = message.data;
        if (event.protocol !== WORKER_PROTOCOL_VERSION || event.type === "ready") return;
        if (event.jobId !== jobId) return;
        if (event.type === "progress") {
          try {
            options.onProgress?.({ phase: event.phase, fraction: event.fraction });
          } catch {
            return;
          }
        } else if (event.type === "complete") {
          settle({ status: "fulfilled", value: event.result });
        } else if (event.type === "failed") {
          reject(event.error);
        }
      };
      const workerFailure = () =>
        reject({
          code: "WORKER_CRASH",
          message: "브라우저 PDF 작업기가 중단됐어요.",
          retryable: true,
        });
      worker.onerror = workerFailure;
      worker.onmessageerror = workerFailure;
    } catch {
      reject({
        code: "WORKER_CRASH",
        message: "브라우저 PDF 작업기를 시작하지 못했어요.",
        retryable: true,
      });
    }
  }

  const jobId = makeJobId();
  if (!settled && worker !== undefined) {
    timeoutId = setTimeout(() => {
      reject({
        code: "WORKER_CRASH",
        message: "PDF 작업 시간이 3분 제한을 넘었어요.",
        retryable: true,
      });
    }, JOB_TIMEOUT_MS);

    void (async () => {
      try {
        const inputs: PdfRunRequest["inputs"][number][] = [];
        for (const file of files) {
          const bytes = await file.arrayBuffer();
          if (cancelled || settled) return;
          inputs.push({
            name: file.name,
            mimeHint: file.type,
            byteLength: file.size,
            bytes,
          });
        }
        const request: PdfRunRequest = {
          protocol: WORKER_PROTOCOL_VERSION,
          type: "run",
          jobId,
          tool: toolForSpec(spec),
          toolVersion: PDF_TOOL_VERSION,
          inputs,
          spec,
        };
        worker?.postMessage(
          request,
          inputs.map((input) => input.bytes),
        );
      } catch {
        reject({
          code: "CORRUPT_PDF",
          message: "선택한 파일을 읽지 못했어요.",
          retryable: true,
        });
      }
    })();
  }

  return {
    result,
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      worker?.postMessage({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "cancel",
        jobId,
      });
      settle({ status: "cancelled" });
    },
  };
}

export function inspectPdfFile(file: File): PdfInspectionHandle {
  let settled = false;
  let cancelled = false;
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (outcome: PdfInspectionOutcome) => void = () => undefined;
  const result = new Promise<PdfInspectionOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const jobId = makeJobId();

  const settle = (outcome: PdfInspectionOutcome) => {
    if (settled) return;
    settled = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    worker?.terminate();
    worker = undefined;
    resolveResult(outcome);
  };

  const reject = (error: PdfToolErrorPayload) => settle({ status: "rejected", error });

  if (!supportsBrowserPdfRuntime()) {
    reject({
      code: "WORKER_CRASH",
      message: "이 브라우저는 로컬 PDF 처리를 지원하지 않아요.",
      retryable: false,
    });
  } else if (file.size < 1 || file.size > MAX_PDF_FILE_BYTES) {
    reject({
      code: "MEMORY_LIMIT",
      message: "PDF 파일은 1바이트 이상 50MB 이하여야 해요.",
      retryable: false,
    });
  } else {
    try {
      worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-pdf-inspection-worker",
      });
      worker.onmessage = (message: MessageEvent<PdfWorkerEvent>) => {
        const event = message.data;
        if (event.protocol !== WORKER_PROTOCOL_VERSION || event.type === "ready") return;
        if (event.jobId !== jobId) return;
        if (event.type === "inspected") {
          settle({ status: "fulfilled", value: event.result });
        } else if (event.type === "failed") {
          reject(event.error);
        }
      };
      const workerFailure = () =>
        reject({
          code: "WORKER_CRASH",
          message: "브라우저 PDF 검사기가 중단됐어요.",
          retryable: true,
        });
      worker.onerror = workerFailure;
      worker.onmessageerror = workerFailure;
    } catch {
      reject({
        code: "WORKER_CRASH",
        message: "브라우저 PDF 검사기를 시작하지 못했어요.",
        retryable: true,
      });
    }
  }

  if (!settled && worker !== undefined) {
    timeoutId = setTimeout(() => {
      reject({
        code: "WORKER_CRASH",
        message: "PDF 페이지 확인 시간이 3분 제한을 넘었어요.",
        retryable: true,
      });
    }, JOB_TIMEOUT_MS);

    void (async () => {
      try {
        const bytes = await file.arrayBuffer();
        if (cancelled || settled) return;
        const input: PdfInspectRequest["input"] = {
          name: file.name,
          mimeHint: file.type,
          byteLength: file.size,
          bytes,
        };
        const request: PdfInspectRequest = {
          protocol: WORKER_PROTOCOL_VERSION,
          type: "inspect",
          jobId,
          input,
        };
        worker?.postMessage(request, [bytes]);
      } catch {
        reject({
          code: "CORRUPT_PDF",
          message: "선택한 PDF 파일을 읽지 못했어요.",
          retryable: true,
        });
      }
    })();
  }

  return {
    result,
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      worker?.postMessage({
        protocol: WORKER_PROTOCOL_VERSION,
        type: "cancel",
        jobId,
      });
      settle({ status: "cancelled" });
    },
  };
}
