import {
  IMAGE_OPTIMIZE_CONTRACT_ID,
  type ImageOptimizeCreateRequestV1,
  type ImageOptimizeCreateResponse,
  type ImageOptimizeMime,
  type ImageOptimizePhase,
  type ImageOptimizePolicyResponseV1,
  type ImageOptimizeResultDescriptor,
  type ImageOptimizeSpecV1,
  type ImageOptimizeStatusResponseV1,
  imageOptimizeMimeSchema,
} from "@hereisit/tool-contracts/image-optimize";
import { TOOL_JOB_CONTRACT_ID, type ToolJobErrorPayload } from "@hereisit/tool-contracts/tool-job";
import {
  cancelRemoteJob,
  createClientJobCredentials,
  createImageOptimizeJob,
  deleteRemoteJob,
  getImageOptimizeStatus,
  getProcessingPolicy,
  RemoteJobError,
} from "./api-client";
import {
  type CreateRemoteDownloadHandleInput,
  createRemoteDownloadHandle,
  type RemoteDownloadHandle,
} from "./download";
import { type UploadImageInput, uploadImageInput } from "./upload";

const QUEUE_WATCHDOG_MILLISECONDS = 20 * 60_000;
const ACTIVE_WATCHDOG_MILLISECONDS = 180_000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired"]);

export type ProcessingPolicy = ImageOptimizePolicyResponseV1;

export interface RemoteImageOptimizeItem {
  readonly itemId: string;
  readonly file: File;
  readonly width: number;
  readonly height: number;
  readonly spec: ImageOptimizeSpecV1;
}

export type RemoteImageOptimizeEvent =
  | {
      readonly type: "item-progress";
      readonly itemId: string;
      readonly phase: ImageOptimizePhase;
      readonly fraction: number | null;
      readonly sequence: number;
    }
  | {
      readonly type: "item-complete";
      readonly itemId: string;
      readonly result: RemoteImageOptimizeItemResult;
    }
  | { readonly type: "batch-progress"; readonly completed: number; readonly total: number };

export type RemoteImageOptimizeItemResult =
  | {
      readonly status: "fulfilled";
      readonly itemId: string;
      readonly value: RemoteDownloadHandle;
    }
  | {
      readonly status: "original-retained";
      readonly itemId: string;
      readonly descriptor: Extract<ImageOptimizeResultDescriptor, { kind: "original-retained" }>;
    }
  | { readonly status: "rejected"; readonly itemId: string; readonly error: ToolJobErrorPayload }
  | { readonly status: "cancelled"; readonly itemId: string };

export interface RemoteImageOptimizeBatchHandle {
  readonly result: Promise<readonly RemoteImageOptimizeItemResult[]>;
  cancel(): void;
}

interface JobIdentity {
  readonly jobId: string;
  readonly jobToken: string;
}

export interface RemoteRuntimeDependencies {
  readonly getPolicy?: typeof getProcessingPolicy;
  readonly createJob?: typeof createImageOptimizeJob;
  readonly upload?: (input: UploadImageInput) => Promise<void>;
  readonly getStatus?: typeof getImageOptimizeStatus;
  readonly cancel?: typeof cancelRemoteJob;
  readonly remove?: typeof deleteRemoteJob;
  readonly createDownloadHandle?: (input: CreateRemoteDownloadHandleInput) => RemoteDownloadHandle;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly jitter?: () => number;
  readonly fetch?: typeof fetch;
}

export interface RunRemoteImageOptimizeBatchOptions {
  readonly apiOrigin: string;
  readonly anonymousSessionId: string;
  readonly onEvent?: (event: RemoteImageOptimizeEvent) => void;
  readonly dependencies?: RemoteRuntimeDependencies;
}

function safeEmit(
  observer: ((event: RemoteImageOptimizeEvent) => void) | undefined,
  event: RemoteImageOptimizeEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Observers cannot own processing or cleanup.
  }
}

