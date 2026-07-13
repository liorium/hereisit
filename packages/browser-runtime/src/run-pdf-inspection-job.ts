import {
  type PdfInspectionHandle,
  type PdfInspectionOutcome,
  type PdfInspectRequest,
  type PdfToolErrorPayload,
  type PdfWorkerEvent,
  WORKER_PROTOCOL_VERSION,
} from "@hereisit/tool-contracts";
import { makePdfJobId, PDF_JOB_TIMEOUT_MS, supportsBrowserPdfRuntime } from "./pdf-runtime-support";

const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;

export { supportsBrowserPdfRuntime } from "./pdf-runtime-support";

export function inspectPdfFile(file: File): PdfInspectionHandle {
  let settled = false;
  let cancelled = false;
  let readStarted = false;
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (outcome: PdfInspectionOutcome) => void = () => undefined;
  const result = new Promise<PdfInspectionOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const jobId = makePdfJobId();

  const settle = (outcome: PdfInspectionOutcome) => {
    if (settled) return;
    settled = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    worker?.terminate();
    worker = undefined;
    resolveResult(outcome);
  };

  const reject = (error: PdfToolErrorPayload) => settle({ status: "rejected", error });

  const beginFileRead = () => {
    if (readStarted || settled || cancelled || worker === undefined) return;
    readStarted = true;
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
  };

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
        if (event.protocol !== WORKER_PROTOCOL_VERSION) return;
        if (event.type === "ready") {
          beginFileRead();
          return;
        }
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
    }, PDF_JOB_TIMEOUT_MS);
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
