import type { ImageOptimizeMime } from "@hereisit/tool-contracts/image-optimize";
import type { ToolJobErrorCode } from "@hereisit/tool-contracts/tool-job";
import { hashJobToken, hashNetworkBuckets, verifyJobToken } from "../auth";
import type {
  BeginUploadResult,
  CommitStoredInputResult,
  JobRepository,
  PreEngineFailureInput,
  SettlePreEngineFailureResult,
} from "../d1-job-repository";
import type {
  ArtifactDeletionAuthorization,
  ArtifactUploadErrorCode,
  InputArtifactObjectKey,
  StoreExactInputArtifactResult,
} from "../r2-artifacts";

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_INPUT_KEY_PATTERN = new RegExp(
  `^inputs/${CANONICAL_UUID_PATTERN.source.slice(1, -1)}$`,
);
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

type UploadJob = Extract<BeginUploadResult, { kind: "ready" }>;

export type UploadRouteRepository = Pick<
  JobRepository,
  | "loadExpectedTokenHash"
  | "beginUpload"
  | "commitStoredInput"
  | "settlePreEngineFailure"
  | "openInvariantCircuit"
>;

export interface UploadRouteRuntime {
  readonly config: { readonly appOrigins: readonly URL[] };
  readonly currentSecret: string;
  readonly previousSecret: string;
  readonly networkRateLimiter: Pick<RateLimit, "limit">;
  readonly repository: UploadRouteRepository;
  readonly storeInput: (input: {
    readonly source: ReadableStream<Uint8Array>;
    readonly key: string;
    readonly byteLength: number;
    readonly mime: ImageOptimizeMime;
    readonly uploadVersion: number;
    readonly deadlineAt: number;
  }) => Promise<StoreExactInputArtifactResult>;
  readonly deleteInput: (authorization: ArtifactDeletionAuthorization) => Promise<void>;
  readonly dispatchOutbox: (jobId: string, now: number) => Promise<boolean>;
  readonly now: () => number;
}

function errorResponse(
  status: number,
  code: ToolJobErrorCode,
  message: string,
  retryable: boolean,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  if (retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return Response.json(
    {
      contract: "tool-job@1",
      error: { code, message, retryable },
    },
    { status, headers },
  );
}

function uploadedResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

function originAllowed(origin: string, allowedOrigins: readonly URL[]): boolean {
  return allowedOrigins.some((allowed) => allowed.origin === origin);
}

function isCanonicalInputKey(value: string): value is InputArtifactObjectKey {
  return CANONICAL_INPUT_KEY_PATTERN.test(value);
}

function readDeletionAuthorization(value: unknown): ArtifactDeletionAuthorization | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!("kind" in value) || !("key" in value)) {
    return null;
  }
  return value.kind === "delete-unowned-object" &&
    typeof value.key === "string" &&
    isCanonicalInputKey(value.key)
    ? { kind: value.kind, key: value.key }
    : null;
}

function parseBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (match === null) return null;
  const token = match[1];
  if (token === undefined) return null;
  return token;
}

async function parseCanonicalBearerToken(request: Request): Promise<string | null> {
  const token = parseBearerToken(request);
  if (token === null) return null;
  try {
    await hashJobToken(token);
  } catch {
    return null;
  }
  return token;
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function exactUploadHeadersMatch(
  request: Request,
  job: Pick<UploadJob, "declaredBytes" | "declaredMime">,
): boolean {
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding !== "identity") {
    return false;
  }
  if (request.headers.has("transfer-encoding")) {
    return false;
  }
  return (
    request.headers.get("content-type") === job.declaredMime &&
    parseContentLength(request.headers.get("content-length")) === job.declaredBytes
  );
}

async function bestEffortDispatch(runtime: UploadRouteRuntime, jobId: string, now: number) {
  try {
    await runtime.dispatchOutbox(jobId, now);
  } catch {
    // The transactional outbox remains retryable; accepted upload responses are not rolled back.
  }
}

function beginRejectionResponse(
  reason: Extract<BeginUploadResult, { kind: "rejected" }>["reason"],
) {
  if (reason === "expired") {
    return errorResponse(410, "UPLOAD_EXPIRED", "업로드 기한이 만료되었습니다.", false);
  }
  if (reason === "cancelled") {
    return errorResponse(409, "CANCELLED", "취소된 작업에는 업로드할 수 없습니다.", false);
  }
  if (reason === "not-found") {
    return errorResponse(404, "INVALID_REQUEST", "업로드 작업을 찾을 수 없습니다.", false);
  }
  return errorResponse(409, "INVALID_REQUEST", "현재 상태에서는 업로드할 수 없습니다.", false);
}

