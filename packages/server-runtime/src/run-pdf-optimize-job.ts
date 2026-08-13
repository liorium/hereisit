import {
  PDF_OPTIMIZE_CONTRACT_ID,
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  PDF_OPTIMIZE_MAX_PAGES,
  type PdfOptimizeCreateRequestV1,
  type PdfOptimizeCreateResponse,
  type PdfOptimizeErrorPayload,
  type PdfOptimizePhase,
  type PdfOptimizeResultDescriptor,
  type PdfOptimizeSpecV1,
  type PdfOptimizeStatusResponseV1,
  pdfOptimizeErrorPayloadSchema,
  pdfOptimizeSpecV1Schema,
} from "@hereisit/tool-contracts/pdf-optimize";
import { TOOL_JOB_CONTRACT_ID } from "@hereisit/tool-contracts/tool-job";
import {
  cancelRemoteJob,
  createClientJobCredentials,
  createPdfOptimizeJob,
  deleteRemoteJob,
  getPdfOptimizeStatus,
  getPdfProcessingPolicy,
  RemoteJobError,
} from "./api-client";
import { fetchPdfOptimizeResult, type RemotePdfResult } from "./download";
import { digestPdfFile } from "./pdf-upload-digest";
import { type UploadPdfInput, uploadPdfInput } from "./upload";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const QUEUE_TIMEOUT = 20 * 60_000;
const RUN_TIMEOUT = 180_000;

export type PdfOptimizeJobOutcome =
  | {
      readonly status: "fulfilled";
      readonly value: RemotePdfResult & {
        readonly descriptor: Extract<PdfOptimizeResultDescriptor, { kind: "download" }>;
        dispose(): Promise<void>;
      };
    }
  | {
      readonly status: "original-retained";
      readonly descriptor: Extract<PdfOptimizeResultDescriptor, { kind: "original-retained" }>;
    }
  | { readonly status: "rejected"; readonly error: PdfOptimizeErrorPayload }
  | { readonly status: "cancelled" };

export interface PdfOptimizeJobHandle {
  readonly result: Promise<PdfOptimizeJobOutcome>;
  cancel(): void;
}

type Identity = { readonly jobId: string; readonly jobToken: string };

export interface PdfOptimizeRuntimeDependencies {
  readonly getPolicy?: typeof getPdfProcessingPolicy;
  readonly createJob?: typeof createPdfOptimizeJob;
  readonly upload?: (input: UploadPdfInput) => Promise<void>;
  readonly digestFile?: typeof digestPdfFile;
  readonly getStatus?: typeof getPdfOptimizeStatus;
  readonly download?: typeof fetchPdfOptimizeResult;
  readonly cancel?: typeof cancelRemoteJob;
  readonly remove?: typeof deleteRemoteJob;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly jitter?: () => number;
  readonly fetch?: typeof fetch;
}

export interface RunPdfOptimizeJobOptions {
  readonly apiOrigin: string;
  readonly anonymousSessionId: string;
  readonly pageCount: number;
  readonly onProgress?: (event: {
    readonly phase: PdfOptimizePhase;
    readonly fraction: number | null;
    readonly sequence: number;
  }) => void;
  readonly dependencies?: PdfOptimizeRuntimeDependencies;
}

export function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeProgress(
  observer: RunPdfOptimizeJobOptions["onProgress"],
  status: PdfOptimizeStatusResponseV1,
): void {
  try {
    observer?.({
      phase: status.phase,
      fraction: status.phaseFraction,
      sequence: status.sequence,
    });
  } catch {
    // Progress cannot own processing.
  }
}

function publicError(error: unknown): PdfOptimizeErrorPayload {
  if (error instanceof RemoteJobError) {
    const parsed = pdfOptimizeErrorPayloadSchema.safeParse(error.toJSON());
    if (parsed.success) return parsed.data;
  }
  return {
    code: "STORAGE_FAILURE",
    message: "PDF 처리 결과를 저장할 수 없습니다.",
    retryable: true,
  };
}

