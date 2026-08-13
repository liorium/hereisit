import { estimateResources } from "@hereisit/server-job";
import {
  type ImageOptimizeCreateRequestV1,
  type ImageOptimizeCreateResponse,
  imageOptimizeCreateRequestSchema,
} from "@hereisit/tool-contracts/image-optimize";
import {
  type PdfOptimizeCreateRequestV1,
  type PdfOptimizeCreateResponse,
  pdfOptimizeCreateRequestSchema,
} from "@hereisit/tool-contracts/pdf-optimize";
import type { ToolJobErrorCode } from "@hereisit/tool-contracts/tool-job";
import {
  hashAnonymousSessionId,
  hashJobToken,
  hashNetworkBuckets,
  sessionRolloutBucket,
} from "../auth";
import type {
  AnyReserveAndCreateInput,
  PdfReservationJob,
  ReservationJob,
  ReserveAndCreateResult,
} from "../d1-job-repository";
import type { OperationalConfig } from "../env";
import { createOpaqueObjectKey } from "../r2-artifacts";

const MAXIMUM_CREATE_BODY_BYTES = 16_384;
const UPLOAD_DEADLINE_MILLISECONDS = 10 * 60_000;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const MAXIMUM_JOB_ID_ATTEMPTS = 3;

type CreateConfig = Pick<
  OperationalConfig,
  | "appOrigins"
  | "rolloutPercent"
  | "maintainerSessionHashes"
  | "accountDailyWeightedUnitLimit"
  | "anonymousDailyWeightedUnitLimit"
  | "networkDailyWeightedUnitLimit"
  | "accountPendingJobLimit"
  | "networkPendingJobLimit"
  | "maximumQueuedAgeSeconds"
  | "pdfPublicAdmissionEnabled"
>;

export interface CreateJobLogEvent {
  readonly jobId: string;
  readonly contractId: "image.optimize@1" | "pdf.optimize@1";
  readonly byteCount: number;
  readonly pixelCount?: number;
  readonly pageCount?: number;
  readonly resourceClass: "image-standard-v1" | "image-large-v1" | "pdf-standard-v1";
  readonly reservedWeightedUnits: number;
}

export interface CreateJobRouteRuntime {
  readonly config: CreateConfig;
  readonly currentSecret: string;
  readonly previousSecret: string;
  readonly networkRateLimiter: Pick<RateLimit, "limit">;
  readonly sessionRateLimiter: Pick<RateLimit, "limit">;
  readonly repository: {
    reserveAndCreate(input: AnyReserveAndCreateInput): Promise<AnyReserveResult>;
  };
  readonly readJson: (request: Request, maximumBytes?: number) => Promise<unknown>;
  readonly now: () => Date;
  readonly randomUuid: () => string;
  readonly logCreated: (event: CreateJobLogEvent) => void;
}