function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function publicError(error: unknown): ToolJobErrorPayload {
  if (error instanceof RemoteJobError) return error.toJSON();
  return {
    code: "STORAGE_FAILURE",
    message: "원격 이미지 처리를 완료하지 못했습니다.",
    retryable: true,
  };
}

function mimeFromFile(file: File): ImageOptimizeMime {
  const parsed = imageOptimizeMimeSchema.safeParse(file.type);
  if (!parsed.success) {
    throw new RemoteJobError("UNSUPPORTED_INPUT", "지원하지 않는 이미지 형식입니다.", false);
  }
  return parsed.data;
}

function buildCreateRequest(
  item: RemoteImageOptimizeItem,
  anonymousSessionId: string,
  credentials: ReturnType<typeof createClientJobCredentials>,
): ImageOptimizeCreateRequestV1 {
  return {
    jobContract: TOOL_JOB_CONTRACT_ID,
    toolContract: IMAGE_OPTIMIZE_CONTRACT_ID,
    anonymousSessionId,
    ...credentials,
    input: {
      byteLength: item.file.size,
      mimeHint: mimeFromFile(item.file),
      width: item.width,
      height: item.height,
    },
    spec: item.spec,
  };
}

function jobIdentity(response: ImageOptimizeCreateResponse, jobToken: string): JobIdentity {
  return { jobId: response.jobId, jobToken };
}

function watchdogError(state: "queued" | "running"): RemoteJobError {
  return new RemoteJobError(
    state === "queued" ? "QUEUE_UNAVAILABLE" : "ENGINE_TIMEOUT",
    state === "queued"
      ? "처리 대기 시간이 길어져 기기 내 처리로 전환해야 합니다."
      : "이미지 처리 시간이 초과되었습니다.",
    true,
  );
}

async function pollUntilTerminal(input: {
  readonly identity: JobIdentity;
  readonly itemId: string;
  readonly apiOrigin: string;
  readonly signal: AbortSignal;
  readonly observer?: (event: RemoteImageOptimizeEvent) => void;
  readonly dependencies: Required<
    Pick<RemoteRuntimeDependencies, "getStatus" | "sleep" | "now" | "jitter">
  > & { readonly fetch?: typeof fetch };
}): Promise<ImageOptimizeStatusResponseV1> {
  const queueStartedAt = input.dependencies.now();
  let runningStartedAt: number | null = null;
  let queuePoll = 0;
  let latestSequence = -1;
  let latestStatus: ImageOptimizeStatusResponseV1 | null = null;
  while (true) {
    const received = await input.dependencies.getStatus({
      apiOrigin: input.apiOrigin,
      ...input.identity,
      ...(input.dependencies.fetch === undefined ? {} : { fetch: input.dependencies.fetch }),
      signal: input.signal,
    });
    if (received.sequence >= latestSequence) {
      latestSequence = received.sequence;
      latestStatus = received;
      safeEmit(input.observer, {
        type: "item-progress",
        itemId: input.itemId,
        phase: received.phase,
        fraction: received.phaseFraction,
        sequence: received.sequence,
      });
    }
    const status = latestStatus;
    if (status === null) continue;
    if (TERMINAL_STATES.has(status.state)) return status;
    const now = input.dependencies.now();
    if (status.state === "running") {
      runningStartedAt ??= now;
      if (now - runningStartedAt >= ACTIVE_WATCHDOG_MILLISECONDS) throw watchdogError("running");
      await input.dependencies.sleep(1_000, input.signal);
      continue;
    }
    if (now - queueStartedAt >= QUEUE_WATCHDOG_MILLISECONDS) throw watchdogError("queued");
    const base = Math.min(10_000, 2_000 * 2 ** Math.min(queuePoll, 3));
    queuePoll += 1;
    const jitter = Math.max(-0.1, Math.min(0.1, input.dependencies.jitter()));
    await input.dependencies.sleep(Math.round(base * (1 + jitter)), input.signal);
  }
}

