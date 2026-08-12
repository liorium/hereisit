import {
  type ImageOptimizeMime,
  type ImageOptimizePhase,
  type ImageOptimizeWarningCode,
  imageOptimizeStatusResponseSchema,
} from "@hereisit/tool-contracts/image-optimize";
import {
  type PdfOptimizeMime,
  type PdfOptimizePhase,
  type PdfOptimizeWarningCode,
  pdfOptimizeErrorPayloadSchema,
  pdfOptimizeStatusResponseSchema,
} from "@hereisit/tool-contracts/pdf-optimize";
import {
  type ToolJobErrorCode,
  type ToolJobState,
  toolJobMutationAcknowledgementSchema,
} from "@hereisit/tool-contracts/tool-job";
import { hashJobToken, verifyJobToken } from "../auth";

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const DOWNLOAD_LEASE_MILLISECONDS = 2 * 60_000;

export interface LifecycleJob {
  readonly contractId: "image.optimize@1" | "pdf.optimize@1";
  readonly declaredBytes: number;
  readonly declaredPageCount: number | null;
  readonly jobId: string;
  readonly state: ToolJobState;
  readonly phase: ImageOptimizePhase | PdfOptimizePhase;
  readonly phaseFraction: number | null;
  readonly sequence: number;
  readonly attempt: number;
  readonly inputKey: string;
  readonly outputKey: string;
  readonly outputBytes: number | null;
  readonly outputMime: ImageOptimizeMime | PdfOptimizeMime | null;
  readonly outputWidth: number | null;
  readonly outputHeight: number | null;
  readonly outputPageCount: number | null;
  readonly pdfProfile: "structural" | "image-optimized" | null;
  readonly resultKind: "download" | "original-retained" | null;
  readonly engineBuildId: string | null;
  readonly codecBuildId: string | null;
  readonly warnings: readonly (ImageOptimizeWarningCode | PdfOptimizeWarningCode)[];
  readonly testedCandidates: number | null;
  readonly errorCode: ToolJobErrorCode | null;
  readonly errorGuidance: "TRY_BALANCED_PRESET" | null;
  readonly actualWeightedUnits: number | null;
  readonly queuedAt: number | null;
  readonly startedAt: number | null;
  readonly engineContactStartedAt: number | null;
  readonly finishedAt: number | null;
  readonly resultExpiresAt: number | null;
  readonly downloadAcknowledgedAt: number | null;
  readonly downloadLeaseExpiresAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type LifecycleMutationResult =
  | {
      readonly kind: "cancelled-and-settled";
      readonly job: LifecycleJob;
      readonly inputKey: string;
      readonly outputKey: string;
    }
  | { readonly kind: "running"; readonly job: LifecycleJob }
  | { readonly kind: "terminal"; readonly job: LifecycleJob }
  | { readonly kind: "missing" };

export type ClaimDownloadResult =
  | { readonly kind: "claimed"; readonly job: LifecycleJob }
  | { readonly kind: "busy" | "expired" | "not-ready" | "missing" }
  | { readonly kind: "original-retained"; readonly job: LifecycleJob };

export interface LifecycleRepository {
  loadExpectedTokenHash(jobId: string): Promise<string | null>;
  readJob(jobId: string): Promise<LifecycleJob | null>;
  cancelJob(jobId: string, now: number): Promise<LifecycleMutationResult>;
  deleteJob(jobId: string, now: number): Promise<LifecycleMutationResult>;
  claimDownload(input: {
    jobId: string;
    leaseHash: string;
    now: number;
    expiresAt: number;
  }): Promise<ClaimDownloadResult>;
  loadDownloadLeaseHash(jobId: string): Promise<string | null>;
  acknowledgeDownload(
    jobId: string,
    leaseHash: string,
    now: number,
  ): Promise<
    | { readonly kind: "acknowledged"; readonly outputKey: string }
    | { readonly kind: "invalid-lease" | "missing" }
  >;
  completeResultDeletion(jobId: string, now: number): Promise<boolean>;
}

export interface ResultArtifact {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpEtag: string;
  readonly contentType: string | undefined;
  readonly kind: string | undefined;
  readonly jobId: string | undefined;
  readonly sha256: string | undefined;
}

export interface LifecycleRouteRuntime {
  readonly now: () => number;
  readonly randomLeaseToken: () => string;
  readonly networkKey: (request: Request, now: number) => Promise<string>;
  readonly networkRateLimiter: Pick<RateLimit, "limit">;
  readonly jobRateLimiter: Pick<RateLimit, "limit">;
  readonly downloadRateLimiter: Pick<RateLimit, "limit">;
  readonly repository: LifecycleRepository;
  readonly artifacts: {
    getOutput(key: string): Promise<ResultArtifact | null>;
    deleteInput(key: string): Promise<void>;
    deleteOutput(key: string): Promise<void>;
  };
  readonly engine: {
    cancel(jobId: string): Promise<void>;
    remove(jobId: string): Promise<void>;
  };
}

type Authorized = { readonly now: number };

function errorResponse(
  status: number,
  code: ToolJobErrorCode,
  message: string,
  retryable: boolean,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
  });
  if (retryAfterSeconds !== undefined) headers.set("retry-after", String(retryAfterSeconds));
  return Response.json(
    { contract: "tool-job@1", error: { code, message, retryable } },
    { status, headers },
  );
}

