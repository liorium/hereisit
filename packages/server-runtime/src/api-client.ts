import {
  IMAGE_OPTIMIZE_CONTRACT_ID,
  type ImageOptimizeCreateRequestV1,
  type ImageOptimizeCreateResponse,
  type ImageOptimizePolicyResponseV1,
  type ImageOptimizeStatusResponseV1,
  imageOptimizeCreateRequestSchema,
  imageOptimizeCreateResponseSchema,
  imageOptimizePolicyRequestSchema,
  imageOptimizePolicyResponseSchema,
  imageOptimizeStatusResponseSchema,
} from "@hereisit/tool-contracts/image-optimize";
import {
  TOOL_JOB_CONTRACT_ID,
  type ToolJobErrorCode,
  type ToolJobErrorPayload,
  toolJobErrorResponseSchema,
} from "@hereisit/tool-contracts/tool-job";

const POLICY_TIMEOUT_MILLISECONDS = 2_000;
const MUTATION_TIMEOUT_MILLISECONDS = 10_000;
const POLICY_CACHE_MILLISECONDS = 5_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ClientJobCredentials {
  readonly clientRequestId: string;
  readonly jobToken: string;
}

export interface FetchOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export class RemoteJobError extends Error implements ToolJobErrorPayload {
  readonly code: ToolJobErrorCode;
  readonly retryable: boolean;
  readonly guidance?: "TRY_BALANCED_PRESET";
  readonly retryAfterSeconds?: number;

  constructor(
    code: ToolJobErrorCode,
    message: string,
    retryable: boolean,
    options: {
      readonly guidance?: "TRY_BALANCED_PRESET";
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "RemoteJobError";
    this.code = code;
    this.retryable = retryable;
    if (options.guidance !== undefined) this.guidance = options.guidance;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  toJSON(): ToolJobErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.guidance === undefined ? {} : { guidance: this.guidance }),
    };
  }
}

function randomBase64Url32Bytes(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createClientJobCredentials(): ClientJobCredentials {
  const clientRequestId = crypto.randomUUID();
  const jobToken = randomBase64Url32Bytes();
  if (!UUID_PATTERN.test(clientRequestId) || !TOKEN_PATTERN.test(jobToken)) {
    throw new RemoteJobError("STORAGE_FAILURE", "안전한 작업 인증 정보를 만들 수 없습니다.", true);
  }
  return { clientRequestId, jobToken };
}

export function canonicalApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteJobError("INVALID_REQUEST", "처리 서버 주소가 올바르지 않습니다.", false);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RemoteJobError("INVALID_REQUEST", "처리 서버 주소가 올바르지 않습니다.", false);
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  ) {
    throw new RemoteJobError(
      "INVALID_REQUEST",
      "처리 서버는 안전한 HTTPS 연결이어야 합니다.",
      false,
    );
  }
  return url.origin;
}

function validateJobId(jobId: string): void {
  if (!UUID_PATTERN.test(jobId)) {
    throw new RemoteJobError("INVALID_REQUEST", "작업 식별자가 올바르지 않습니다.", false);
  }
}

function publicAbortError(): RemoteJobError {
  return new RemoteJobError("CANCELLED", "작업이 취소되었습니다.", false);
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

async function errorFromResponse(response: Response): Promise<RemoteJobError> {
  try {
    const parsed = toolJobErrorResponseSchema.parse(await response.json());
    const retryAfterSeconds = parseRetryAfter(response);
    return new RemoteJobError(parsed.error.code, parsed.error.message, parsed.error.retryable, {
      ...(parsed.error.guidance === undefined ? {} : { guidance: parsed.error.guidance }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  } catch {
    return new RemoteJobError("INVALID_REQUEST", "처리 서버의 응답이 올바르지 않습니다.", false);
  }
}

function timeoutSignal(
  parent: AbortSignal | undefined,
  milliseconds: number,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  readonly timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, milliseconds);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function requestJson<T>(input: {
  readonly apiOrigin: string;
  readonly path: string;
  readonly init: RequestInit;
  readonly schema: { parse(value: unknown): T };
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds: number;
}): Promise<T> {
  if (input.signal?.aborted) throw publicAbortError();
  const origin = canonicalApiOrigin(input.apiOrigin);
  const timed = timeoutSignal(input.signal, input.timeoutMilliseconds);
  try {
    const response = await (input.fetch ?? globalThis.fetch)(`${origin}${input.path}`, {
      ...input.init,
      cache: "no-store",
      credentials: "omit",
      signal: timed.signal,
    });
    if (!response.ok) throw await errorFromResponse(response);
    try {
      return input.schema.parse(await response.json());
    } catch {
      throw new RemoteJobError("INVALID_REQUEST", "처리 서버의 응답이 올바르지 않습니다.", false);
    }
  } catch (error) {
    if (error instanceof RemoteJobError) throw error;
    if (input.signal?.aborted) throw publicAbortError();
    if (timed.timedOut()) {
      throw new RemoteJobError("STORAGE_FAILURE", "처리 서버 응답 시간이 초과되었습니다.", true);
    }
    throw new RemoteJobError("STORAGE_FAILURE", "처리 서버에 연결할 수 없습니다.", true);
  } finally {
    timed.dispose();
  }
}

interface PolicyCacheEntry {
  readonly expiresAt: number;
  readonly value: ImageOptimizePolicyResponseV1;
}

const policyCache = new Map<string, PolicyCacheEntry>();
const policyRequests = new Map<string, Promise<ImageOptimizePolicyResponseV1>>();

export async function getProcessingPolicy(input: {
  readonly apiOrigin: string;
  readonly anonymousSessionId: string;
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}): Promise<ImageOptimizePolicyResponseV1> {
  const origin = canonicalApiOrigin(input.apiOrigin);
  const policyRequest = imageOptimizePolicyRequestSchema.safeParse({
    contract: TOOL_JOB_CONTRACT_ID,
    toolContract: IMAGE_OPTIMIZE_CONTRACT_ID,
    anonymousSessionId: input.anonymousSessionId,
  });
  if (!policyRequest.success) {
    throw new RemoteJobError("INVALID_REQUEST", "익명 세션 정보가 올바르지 않습니다.", false);
  }
  const cacheKey = `${origin}\n${input.anonymousSessionId}`;
  const now = Date.now();
  if (!input.forceRefresh) {
    const cached = policyCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
  }
  const pending = policyRequests.get(cacheKey);
  if (pending !== undefined) return pending;
  const request = requestJson({
    apiOrigin: origin,
    path: "/v1/policy",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policyRequest.data),
    },
    schema: imageOptimizePolicyResponseSchema,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMilliseconds: POLICY_TIMEOUT_MILLISECONDS,
  }).then((value) => {
    const entry = { value, expiresAt: Date.now() + POLICY_CACHE_MILLISECONDS };
    policyCache.set(cacheKey, entry);
    setTimeout(() => {
      if (policyCache.get(cacheKey) === entry) policyCache.delete(cacheKey);
    }, POLICY_CACHE_MILLISECONDS);
    return value;
  });
  policyRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (policyRequests.get(cacheKey) === request) policyRequests.delete(cacheKey);
  }
}

export async function createImageOptimizeJob(
  request: ImageOptimizeCreateRequestV1,
  options: { readonly apiOrigin: string } & FetchOptions,
): Promise<ImageOptimizeCreateResponse> {
  const parsedRequest = imageOptimizeCreateRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new RemoteJobError("INVALID_REQUEST", "이미지 처리 요청이 올바르지 않습니다.", false);
  }
  const body = JSON.stringify(parsedRequest.data);
  const perform = () =>
    requestJson({
      apiOrigin: options.apiOrigin,
      path: "/v1/jobs",
      init: { method: "POST", headers: { "content-type": "application/json" }, body },
      schema: imageOptimizeCreateResponseSchema,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMilliseconds: MUTATION_TIMEOUT_MILLISECONDS,
    });
  try {
    return await perform();
  } catch (error) {
    if (
      !(error instanceof RemoteJobError) ||
      !error.retryable ||
      error.code !== "STORAGE_FAILURE" ||
      options.signal?.aborted
    ) {
      throw error;
    }
    return perform();
  }
}