async function cleanupStartedJob(input: {
  readonly apiOrigin: string;
  readonly identity: JobIdentity;
  readonly lastStatus: ImageOptimizeStatusResponseV1 | null;
  readonly dependencies: Required<
    Pick<RemoteRuntimeDependencies, "getStatus" | "cancel" | "remove" | "sleep">
  > & { readonly fetch?: typeof fetch };
}): Promise<void> {
  const common = {
    apiOrigin: input.apiOrigin,
    ...input.identity,
    ...(input.dependencies.fetch === undefined ? {} : { fetch: input.dependencies.fetch }),
  };
  await input.dependencies.cancel(common).catch(() => undefined);
  let terminal = input.lastStatus !== null && TERMINAL_STATES.has(input.lastStatus.state);
  for (let attempt = 0; !terminal && attempt < 180; attempt += 1) {
    try {
      const status = await input.dependencies.getStatus(common);
      terminal = TERMINAL_STATES.has(status.state);
    } catch {
      // A transient read failure must not skip the state-aware DELETE attempt.
    }
    if (!terminal) await input.dependencies.sleep(1_000).catch(() => undefined);
  }
  await input.dependencies.remove(common).catch(() => undefined);
}

function terminalResult(input: {
  readonly itemId: string;
  readonly status: ImageOptimizeStatusResponseV1;
  readonly identity: JobIdentity;
  readonly apiOrigin: string;
  readonly createDownloadHandle: (input: CreateRemoteDownloadHandleInput) => RemoteDownloadHandle;
  readonly fetch?: typeof fetch;
}): RemoteImageOptimizeItemResult {
  const status = input.status;
  if (status.state === "succeeded" && status.result?.kind === "download") {
    return {
      status: "fulfilled",
      itemId: input.itemId,
      value: input.createDownloadHandle({
        apiOrigin: input.apiOrigin,
        ...input.identity,
        descriptor: status.result,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      }),
    };
  }
  if (status.state === "succeeded" && status.result?.kind === "original-retained") {
    return { status: "original-retained", itemId: input.itemId, descriptor: status.result };
  }
  if (status.state === "cancelled") return { status: "cancelled", itemId: input.itemId };
  return {
    status: "rejected",
    itemId: input.itemId,
    error:
      status.error ??
      new RemoteJobError("STORAGE_FAILURE", "처리 결과가 완전하지 않습니다.", true).toJSON(),
  };
}