function acknowledgement(jobId: string, action: "cancelled" | "deleted"): Response {
  const payload = toolJobMutationAcknowledgementSchema.parse({
    contract: "tool-job@1",
    jobId,
    action,
    acknowledged: true,
  });
  return Response.json(payload, {
    status: action === "cancelled" ? 202 : 200,
    headers: { "cache-control": "private, no-store" },
  });
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

async function authorize(
  request: Request,
  jobId: string,
  runtime: LifecycleRouteRuntime,
): Promise<Authorized | Response> {
  if (!CANONICAL_UUID_PATTERN.test(jobId)) {
    return errorResponse(404, "INVALID_REQUEST", "작업을 찾을 수 없습니다.", false);
  }
  const now = runtime.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return errorResponse(503, "SERVER_PROCESSING_DISABLED", "작업을 확인할 수 없습니다.", true);
  }
  let networkKey: string;
  try {
    networkKey = await runtime.networkKey(request, now);
    if (!(await runtime.networkRateLimiter.limit({ key: networkKey })).success) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        true,
        RATE_LIMIT_RETRY_AFTER_SECONDS,
      );
    }
    if (!(await runtime.jobRateLimiter.limit({ key: jobId })).success) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        true,
        RATE_LIMIT_RETRY_AFTER_SECONDS,
      );
    }
  } catch {
    return errorResponse(503, "SERVER_PROCESSING_DISABLED", "작업을 확인할 수 없습니다.", true);
  }

  const token = bearerToken(request);
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
  return { now };
}

function duration(start: number | null, end: number | null): number {
  if (start === null || end === null || end < start) return 0;
  return end - start;
}

