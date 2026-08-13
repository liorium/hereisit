import { PDF_OPTIMIZE_MAX_FILE_BYTES } from "@hereisit/tool-contracts/pdf-optimize";
import { RemoteJobError } from "./api-client";

const DIGEST_PATTERN = /^sha-256=[A-Za-z0-9+/]{43}=$/;
const TIMEOUT_MILLISECONDS = 60_000;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function digestPdfFile(file: File, signal?: AbortSignal): Promise<string> {
  if (
    typeof Worker === "undefined" ||
    !(file instanceof File) ||
    file.type !== "application/pdf" ||
    file.size < 1 ||
    file.size > PDF_OPTIMIZE_MAX_FILE_BYTES ||
    signal?.aborted
  ) {
    return Promise.reject(
      new RemoteJobError("INVALID_REQUEST", "PDF 업로드 정보를 확인할 수 없습니다.", false),
    );
  }
  return new Promise((resolve, reject) => {
    const jobId = crypto.randomUUID();
    let settled = false;
    let posted = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: RemoteJobError, digest?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker?.terminate();
      worker = undefined;
      if (error !== undefined || digest === undefined) {
        reject(
          error ??
            new RemoteJobError(
              "VERIFICATION_FAILED",
              "PDF 업로드 정보를 확인할 수 없습니다.",
              true,
            ),
        );
      } else {
        resolve(digest);
      }
    };
    const abort = () => finish(new RemoteJobError("CANCELLED", "업로드가 취소되었습니다.", false));
    try {
      worker = new Worker(new URL("./pdf-upload-digest.worker.ts", import.meta.url), {
        type: "module",
        name: "hereisit-pdf-upload-digest",
      });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (typeof message !== "object" || message === null || Array.isArray(message)) return;
        const record = message as Record<string, unknown>;
        if (record.protocol !== 1 || typeof record.type !== "string") return;
        if (record.type === "ready" && exactKeys(record, ["protocol", "type"])) {
          if (posted || settled || worker === undefined) return;
          posted = true;
          worker.postMessage({ protocol: 1, type: "digest", jobId, file });
          return;
        }
        if (record.jobId !== jobId) return;
        if (
          record.type === "complete" &&
          exactKeys(record, ["protocol", "type", "jobId", "digest"]) &&
          typeof record.digest === "string" &&
          DIGEST_PATTERN.test(record.digest)
        ) {
          finish(undefined, record.digest);
        } else if (record.type === "failed" && exactKeys(record, ["protocol", "type", "jobId"])) {
          finish(
            new RemoteJobError(
              "VERIFICATION_FAILED",
              "PDF 업로드 정보를 확인할 수 없습니다.",
              true,
            ),
          );
        }
      };
      worker.onerror = () =>
        finish(
          new RemoteJobError("VERIFICATION_FAILED", "PDF 업로드 정보를 확인할 수 없습니다.", true),
        );
      worker.onmessageerror = () =>
        finish(
          new RemoteJobError("VERIFICATION_FAILED", "PDF 업로드 정보를 확인할 수 없습니다.", true),
        );
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () =>
          finish(
            new RemoteJobError(
              "VERIFICATION_FAILED",
              "PDF 업로드 정보를 확인할 수 없습니다.",
              true,
            ),
          ),
        TIMEOUT_MILLISECONDS,
      );
    } catch {
      finish(
        new RemoteJobError("VERIFICATION_FAILED", "PDF 업로드 정보를 확인할 수 없습니다.", true),
      );
    }
  });
}