async function poll(input: {
  identity: Identity;
  apiOrigin: string;
  signal: AbortSignal;
  observer?: RunPdfOptimizeJobOptions["onProgress"];
  dependencies: Required<
    Pick<PdfOptimizeRuntimeDependencies, "getStatus" | "sleep" | "now" | "jitter">
  > & {
    fetch?: typeof fetch;
  };
}): Promise<PdfOptimizeStatusResponseV1> {
  const startedAt = input.dependencies.now();
  let runningAt: number | undefined;
  let latest = -1;
  let latestRank = -1;
  let latestStatus: PdfOptimizeStatusResponseV1 | undefined;
  for (let attempt = 0; ; attempt += 1) {
    const status = await input.dependencies.getStatus({
      apiOrigin: input.apiOrigin,
      ...input.identity,
      signal: input.signal,
      ...(input.dependencies.fetch === undefined ? {} : { fetch: input.dependencies.fetch }),
    });
    if (status.sequence > latest) {
      const rank =
        status.state === "created" || status.state === "uploading"
          ? 0
          : status.state === "queued"
            ? 1
            : status.state === "running"
              ? 2
              : 3;
      if (rank < latestRank) {
        throw new RemoteJobError(
          "VERIFICATION_FAILED",
          "PDF 처리 결과를 확인할 수 없습니다.",
          true,
        );
      }
      latest = status.sequence;
      latestRank = rank;
      latestStatus = status;
      safeProgress(input.observer, status);
    }
    if (latestStatus === undefined) continue;
    if (TERMINAL.has(latestStatus.state)) return latestStatus;
    const now = input.dependencies.now();
    if (latestStatus.state === "running") {
      runningAt ??= now;
      if (now - runningAt >= RUN_TIMEOUT) {
        throw new RemoteJobError(
          "ENGINE_TIMEOUT",
          "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
          true,
        );
      }
    } else if (now - startedAt >= QUEUE_TIMEOUT) {
      throw new RemoteJobError("QUEUE_UNAVAILABLE", "처리 서버를 현재 사용할 수 없습니다.", true);
    }
    const base =
      latestStatus.state === "running"
        ? 1_000
        : Math.min(10_000, 2_000 * 2 ** Math.min(attempt, 3));
    await input.dependencies.sleep(
      Math.round(base * (1 + Math.max(-0.1, Math.min(0.1, input.dependencies.jitter())))),
      input.signal,
    );
  }
}