function publicError(job: LifecycleJob) {
  const code =
    job.errorCode ??
    (job.state === "cancelled" ? "CANCELLED" : job.state === "expired" ? "EXPIRED" : null);
  if (code === null) return undefined;
  const messages: Record<ToolJobErrorCode, string> = {
    INVALID_REQUEST: "요청을 처리할 수 없습니다.",
    UNSUPPORTED_INPUT: "지원하지 않는 이미지입니다.",
    UNSUPPORTED_FEATURE: "지원하지 않는 이미지 기능이 포함되어 있습니다.",
    INPUT_LIMIT_EXCEEDED: "파일 크기 제한을 초과했습니다.",
    PIXEL_LIMIT_EXCEEDED: "이미지 픽셀 제한을 초과했습니다.",
    RATE_LIMITED: "요청이 너무 많습니다.",
    QUOTA_EXCEEDED: "현재 처리 한도에 도달했습니다.",
    SERVER_PROCESSING_DISABLED: "현재 서버 처리를 사용할 수 없습니다.",
    LOCAL_FALLBACK_REQUIRED: "기기 내 처리로 전환해야 합니다.",
    UPLOAD_EXPIRED: "업로드 기한이 만료되었습니다.",
    UPLOAD_MISMATCH: "업로드한 파일이 요청과 일치하지 않습니다.",
    QUEUE_UNAVAILABLE: "처리 대기열을 사용할 수 없습니다.",
    ENGINE_TIMEOUT:
      job.errorGuidance === "TRY_BALANCED_PRESET"
        ? "처리가 오래 걸렸습니다. 더 빠른 균형 프리셋으로 다시 시도해 주세요."
        : "이미지 처리 시간이 초과되었습니다.",
    ENGINE_OOM: "이미지를 처리할 메모리가 부족했습니다.",
    ENGINE_CRASH: "이미지 처리 엔진이 중단되었습니다.",
    STORAGE_FAILURE: "파일 저장소를 사용할 수 없습니다.",
    VERIFICATION_FAILED: "처리 결과를 검증하지 못했습니다.",
    CANCELLED: "작업이 취소되었습니다.",
    EXPIRED: "작업이 만료되었습니다.",
  };
  if (job.contractId === "pdf.optimize@1") {
    const messages: Partial<Record<ToolJobErrorCode, string>> = {
      UNSUPPORTED_INPUT: "이 PDF는 처리 서버에서 압축할 수 없습니다.",
      UNSUPPORTED_FEATURE: "이 PDF 기능은 처리 서버에서 지원하지 않습니다.",
      INPUT_LIMIT_EXCEEDED: "PDF가 처리 제한을 초과했습니다.",
      SERVER_PROCESSING_DISABLED: "처리 서버를 현재 사용할 수 없습니다.",
      LOCAL_FALLBACK_REQUIRED: "브라우저에서 원본 PDF를 유지합니다.",
      UPLOAD_EXPIRED: "PDF 업로드 시간이 만료되었습니다.",
      UPLOAD_MISMATCH: "업로드한 PDF를 확인할 수 없습니다.",
      QUEUE_UNAVAILABLE: "처리 서버를 현재 사용할 수 없습니다.",
      ENGINE_TIMEOUT: "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
      ENGINE_OOM: "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
      ENGINE_CRASH: "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
      STORAGE_FAILURE: "PDF 처리 결과를 저장할 수 없습니다.",
      VERIFICATION_FAILED: "PDF 처리 결과를 확인할 수 없습니다.",
      CANCELLED: "PDF 압축을 취소했습니다.",
      EXPIRED: "PDF 압축 결과가 만료되었습니다.",
    };
    const safeCode = messages[code] === undefined ? "VERIFICATION_FAILED" : code;
    return pdfOptimizeErrorPayloadSchema.parse({
      code: safeCode,
      message: messages[safeCode],
      retryable: ![
        "UNSUPPORTED_INPUT",
        "UNSUPPORTED_FEATURE",
        "INPUT_LIMIT_EXCEEDED",
        "LOCAL_FALLBACK_REQUIRED",
        "CANCELLED",
        "EXPIRED",
      ].includes(safeCode),
    });
  }
  return {
    code,
    message: messages[code],
    retryable: false,
    ...(job.errorGuidance !== null ? { guidance: job.errorGuidance } : {}),
  } as const;
}