function commitDeletionResponse(
  reason: Extract<CommitStoredInputResult, { kind: "delete-unowned-object" }>["reason"],
): Response {
  if (reason === "expired") {
    return errorResponse(410, "UPLOAD_EXPIRED", "업로드 기한이 만료되었습니다.", false);
  }
  if (reason === "cancelled") {
    return errorResponse(409, "CANCELLED", "작업이 취소되었습니다.", false);
  }
  return errorResponse(409, "UPLOAD_MISMATCH", "업로드 상태가 변경되었습니다.", true);
}

function artifactFailureResponse(code: ArtifactUploadErrorCode): Response {
  if (code === "UPLOAD_EXPIRED") {
    return errorResponse(410, "UPLOAD_EXPIRED", "업로드 기한이 만료되었습니다.", false);
  }
  if (code === "UPLOAD_MISMATCH" || code === "INVALID_ARTIFACT_REQUEST") {
    return errorResponse(
      400,
      "UPLOAD_MISMATCH",
      "업로드한 파일이 요청과 일치하지 않습니다.",
      false,
    );
  }
  return errorResponse(
    503,
    "STORAGE_FAILURE",
    "파일을 저장할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    true,
  );
}

function classifyArtifactFailure(error: unknown): ArtifactUploadErrorCode {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "INVALID_ARTIFACT_REQUEST" ||
      error.code === "UPLOAD_EXPIRED" ||
      error.code === "UPLOAD_MISMATCH" ||
      error.code === "STORAGE_FAILURE")
  ) {
    return error.code;
  }
  return "STORAGE_FAILURE";
}

async function settlePreEngineAndDelete(
  runtime: UploadRouteRuntime,
  settlementInput: PreEngineFailureInput,
): Promise<void> {
  let settlement: SettlePreEngineFailureResult;
  try {
    settlement = await runtime.repository.settlePreEngineFailure(settlementInput);
  } catch {
    return;
  }
  const authorization = settlement.deleteAuthorization;
  if (
    authorization !== undefined &&
    authorization.key === settlementInput.inputKey &&
    isCanonicalInputKey(authorization.key)
  ) {
    try {
      await runtime.deleteInput({
        kind: authorization.kind,
        key: authorization.key,
      });
    } catch {
      // Cleanup is recovered by the repository tombstone/sweeper path.
    }
  }
}

async function settleArtifactFailure(input: {
  runtime: UploadRouteRuntime;
  job: UploadJob;
  now: number;
  code: ArtifactUploadErrorCode;
}): Promise<void> {
  const settlementInput: PreEngineFailureInput =
    input.code === "UPLOAD_EXPIRED"
      ? {
          jobId: input.job.jobId,
          inputKey: input.job.inputKey,
          uploadVersion: input.job.uploadVersion,
          now: input.now,
          outcome: "expired",
          errorCode: "UPLOAD_EXPIRED",
        }
      : {
          jobId: input.job.jobId,
          inputKey: input.job.inputKey,
          uploadVersion: input.job.uploadVersion,
          now: input.now,
          outcome: "failed",
          errorCode:
            input.code === "UPLOAD_MISMATCH" || input.code === "INVALID_ARTIFACT_REQUEST"
              ? "UPLOAD_MISMATCH"
              : "STORAGE_FAILURE",
        };
  await settlePreEngineAndDelete(input.runtime, settlementInput);
}

async function settleCommitDeletion(input: {
  runtime: UploadRouteRuntime;
  job: UploadJob;
  now: number;
  reason: Extract<CommitStoredInputResult, { kind: "delete-unowned-object" }>["reason"];
}): Promise<void> {
  const common = {
    jobId: input.job.jobId,
    inputKey: input.job.inputKey,
    uploadVersion: input.job.uploadVersion,
    now: input.now,
  };
  const settlementInput: PreEngineFailureInput =
    input.reason === "cancelled"
      ? { ...common, outcome: "cancelled", errorCode: "CANCELLED" }
      : input.reason === "expired"
        ? { ...common, outcome: "expired", errorCode: "UPLOAD_EXPIRED" }
        : { ...common, outcome: "failed", errorCode: "UPLOAD_MISMATCH" };
  await settlePreEngineAndDelete(input.runtime, settlementInput);
}