export function runPdfOptimizeJob(
  file: File,
  spec: PdfOptimizeSpecV1,
  options: RunPdfOptimizeJobOptions,
): PdfOptimizeJobHandle {
  const controller = new AbortController();
  const supplied = options.dependencies ?? {};
  const dependencies = {
    getPolicy: supplied.getPolicy ?? getPdfProcessingPolicy,
    createJob: supplied.createJob ?? createPdfOptimizeJob,
    upload: supplied.upload ?? uploadPdfInput,
    digestFile: supplied.digestFile ?? digestPdfFile,
    getStatus: supplied.getStatus ?? getPdfOptimizeStatus,
    download: supplied.download ?? fetchPdfOptimizeResult,
    cancel: supplied.cancel ?? cancelRemoteJob,
    remove: supplied.remove ?? deleteRemoteJob,
    sleep: supplied.sleep ?? sleepWithAbort,
    now: supplied.now ?? Date.now,
    jitter: supplied.jitter ?? (() => Math.random() * 0.2 - 0.1),
    ...(supplied.fetch === undefined ? {} : { fetch: supplied.fetch }),
  };
  const result = (async (): Promise<PdfOptimizeJobOutcome> => {
    let identity: Identity | undefined;
    let keepResult = false;
    try {
      if (
        file.type !== "application/pdf" ||
        file.size < 1 ||
        file.size > PDF_OPTIMIZE_MAX_FILE_BYTES ||
        !Number.isSafeInteger(options.pageCount) ||
        options.pageCount < 1 ||
        options.pageCount > PDF_OPTIMIZE_MAX_PAGES ||
        !pdfOptimizeSpecV1Schema.safeParse(spec).success
      ) {
        throw new RemoteJobError("INPUT_LIMIT_EXCEEDED", "PDF가 처리 제한을 초과했습니다.", false);
      }
      const policy = await dependencies.getPolicy({
        apiOrigin: options.apiOrigin,
        anonymousSessionId: options.anonymousSessionId,
        forceRefresh: true,
        signal: controller.signal,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      if (policy.execution !== "server") {
        throw new RemoteJobError(
          policy.reason,
          policy.reason === "LOCAL_FALLBACK_REQUIRED"
            ? "브라우저에서 원본 PDF를 유지합니다."
            : "처리 서버를 현재 사용할 수 없습니다.",
          policy.reason === "SERVER_PROCESSING_DISABLED",
        );
      }
      const credentials = createClientJobCredentials();
      const request: PdfOptimizeCreateRequestV1 = {
        contract: TOOL_JOB_CONTRACT_ID,
        toolContract: PDF_OPTIMIZE_CONTRACT_ID,
        anonymousSessionId: options.anonymousSessionId,
        ...credentials,
        input: { byteLength: file.size, mime: "application/pdf", pageCount: options.pageCount },
        spec,
      };
      let created: PdfOptimizeCreateResponse = await dependencies.createJob(request, {
        apiOrigin: options.apiOrigin,
        signal: controller.signal,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      identity = { jobId: created.jobId, jobToken: credentials.jobToken };
      let sourceDigest: string | undefined;
      if (created.mode === "upload-required") {
        sourceDigest = await dependencies.digestFile(file, controller.signal);
        try {
          await dependencies.upload({
            apiOrigin: options.apiOrigin,
            ...identity,
            descriptor: created.upload,
            file,
            digest: sourceDigest,
            signal: controller.signal,
          });
        } catch (error) {
          if (!(error instanceof RemoteJobError) || error.code !== "UPLOAD_EXPIRED") throw error;
          created = await dependencies.createJob(request, {
            apiOrigin: options.apiOrigin,
            signal: controller.signal,
            ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
          });
          if (created.jobId !== identity.jobId) {
            throw new RemoteJobError(
              "VERIFICATION_FAILED",
              "PDF 작업 정보가 변경되었습니다.",
              false,
            );
          }
          if (created.mode === "upload-required") {
            await dependencies.upload({
              apiOrigin: options.apiOrigin,
              ...identity,
              descriptor: created.upload,
              file,
              digest: sourceDigest,
              signal: controller.signal,
            });
          }
        }
      }
      const terminal = await poll({
        identity,
        apiOrigin: options.apiOrigin,
        signal: controller.signal,
        ...(options.onProgress === undefined ? {} : { observer: options.onProgress }),
        dependencies,
      });
      if (controller.signal.aborted) return { status: "cancelled" };
      if (terminal.state === "succeeded" && terminal.result.kind === "original-retained") {
        return { status: "original-retained", descriptor: terminal.result };
      }
      if (terminal.state !== "succeeded") {
        if (terminal.state === "cancelled") return { status: "cancelled" };
        if (terminal.state === "failed" || terminal.state === "expired") {
          return { status: "rejected", error: terminal.error };
        }
        throw new RemoteJobError(
          "VERIFICATION_FAILED",
          "PDF 작업 상태가 올바르지 않습니다.",
          false,
        );
      }
      if (terminal.result.kind !== "download") {
        throw new RemoteJobError(
          "VERIFICATION_FAILED",
          "PDF 작업 결과가 올바르지 않습니다.",
          false,
        );
      }
      const downloaded = await dependencies.download({
        apiOrigin: options.apiOrigin,
        ...identity,
        descriptor: terminal.result,
        signal: controller.signal,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      let acknowledgement: Promise<void> | undefined;
      let disposed = false;
      keepResult = true;
      return {
        status: "fulfilled",
        value: {
          ...downloaded,
          acknowledge() {
            if (acknowledgement === undefined) {
              const current = downloaded.acknowledge();
              acknowledgement = current;
              void current.catch(() => {
                if (acknowledgement === current) acknowledgement = undefined;
              });
            }
            return acknowledgement;
          },
          descriptor: terminal.result,
          async dispose() {
            if (disposed) return;
            await dependencies.remove({ apiOrigin: options.apiOrigin, ...(identity as Identity) });
            disposed = true;
          },
        },
      };
    } catch (error) {
      return controller.signal.aborted
        ? { status: "cancelled" }
        : { status: "rejected", error: publicError(error) };
    } finally {
      if (identity !== undefined && !keepResult) {
        if (controller.signal.aborted) {
          await dependencies
            .cancel({ apiOrigin: options.apiOrigin, ...identity })
            .catch(() => undefined);
        }
        await dependencies
          .remove({ apiOrigin: options.apiOrigin, ...identity })
          .catch(() => undefined);
      }
    }
  })();
  return { result, cancel: () => controller.abort() };
}