function statusPayload(job: LifecycleJob) {
  if (job.contractId === "pdf.optimize@1") {
    let result: Record<string, unknown> | undefined;
    if (job.state === "succeeded" && job.resultKind === "download") {
      if (
        job.outputMime !== "application/pdf" ||
        job.outputBytes === null ||
        job.outputPageCount === null ||
        job.pdfProfile === null ||
        job.engineBuildId === null
      ) {
        throw new TypeError("Stored PDF download result is incomplete.");
      }
      result = {
        kind: "download",
        mime: job.outputMime,
        sourceByteLength: job.declaredBytes,
        byteLength: job.outputBytes,
        pageCount: job.outputPageCount,
        profile: job.pdfProfile,
        engineBuildId: job.engineBuildId,
        warnings: job.warnings,
      };
    } else if (job.state === "succeeded" && job.resultKind === "original-retained") {
      if (job.declaredPageCount === null || job.engineBuildId === null) {
        throw new TypeError("Stored PDF original-retained result is incomplete.");
      }
      result = {
        kind: "original-retained",
        sourceByteLength: job.declaredBytes,
        pageCount: job.declaredPageCount,
        engineBuildId: job.engineBuildId,
        warnings: job.warnings,
      };
    }
    return pdfOptimizeStatusResponseSchema.parse({
      contract: "tool-job@1",
      jobId: job.jobId,
      state: job.state,
      phase: job.phase,
      phaseFraction: job.phaseFraction,
      sequence: job.sequence,
      attempt: job.attempt,
      ...(result !== undefined ? { result } : {}),
      ...(job.state === "failed" || job.state === "cancelled" || job.state === "expired"
        ? { error: publicError(job) }
        : {}),
      ...(job.actualWeightedUnits !== null ? { actualWeightedUnits: job.actualWeightedUnits } : {}),
      updatedAt: new Date(job.updatedAt).toISOString(),
    });
  }
  const finishedOrUpdated = job.finishedAt ?? job.updatedAt;
  const timing = {
    queueMs: duration(job.queuedAt, job.startedAt),
    processingMs: duration(job.engineContactStartedAt, finishedOrUpdated),
    totalMs: duration(job.createdAt, finishedOrUpdated),
  };
  let result: Record<string, unknown> | undefined;
  if (job.state === "succeeded" && job.resultKind === "download") {
    if (
      job.outputMime === null ||
      job.outputBytes === null ||
      job.outputWidth === null ||
      job.outputHeight === null ||
      job.engineBuildId === null ||
      job.codecBuildId === null ||
      job.resultExpiresAt === null
    ) {
      throw new TypeError("Stored download result is incomplete.");
    }
    result = {
      kind: "download",
      mime: job.outputMime,
      byteLength: job.outputBytes,
      width: job.outputWidth,
      height: job.outputHeight,
      engineBuildId: job.engineBuildId,
      codecBuildId: job.codecBuildId,
      warnings: job.warnings,
      timing,
      expiresAt: new Date(job.resultExpiresAt).toISOString(),
    };
  } else if (job.state === "succeeded" && job.resultKind === "original-retained") {
    if (job.engineBuildId === null || job.codecBuildId === null || job.testedCandidates === null) {
      throw new TypeError("Stored original-retained result is incomplete.");
    }
    result = {
      kind: "original-retained",
      reason: "NO_SIZE_REDUCTION",
      testedCandidates: job.testedCandidates,
      engineBuildId: job.engineBuildId,
      codecBuildId: job.codecBuildId,
      warnings: job.warnings,
      timing,
    };
  }
  return imageOptimizeStatusResponseSchema.parse({
    contract: "tool-job@1",
    jobId: job.jobId,
    state: job.state,
    phase: job.phase,
    phaseFraction: job.phaseFraction,
    sequence: job.sequence,
    attempt: job.attempt,
    ...(result !== undefined ? { result } : {}),
    ...(job.state === "failed" || job.state === "cancelled" || job.state === "expired"
      ? { error: publicError(job) }
      : {}),
    ...(job.actualWeightedUnits !== null ? { actualWeightedUnits: job.actualWeightedUnits } : {}),
    updatedAt: new Date(job.updatedAt).toISOString(),
  });
}

export async function routeJobStatusRequest(
  request: Request,
  jobId: string,
  runtime: LifecycleRouteRuntime,
): Promise<Response> {
  const authorization = await authorize(request, jobId, runtime);
  if (authorization instanceof Response) return authorization;
  try {
    const job = await runtime.repository.readJob(jobId);
    if (job === null)
      return errorResponse(404, "INVALID_REQUEST", "작업을 찾을 수 없습니다.", false);
    return Response.json(statusPayload(job), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "작업 상태를 불러올 수 없습니다.", true);
  }
}

async function bestEffortCleanup(
  runtime: LifecycleRouteRuntime,
  jobId: string,
  inputKey: string,
  outputKey: string,
): Promise<void> {
  await Promise.allSettled([
    runtime.artifacts.deleteInput(inputKey),
    runtime.artifacts.deleteOutput(outputKey),
    runtime.engine.remove(jobId),
  ]);
}