function toolErrorResponse(
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

function processingDisabledResponse(
  reason: "SERVER_PROCESSING_DISABLED" | "LOCAL_FALLBACK_REQUIRED",
): Response {
  return toolErrorResponse(
    503,
    reason,
    reason === "SERVER_PROCESSING_DISABLED"
      ? "현재 서버 처리를 사용할 수 없습니다."
      : "이 요청은 기기 내 처리로 전환해야 합니다.",
    true,
  );
}

function rateLimitedResponse(scope: "network" | "session"): Response {
  const response = toolErrorResponse(
    429,
    "RATE_LIMITED",
    "잠시 후 다시 시도해 주세요.",
    true,
    RATE_LIMIT_RETRY_AFTER_SECONDS,
  );
  response.headers.set("x-hereisit-rate-limit-scope", scope);
  return response;
}

function quotaResponse(): Response {
  return toolErrorResponse(
    429,
    "QUOTA_EXCEEDED",
    "현재 처리 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
    true,
    RATE_LIMIT_RETRY_AFTER_SECONDS,
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utcDay(now: Date): string {
  if (Number.isNaN(now.valueOf())) {
    throw new RangeError("Create route time must be valid.");
  }
  return now.toISOString().slice(0, 10);
}

type AnyReservationJob = ReservationJob | PdfReservationJob;
type AnyCreateResponse = ImageOptimizeCreateResponse | PdfOptimizeCreateResponse;
type AnyReserveResult =
  | {
      kind: "created";
      mode: "upload-required";
      job: AnyReservationJob;
    }
  | {
      kind: "replayed";
      mode: "upload-required" | "existing-job";
      job: AnyReservationJob;
    }
  | Exclude<ReserveAndCreateResult, { kind: "created" | "replayed" }>;
type AnyCreateRequest = ImageOptimizeCreateRequestV1 | PdfOptimizeCreateRequestV1;

function uploadResponse(job: AnyReservationJob): AnyCreateResponse {
  const payload = {
    contract: "tool-job@1",
    mode: "upload-required",
    jobId: job.jobId,
    upload: {
      kind: "worker-stream-put",
      method: "PUT",
      path: `/v1/jobs/${job.jobId}/input`,
      contentType: job.declaredMime,
      byteLength: job.declaredBytes,
      expiresAt: new Date(job.uploadExpiresAt).toISOString(),
    },
    reservedWeightedUnits: job.reservedWeightedUnits,
  };
  return job.contractId === "pdf.optimize@1"
    ? (payload as PdfOptimizeCreateResponse)
    : (payload as ImageOptimizeCreateResponse);
}

function existingJobResponse(job: AnyReservationJob): AnyCreateResponse {
  if (job.status === "created" || job.status === "uploading") {
    throw new TypeError("An existing-job response requires a queued or terminal job.");
  }
  return {
    contract: "tool-job@1",
    mode: "existing-job",
    jobId: job.jobId,
    state: job.status,
    reservedWeightedUnits: job.reservedWeightedUnits,
  };
}

function successfulCreateResponse(
  result: Extract<AnyReserveResult, { kind: "created" | "replayed" }>,
): Response {
  const payload =
    result.mode === "upload-required"
      ? uploadResponse(result.job)
      : existingJobResponse(result.job);
  return Response.json(payload, {
    status: result.kind === "created" ? 201 : 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function deniedReservationResponse(
  result: Exclude<AnyReserveResult, { kind: "created" | "replayed" | "job-id-collision" }>,
): Response {
  switch (result.kind) {
    case "idempotency-conflict":
      return toolErrorResponse(
        409,
        "INVALID_REQUEST",
        "같은 요청 ID에 다른 작업 내용이 사용되었습니다.",
        false,
      );
    case "queue-unavailable":
      return toolErrorResponse(
        503,
        "QUEUE_UNAVAILABLE",
        "처리 대기열을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        true,
      );
    case "server-processing-disabled":
      return processingDisabledResponse("SERVER_PROCESSING_DISABLED");
    case "quota-exceeded":
    case "active-job-exists":
    case "pending-limit-exceeded":
      return quotaResponse();
  }
}

function serverCohortAllowed(input: {
  rolloutPercent: number;
  maintainer: boolean;
  rolloutBucket: number;
  toolContract?: AnyCreateRequest["toolContract"];
  pdfPublicAdmissionEnabled: boolean;
}): boolean {
  return input.toolContract === "pdf.optimize@1"
    ? input.maintainer ||
        (input.pdfPublicAdmissionEnabled && input.rolloutBucket < input.rolloutPercent)
    : input.maintainer || input.rolloutBucket < input.rolloutPercent;
}

function globalProcessingEnabled(config: CreateConfig): boolean {
  return (
    config.accountDailyWeightedUnitLimit > 0 &&
    config.anonymousDailyWeightedUnitLimit > 0 &&
    config.networkDailyWeightedUnitLimit > 0
  );
}

function createReservationInput(input: {
  request: AnyCreateRequest;
  runtime: CreateJobRouteRuntime;
  now: number;
  dayKey: string;
  tokenHash: string;
  sessionHash: string;
  networkBuckets: Awaited<ReturnType<typeof hashNetworkBuckets>>;
  specJson: string;
  specHash: string;
}): AnyReserveAndCreateInput {
  const jobId = input.runtime.randomUuid();
  const common = {
    jobId,
    clientRequestId: input.request.clientRequestId,
    tokenHash: input.tokenHash,
    sessionHash: input.sessionHash,
    networkHash: input.networkBuckets.writeHash,
    networkDailyQuotaHashes: input.networkBuckets.dailyQuotaHashes,
    networkPendingHashes: input.networkBuckets.pendingHashes,
    dayKey: input.dayKey,
    specJson: input.specJson,
    specHash: input.specHash,
    inputKey: createOpaqueObjectKey("inputs", input.runtime.randomUuid()),
    outputKey: createOpaqueObjectKey("outputs", input.runtime.randomUuid()),
    queueEpoch: input.runtime.randomUuid(),
    uploadExpiresAt: input.now + UPLOAD_DEADLINE_MILLISECONDS,
    now: input.now,
    accountDailyLimit: input.runtime.config.accountDailyWeightedUnitLimit,
    anonymousDailyLimit: input.runtime.config.anonymousDailyWeightedUnitLimit,
    networkDailyLimit: input.runtime.config.networkDailyWeightedUnitLimit,
    accountPendingJobLimit: input.runtime.config.accountPendingJobLimit,
    networkPendingJobLimit: input.runtime.config.networkPendingJobLimit,
    maximumQueuedAgeSeconds: input.runtime.config.maximumQueuedAgeSeconds,
  };
  return input.request.toolContract === "pdf.optimize@1"
    ? {
        ...common,
        request: input.request,
        estimate: estimateResources(input.request) as Extract<
          ReturnType<typeof estimateResources>,
          { resourceClass: "pdf-standard-v1" }
        >,
      }
    : {
        ...common,
        request: input.request,
        estimate: estimateResources(input.request) as Extract<
          ReturnType<typeof estimateResources>,
          { resourceClass: "image-standard-v1" }
        >,
      };
}

export async function routeCreateJobRequest(
  request: Request,
  runtime: CreateJobRouteRuntime,
): Promise<Response> {
  const nowDate = runtime.now();
  const now = nowDate.valueOf();
  const dayKey = utcDay(nowDate);
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp === null) {
    return processingDisabledResponse("SERVER_PROCESSING_DISABLED");
  }

  let networkBuckets: Awaited<ReturnType<typeof hashNetworkBuckets>>;
  try {
    networkBuckets = await hashNetworkBuckets({
      ip: connectingIp,
      utcDay: dayKey,
      currentSecret: runtime.currentSecret,
      previousSecret: runtime.previousSecret,
    });
  } catch {
    return processingDisabledResponse("SERVER_PROCESSING_DISABLED");
  }

  try {
    if (!(await runtime.networkRateLimiter.limit({ key: networkBuckets.writeHash })).success) {
      return rateLimitedResponse("network");
    }
  } catch {
    return processingDisabledResponse("SERVER_PROCESSING_DISABLED");
  }

  let requestBody: unknown;
  try {
    requestBody = await runtime.readJson(request, MAXIMUM_CREATE_BODY_BYTES);
  } catch {
    return toolErrorResponse(400, "INVALID_REQUEST", "요청 본문을 확인해 주세요.", false);
  }
  const parsed =
    requestBody !== null &&
    typeof requestBody === "object" &&
    "toolContract" in requestBody &&
    requestBody.toolContract === "pdf.optimize@1"
      ? pdfOptimizeCreateRequestSchema.safeParse(requestBody)
      : imageOptimizeCreateRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return toolErrorResponse(400, "INVALID_REQUEST", "요청 형식이 올바르지 않습니다.", false);
  }

  const [sessionHash, rolloutBucket, tokenHash] = await Promise.all([
    hashAnonymousSessionId(parsed.data.anonymousSessionId),
    sessionRolloutBucket(parsed.data.anonymousSessionId),
    hashJobToken(parsed.data.jobToken),
  ]);
  try {
    if (!(await runtime.sessionRateLimiter.limit({ key: sessionHash })).success) {
      return rateLimitedResponse("session");
    }
  } catch {
    return processingDisabledResponse("SERVER_PROCESSING_DISABLED");
  }

  if (!globalProcessingEnabled(runtime.config)) {
    return processingDisabledResponse("SERVER_PROCESSING_DISABLED");
  }
  const maintainer = runtime.config.maintainerSessionHashes.has(sessionHash);
  if (
    !serverCohortAllowed({
      rolloutPercent: runtime.config.rolloutPercent,
      maintainer,
      rolloutBucket,
      toolContract: parsed.data.toolContract,
      pdfPublicAdmissionEnabled: runtime.config.pdfPublicAdmissionEnabled,
    })
  ) {
    return processingDisabledResponse("LOCAL_FALLBACK_REQUIRED");
  }

  const specJson = JSON.stringify(parsed.data.spec);
  const specHash = await sha256Hex(specJson);
  for (let attempt = 0; attempt < MAXIMUM_JOB_ID_ATTEMPTS; attempt += 1) {
    const reservation = createReservationInput({
      request: parsed.data,
      runtime,
      now,
      dayKey,
      tokenHash,
      sessionHash,
      networkBuckets,
      specJson,
      specHash,
    });
    let result: AnyReserveResult;
    try {
      result = await runtime.repository.reserveAndCreate(reservation);
    } catch {
      return toolErrorResponse(
        503,
        "STORAGE_FAILURE",
        "작업을 만들 수 없습니다. 잠시 후 다시 시도해 주세요.",
        true,
      );
    }

    if (result.kind === "job-id-collision") {
      continue;
    }
    if (result.kind !== "created" && result.kind !== "replayed") {
      return deniedReservationResponse(result);
    }
    if (result.kind === "created") {
      try {
        runtime.logCreated({
          jobId: result.job.jobId,
          contractId: result.job.contractId,
          byteCount: result.job.declaredBytes,
          ...(result.job.contractId === "pdf.optimize@1"
            ? { pageCount: result.job.declaredPageCount }
            : { pixelCount: result.job.declaredWidth * result.job.declaredHeight }),
          resourceClass: result.job.resourceClass,
          reservedWeightedUnits: result.job.reservedWeightedUnits,
        });
      } catch {
        // A privacy-safe telemetry sink must not invalidate an accepted D1 reservation.
      }
    }
    return successfulCreateResponse(result);
  }

  return toolErrorResponse(
    503,
    "STORAGE_FAILURE",
    "작업을 만들 수 없습니다. 잠시 후 다시 시도해 주세요.",
    true,
  );
}

export { routeJobCancelRequest, routeJobStatusRequest } from "./results";