export function runRemoteImageOptimizeBatch(
  items: readonly RemoteImageOptimizeItem[],
  options: RunRemoteImageOptimizeBatchOptions,
): RemoteImageOptimizeBatchHandle {
  const controller = new AbortController();
  const supplied = options.dependencies ?? {};
  const dependencies = {
    getPolicy: supplied.getPolicy ?? getProcessingPolicy,
    createJob: supplied.createJob ?? createImageOptimizeJob,
    upload: supplied.upload ?? uploadImageInput,
    getStatus: supplied.getStatus ?? getImageOptimizeStatus,
    cancel: supplied.cancel ?? cancelRemoteJob,
    remove: supplied.remove ?? deleteRemoteJob,
    createDownloadHandle: supplied.createDownloadHandle ?? createRemoteDownloadHandle,
    sleep: supplied.sleep ?? sleepWithAbort,
    now: supplied.now ?? Date.now,
    jitter: supplied.jitter ?? (() => Math.random() * 0.2 - 0.1),
    ...(supplied.fetch === undefined ? {} : { fetch: supplied.fetch }),
  };
  const result = (async (): Promise<readonly RemoteImageOptimizeItemResult[]> => {
    let policy: ProcessingPolicy;
    try {
      policy = await dependencies.getPolicy({
        apiOrigin: options.apiOrigin,
        anonymousSessionId: options.anonymousSessionId,
        forceRefresh: true,
        signal: controller.signal,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
    } catch (error) {
      const mapped: ToolJobErrorPayload = controller.signal.aborted
        ? { code: "CANCELLED", message: "작업이 취소되었습니다.", retryable: false }
        : publicError(error);
      return items.map((item) =>
        mapped.code === "CANCELLED"
          ? { status: "cancelled" as const, itemId: item.itemId }
          : { status: "rejected" as const, itemId: item.itemId, error: mapped },
      );
    }
    if (policy.execution !== "server") {
      const error: ToolJobErrorPayload = {
        code: policy.reason,
        message:
          policy.reason === "LOCAL_FALLBACK_REQUIRED"
            ? "이 설정은 기기 내 처리가 가능한 경우에만 계속할 수 있습니다."
            : "현재 서버 처리를 사용할 수 없습니다.",
        retryable: true,
      };
      return items.map((item) => ({ status: "rejected", itemId: item.itemId, error }));
    }

    const results: RemoteImageOptimizeItemResult[] = [];
    for (const item of items) {
      if (controller.signal.aborted) {
        const cancelled = { status: "cancelled" as const, itemId: item.itemId };
        results.push(cancelled);
        safeEmit(options.onEvent, {
          type: "item-complete",
          itemId: item.itemId,
          result: cancelled,
        });
        safeEmit(options.onEvent, {
          type: "batch-progress",
          completed: results.length,
          total: items.length,
        });
        continue;
      }
      let identity: JobIdentity | null = null;
      let lastStatus: ImageOptimizeStatusResponseV1 | null = null;
      let itemResult: RemoteImageOptimizeItemResult;
      try {
        const credentials = createClientJobCredentials();
        const createRequest = buildCreateRequest(item, options.anonymousSessionId, credentials);
        const created = await dependencies.createJob(createRequest, {
          apiOrigin: options.apiOrigin,
          signal: controller.signal,
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        });
        identity = jobIdentity(created, credentials.jobToken);
        if (created.mode === "upload-required") {
          await dependencies.upload({
            apiOrigin: options.apiOrigin,
            ...identity,
            descriptor: created.upload,
            file: item.file,
            signal: controller.signal,
            onProgress: (loaded, total) =>
              safeEmit(options.onEvent, {
                type: "item-progress",
                itemId: item.itemId,
                phase: "uploading",
                fraction: total === 0 ? null : loaded / total,
                sequence: 0,
              }),
          });
        }
        lastStatus = await pollUntilTerminal({
          identity,
          itemId: item.itemId,
          apiOrigin: options.apiOrigin,
          signal: controller.signal,
          ...(options.onEvent === undefined ? {} : { observer: options.onEvent }),
          dependencies,
        });
        if (controller.signal.aborted) {
          await cleanupStartedJob({
            apiOrigin: options.apiOrigin,
            identity,
            lastStatus,
            dependencies,
          });
          itemResult = { status: "cancelled", itemId: item.itemId };
        } else {
          itemResult = terminalResult({
            itemId: item.itemId,
            status: lastStatus,
            identity,
            apiOrigin: options.apiOrigin,
            createDownloadHandle: dependencies.createDownloadHandle,
            ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
          });
        }
      } catch (error) {
        if (identity !== null) {
          await cleanupStartedJob({
            apiOrigin: options.apiOrigin,
            identity,
            lastStatus,
            dependencies,
          });
        }
        itemResult = controller.signal.aborted
          ? { status: "cancelled", itemId: item.itemId }
          : { status: "rejected", itemId: item.itemId, error: publicError(error) };
      }
      results.push(itemResult);
      safeEmit(options.onEvent, { type: "item-complete", itemId: item.itemId, result: itemResult });
      safeEmit(options.onEvent, {
        type: "batch-progress",
        completed: results.length,
        total: items.length,
      });
    }
    return results;
  })();
  return { result, cancel: () => controller.abort() };
}

export type { RemoteArchivePart, RemoteDownloadHandle } from "./download";