function authenticatedHeaders(jobToken: string): HeadersInit {
  if (!TOKEN_PATTERN.test(jobToken)) {
    throw new RemoteJobError("INVALID_REQUEST", "작업 인증 정보가 올바르지 않습니다.", false);
  }
  return { authorization: `Bearer ${jobToken}` };
}

export async function getImageOptimizeStatus(input: {
  readonly apiOrigin: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<ImageOptimizeStatusResponseV1> {
  validateJobId(input.jobId);
  return await requestJson({
    apiOrigin: input.apiOrigin,
    path: `/v1/jobs/${input.jobId}`,
    init: { method: "GET", headers: authenticatedHeaders(input.jobToken) },
    schema: imageOptimizeStatusResponseSchema,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMilliseconds: MUTATION_TIMEOUT_MILLISECONDS,
  });
}

async function authenticatedMutation(input: {
  readonly apiOrigin: string;
  readonly path: string;
  readonly method: "POST" | "DELETE";
  readonly jobToken: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}): Promise<Response> {
  const match = /^\/v1\/jobs\/([^/]+)(?:\/(?:cancel|downloaded))?$/.exec(input.path);
  if (match?.[1] === undefined) {
    throw new RemoteJobError("INVALID_REQUEST", "작업 경로가 올바르지 않습니다.", false);
  }
  validateJobId(match[1]);
  if (input.signal?.aborted) throw publicAbortError();
  const timed = timeoutSignal(input.signal, MUTATION_TIMEOUT_MILLISECONDS);
  try {
    const headers = new Headers(authenticatedHeaders(input.jobToken));
    for (const [name, value] of new Headers(input.headers)) headers.set(name, value);
    const response = await (input.fetch ?? globalThis.fetch)(
      `${canonicalApiOrigin(input.apiOrigin)}${input.path}`,
      {
        method: input.method,
        headers,
        cache: "no-store",
        credentials: "omit",
        signal: timed.signal,
      },
    );
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  } catch (error) {
    if (error instanceof RemoteJobError) throw error;
    if (input.signal?.aborted) throw publicAbortError();
    throw new RemoteJobError("STORAGE_FAILURE", "처리 서버에 연결할 수 없습니다.", true);
  } finally {
    timed.dispose();
  }
}

export async function cancelRemoteJob(input: {
  readonly apiOrigin: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await authenticatedMutation({ ...input, path: `/v1/jobs/${input.jobId}/cancel`, method: "POST" });
}

export async function deleteRemoteJob(input: {
  readonly apiOrigin: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await authenticatedMutation({ ...input, path: `/v1/jobs/${input.jobId}`, method: "DELETE" });
}

export async function acknowledgeRemoteDownload(input: {
  readonly apiOrigin: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly downloadLease: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (!TOKEN_PATTERN.test(input.downloadLease)) {
    throw new RemoteJobError("INVALID_REQUEST", "다운로드 확인 정보가 올바르지 않습니다.", false);
  }
  await authenticatedMutation({
    ...input,
    path: `/v1/jobs/${input.jobId}/downloaded`,
    method: "POST",
    headers: { "x-download-lease": input.downloadLease },
  });
}