export async function routeUploadRequest(
  request: Request,
  jobId: string,
  runtime: UploadRouteRuntime,
): Promise<Response> {
  if (!CANONICAL_UUID_PATTERN.test(jobId)) {
    return errorResponse(404, "INVALID_REQUEST", "업로드 경로가 올바르지 않습니다.", false);
  }
  const origin = request.headers.get("origin");
  if (origin === null || !originAllowed(origin, runtime.config.appOrigins)) {
    return errorResponse(403, "INVALID_REQUEST", "허용되지 않은 업로드 출처입니다.", false);
  }

  const startedAt = runtime.now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    return errorResponse(
      503,
      "SERVER_PROCESSING_DISABLED",
      "서버 처리를 사용할 수 없습니다.",
      true,
    );
  }
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp === null) {
    return errorResponse(
      503,
      "SERVER_PROCESSING_DISABLED",
      "서버 처리를 사용할 수 없습니다.",
      true,
    );
  }
  let networkKey: string;
  try {
    networkKey = (
      await hashNetworkBuckets({
        ip: connectingIp,
        utcDay: new Date(startedAt).toISOString().slice(0, 10),
        currentSecret: runtime.currentSecret,
        previousSecret: runtime.previousSecret,
      })
    ).writeHash;
  } catch {
    return errorResponse(
      503,
      "SERVER_PROCESSING_DISABLED",
      "서버 처리를 사용할 수 없습니다.",
      true,
    );
  }
  try {
    if (!(await runtime.networkRateLimiter.limit({ key: networkKey })).success) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "잠시 후 다시 시도해 주세요.",
        true,
        RATE_LIMIT_RETRY_AFTER_SECONDS,
      );
    }
  } catch {
    return errorResponse(
      503,
      "SERVER_PROCESSING_DISABLED",
      "서버 처리를 사용할 수 없습니다.",
      true,
    );
  }

  const token = await parseCanonicalBearerToken(request);
  if (token === null) {
    return errorResponse(401, "INVALID_REQUEST", "작업 인증 정보가 올바르지 않습니다.", false);
  }

  let authenticated = false;
  try {
    authenticated = await verifyJobToken({
      token,
      loadExpectedHash: () => runtime.repository.loadExpectedTokenHash(jobId),
      recordResult: () => undefined,
    });
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "작업을 확인할 수 없습니다.", true);
  }
  if (!authenticated) {
    return errorResponse(401, "INVALID_REQUEST", "작업 인증 정보가 올바르지 않습니다.", false);
  }

  let begin: BeginUploadResult;
  try {
    begin = await runtime.repository.beginUpload({ jobId, now: startedAt });
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "업로드를 시작할 수 없습니다.", true);
  }
  if (begin.kind === "rejected") {
    if (
      (begin.reason === "expired" || begin.reason === "cancelled") &&
      "deleteAuthorization" in begin
    ) {
      const authorization = readDeletionAuthorization(begin.deleteAuthorization);
      if (authorization !== null) {
        try {
          await runtime.deleteInput(authorization);
        } catch {
          // Cleanup is recovered by the repository tombstone/sweeper path.
        }
      }
    }
    return beginRejectionResponse(begin.reason);
  }

  if (begin.kind === "already-committed") {
    if (!exactUploadHeadersMatch(request, begin)) {
      return errorResponse(
        400,
        "UPLOAD_MISMATCH",
        "업로드 헤더가 작업과 일치하지 않습니다.",
        false,
      );
    }
    await bestEffortDispatch(runtime, jobId, startedAt);
    return uploadedResponse();
  }
  const job = begin;
  if (!exactUploadHeadersMatch(request, job) || request.body === null) {
    return errorResponse(400, "UPLOAD_MISMATCH", "업로드 헤더가 작업과 일치하지 않습니다.", false);
  }

  let stored: StoreExactInputArtifactResult;
  try {
    stored = await runtime.storeInput({
      source: request.body,
      key: job.inputKey,
      byteLength: job.declaredBytes,
      mime: job.declaredMime,
      uploadVersion: job.uploadVersion,
      deadlineAt: job.uploadExpiresAt,
    });
  } catch (error) {
    const code = classifyArtifactFailure(error);
    const failedAt = runtime.now();
    if (Number.isSafeInteger(failedAt) && failedAt >= 0) {
      await settleArtifactFailure({ runtime, job, now: failedAt, code });
    }
    return artifactFailureResponse(code);
  }

  const completedAt = runtime.now();
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    return errorResponse(503, "STORAGE_FAILURE", "업로드 상태를 저장할 수 없습니다.", true);
  }
  let committed: CommitStoredInputResult;
  try {
    committed = await runtime.repository.commitStoredInput({
      jobId,
      uploadVersion: job.uploadVersion,
      inputEtag: stored.artifact.etag,
      now: completedAt,
    });
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "업로드 상태를 저장할 수 없습니다.", true);
  }

  if (committed.kind === "queued") {
    await bestEffortDispatch(runtime, jobId, completedAt);
    return uploadedResponse();
  }
  if (committed.kind === "already-queued-same-etag") {
    await bestEffortDispatch(runtime, jobId, completedAt);
    return uploadedResponse();
  }
  if (committed.kind === "delete-unowned-object") {
    await settleCommitDeletion({
      runtime,
      job,
      now: completedAt,
      reason: committed.reason,
    });
    return commitDeletionResponse(committed.reason);
  }

  try {
    await runtime.repository.openInvariantCircuit({
      now: completedAt,
      reason: "INPUT_ETAG_CONFLICT",
    });
  } catch {
    // The invariant response remains fail closed even if recording the circuit also fails.
  }
  return errorResponse(
    503,
    "SERVER_PROCESSING_DISABLED",
    "업로드 상태 충돌로 서버 처리가 일시 중지되었습니다.",
    true,
  );
}
