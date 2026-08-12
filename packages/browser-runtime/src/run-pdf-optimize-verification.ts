import {
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  type PdfOptimizeErrorPayload,
  type PdfOptimizeResultDescriptor,
  pdfOptimizeResultDescriptorSchema,
} from "@hereisit/tool-contracts/pdf-optimize";
import { makePdfJobId, PDF_JOB_TIMEOUT_MS } from "./pdf-runtime-support";

const ERROR: PdfOptimizeErrorPayload = {
  code: "VERIFICATION_FAILED",
  message: "PDF 처리 결과를 확인할 수 없습니다.",
  retryable: true,
};

export type PdfOptimizeVerificationOutcome =
  | {
      readonly status: "fulfilled";
      readonly value: {
        readonly descriptor: Extract<PdfOptimizeResultDescriptor, { kind: "download" }>;
        readonly blob: Blob;
      };
    }
  | { readonly status: "rejected"; readonly error: PdfOptimizeErrorPayload }
  | { readonly status: "cancelled" };

export interface PdfOptimizeVerificationHandle {
  readonly result: Promise<PdfOptimizeVerificationOutcome>;
  cancel(): void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function verifyPdfOptimizeResult(
  sourceFile: File,
  resultFile: File,
  rawDescriptor: unknown,
  options: { readonly timeoutMilliseconds?: number } = {},
): PdfOptimizeVerificationHandle {
  let settle: (value: PdfOptimizeVerificationOutcome) => void = () => undefined;
  const result = new Promise<PdfOptimizeVerificationOutcome>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelRequested = false;
  let cancellationOutcome: PdfOptimizeVerificationOutcome = { status: "cancelled" };
  const finish = (outcome: PdfOptimizeVerificationOutcome) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    worker?.terminate();
    worker = undefined;
    settle(outcome);
  };
  const reject = () => finish({ status: "rejected", error: ERROR });
  const requestCancellation = (outcome: PdfOptimizeVerificationOutcome) => {
    if (settled || cancelRequested) return;
    cancelRequested = true;
    cancellationOutcome = outcome;
    try {
      worker?.postMessage({ protocol: 1, type: "cancel", jobId });
    } catch {
      finish(outcome);
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => finish(outcome), 2_000);
  };
  const parsed = pdfOptimizeResultDescriptorSchema.safeParse(rawDescriptor);
  if (
    typeof Worker === "undefined" ||
    typeof File === "undefined" ||
    !(sourceFile instanceof File) ||
    !(resultFile instanceof File) ||
    !parsed.success ||
    parsed.data.kind !== "download" ||
    sourceFile.type !== "application/pdf" ||
    resultFile.type !== "application/pdf" ||
    sourceFile.size !== parsed.data.sourceByteLength ||
    resultFile.size !== parsed.data.byteLength ||
    sourceFile.size > PDF_OPTIMIZE_MAX_FILE_BYTES ||
    resultFile.size > PDF_OPTIMIZE_MAX_FILE_BYTES
  ) {
    reject();
    return { result, cancel: () => undefined };
  }
  const descriptor = parsed.data;
  const jobId = makePdfJobId();
  let posted = false;
  try {
    worker = new Worker(new URL("./pdf-optimize-verify.worker.ts", import.meta.url), {
      type: "module",
      name: "hereisit-pdf-optimize-verifier",
    });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isPlainRecord(message) || message.protocol !== 1 || typeof message.type !== "string")
        return;
      if (message.type === "ready" && exactKeys(message, ["protocol", "type"])) {
        if (posted || settled || worker === undefined) return;
        posted = true;
        worker.postMessage({
          protocol: 1,
          type: "verify",
          jobId,
          source: sourceFile,
          result: resultFile,
          descriptor,
        });
        return;
      }
      if (message.jobId !== jobId) return;
      if (
        cancelRequested &&
        message.type === "cancelled" &&
        exactKeys(message, ["protocol", "type", "jobId"])
      ) {
        finish(cancellationOutcome);
        return;
      }
      if (cancelRequested) return;
      if (
        message.type === "complete" &&
        exactKeys(message, ["protocol", "type", "jobId", "descriptor", "blob"])
      ) {
        const decoded = pdfOptimizeResultDescriptorSchema.safeParse(message.descriptor);
        if (
          !decoded.success ||
          decoded.data.kind !== "download" ||
          JSON.stringify(decoded.data) !== JSON.stringify(descriptor) ||
          !(message.blob instanceof Blob) ||
          message.blob.type !== "application/pdf" ||
          message.blob.size !== descriptor.byteLength
        ) {
          reject();
          return;
        }
        finish({ status: "fulfilled", value: { descriptor: decoded.data, blob: message.blob } });
      } else if (
        message.type === "failed" &&
        exactKeys(message, ["protocol", "type", "jobId", "error"])
      ) {
        reject();
      }
    };
    worker.onerror = reject;
    worker.onmessageerror = reject;
    timer = setTimeout(
      () => requestCancellation({ status: "rejected", error: ERROR }),
      options.timeoutMilliseconds ?? PDF_JOB_TIMEOUT_MS,
    );
  } catch {
    reject();
  }
  return {
    result,
    cancel() {
      requestCancellation({ status: "cancelled" });
    },
  };
}