export async function routeJobCancelRequest(
  request: Request,
  jobId: string,
  runtime: LifecycleRouteRuntime,
): Promise<Response> {
  const authorization = await authorize(request, jobId, runtime);
  if (authorization instanceof Response) return authorization;
  let result: LifecycleMutationResult;
  try {
    result = await runtime.repository.cancelJob(jobId, authorization.now);
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "작업을 취소할 수 없습니다.", true);
  }
  if (result.kind === "missing") {
    return errorResponse(404, "INVALID_REQUEST", "작업을 찾을 수 없습니다.", false);
  }
  if (result.kind === "running") {
    await runtime.engine.cancel(jobId).catch(() => undefined);
    return acknowledgement(jobId, "cancelled");
  }
  if (result.kind === "cancelled-and-settled") {
    await bestEffortCleanup(runtime, jobId, result.inputKey, result.outputKey);
    return acknowledgement(jobId, "cancelled");
  }
  if (result.job.state === "succeeded") {
    return errorResponse(409, "INVALID_REQUEST", "완료된 작업은 결과 삭제를 사용해 주세요.", false);
  }
  return acknowledgement(jobId, "cancelled");
}

function validDownloadJob(job: LifecycleJob): job is LifecycleJob & {
  outputBytes: number;
  outputMime: ImageOptimizeMime | PdfOptimizeMime;
} {
  return (
    job.state === "succeeded" &&
    job.resultKind === "download" &&
    job.outputBytes !== null &&
    job.outputMime !== null &&
    job.downloadAcknowledgedAt === null
  );
}

export async function routeJobResultRequest(
  request: Request,
  jobId: string,
  runtime: LifecycleRouteRuntime,
): Promise<Response> {
  const authorization = await authorize(request, jobId, runtime);
  if (authorization instanceof Response) return authorization;
  try {
    if (!(await runtime.downloadRateLimiter.limit({ key: jobId })).success) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "다운로드 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        true,
        RATE_LIMIT_RETRY_AFTER_SECONDS,
      );
    }
  } catch {
    return errorResponse(503, "SERVER_PROCESSING_DISABLED", "결과를 다운로드할 수 없습니다.", true);
  }
  const leaseToken = runtime.randomLeaseToken();
  if (!OPAQUE_TOKEN_PATTERN.test(leaseToken)) {
    return errorResponse(503, "SERVER_PROCESSING_DISABLED", "결과를 다운로드할 수 없습니다.", true);
  }
  let leaseHash: string;
  try {
    leaseHash = await hashJobToken(leaseToken);
  } catch {
    return errorResponse(503, "SERVER_PROCESSING_DISABLED", "결과를 다운로드할 수 없습니다.", true);
  }
  let claimed: ClaimDownloadResult;
  try {
    claimed = await runtime.repository.claimDownload({
      jobId,
      leaseHash,
      now: authorization.now,
      expiresAt: authorization.now + DOWNLOAD_LEASE_MILLISECONDS,
    });
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "결과를 준비할 수 없습니다.", true);
  }
  if (claimed.kind === "original-retained") {
    return errorResponse(
      409,
      "INVALID_REQUEST",
      "원본보다 작아지지 않아 원본을 유지했습니다.",
      false,
    );
  }
  if (claimed.kind === "busy") {
    return errorResponse(409, "RATE_LIMITED", "다른 다운로드가 진행 중입니다.", true, 120);
  }
  if (claimed.kind === "expired") {
    return errorResponse(410, "EXPIRED", "결과 보관 시간이 만료되었습니다.", false);
  }
  if (claimed.kind !== "claimed" || !validDownloadJob(claimed.job)) {
    return errorResponse(409, "INVALID_REQUEST", "다운로드할 결과가 없습니다.", false);
  }
  let artifact: ResultArtifact | null;
  try {
    artifact = await runtime.artifacts.getOutput(claimed.job.outputKey);
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "결과 파일을 불러올 수 없습니다.", true);
  }
  if (
    artifact === null ||
    artifact.size !== claimed.job.outputBytes ||
    artifact.contentType !== claimed.job.outputMime ||
    artifact.kind !== "output" ||
    artifact.jobId !== jobId ||
    artifact.sha256 === undefined ||
    !/^[A-Za-z0-9+/]{43}=$/.test(artifact.sha256) ||
    !/^"[\x20-\x7e]+"$/.test(artifact.httpEtag)
  ) {
    await artifact?.body.cancel().catch(() => undefined);
    return errorResponse(503, "VERIFICATION_FAILED", "결과 파일을 검증할 수 없습니다.", true);
  }
  const extension =
    claimed.job.outputMime === "application/pdf"
      ? "pdf"
      : claimed.job.outputMime === "image/jpeg"
        ? "jpg"
        : claimed.job.outputMime === "image/png"
          ? "png"
          : "webp";
  return new Response(artifact.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="hereisit-compressed.${extension}"`,
      "content-length": String(artifact.size),
      "content-type": claimed.job.outputMime,
      digest: `sha-256=${artifact.sha256}`,
      etag: artifact.httpEtag,
      "x-content-type-options": "nosniff",
      "x-download-lease": leaseToken,
    },
  });
}

export async function routeJobDownloadedRequest(
  request: Request,
  jobId: string,
  runtime: LifecycleRouteRuntime,
): Promise<Response> {
  const authorization = await authorize(request, jobId, runtime);
  if (authorization instanceof Response) return authorization;
  const leaseToken = request.headers.get("x-download-lease");
  if (leaseToken === null || !OPAQUE_TOKEN_PATTERN.test(leaseToken)) {
    return errorResponse(409, "INVALID_REQUEST", "다운로드 확인 정보가 올바르지 않습니다.", false);
  }
  let leaseAuthenticated = false;
  try {
    leaseAuthenticated = await verifyJobToken({
      token: leaseToken,
      loadExpectedHash: () => runtime.repository.loadDownloadLeaseHash(jobId),
      recordResult: () => undefined,
    });
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "다운로드를 확인할 수 없습니다.", true);
  }
  if (!leaseAuthenticated) {
    return errorResponse(409, "INVALID_REQUEST", "다운로드 확인 정보가 만료되었습니다.", false);
  }
  let acknowledged: Awaited<ReturnType<LifecycleRepository["acknowledgeDownload"]>>;
  try {
    const leaseHash = await hashJobToken(leaseToken);
    acknowledged = await runtime.repository.acknowledgeDownload(
      jobId,
      leaseHash,
      authorization.now,
    );
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "다운로드를 확인할 수 없습니다.", true);
  }
  if (acknowledged.kind !== "acknowledged") {
    return errorResponse(409, "INVALID_REQUEST", "다운로드 확인 정보가 만료되었습니다.", false);
  }
  try {
    await runtime.artifacts.deleteOutput(acknowledged.outputKey);
    await runtime.repository.completeResultDeletion(jobId, authorization.now);
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "결과 삭제를 완료하지 못했습니다.", true);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
}

export async function routeJobDeleteRequest(
  request: Request,
  jobId: string,
  runtime: LifecycleRouteRuntime,
): Promise<Response> {
  const authorization = await authorize(request, jobId, runtime);
  if (authorization instanceof Response) return authorization;
  let result: LifecycleMutationResult;
  try {
    result = await runtime.repository.deleteJob(jobId, authorization.now);
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "작업을 삭제할 수 없습니다.", true);
  }
  if (result.kind === "missing") {
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  }
  if (result.kind === "running") {
    await runtime.engine.cancel(jobId).catch(() => undefined);
    return new Response(null, { status: 202, headers: { "cache-control": "private, no-store" } });
  }
  const job = result.job;
  try {
    if (result.kind === "cancelled-and-settled") {
      await Promise.all([
        runtime.artifacts.deleteInput(result.inputKey),
        runtime.artifacts.deleteOutput(result.outputKey),
        runtime.engine.remove(jobId),
      ]);
    } else {
      await Promise.all([
        runtime.artifacts.deleteInput(job.inputKey),
        runtime.artifacts.deleteOutput(job.outputKey),
        runtime.engine.remove(jobId),
      ]);
      if (job.state === "succeeded") {
        await runtime.repository.completeResultDeletion(jobId, authorization.now);
      }
    }
  } catch {
    return errorResponse(503, "STORAGE_FAILURE", "작업 파일 삭제를 완료하지 못했습니다.", true);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
}
