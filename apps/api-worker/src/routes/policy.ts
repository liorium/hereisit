import { decideAdmission } from "@hereisit/server-job";
import {
  type ImageOptimizePolicyResponseV1,
  imageOptimizePolicyRequestSchema,
} from "@hereisit/tool-contracts/image-optimize";
import { imageCompressionProcessingManifest } from "@hereisit/tool-registry/processing";
import { hashAnonymousSessionId, hashNetworkBuckets, sessionRolloutBucket } from "../auth";
import { readBoundedJson } from "../bounded-json";

const MAXIMUM_POLICY_BODY_BYTES = 16_384;
const INVALID_NETWORK_LIMITER_KEY = "invalid-network-secret";
const POLICY_RETRY_AFTER_SECONDS = 60;

export interface PolicyDecisionConfig {
  rolloutPercent: number;
  accountDailyWeightedUnitLimit: number;
  anonymousDailyWeightedUnitLimit: number;
  networkDailyWeightedUnitLimit: number;
  accountPendingJobLimit?: number;
  networkPendingJobLimit?: number;
  maximumQueuedAgeSeconds?: number;
  maintainerSessionHashes?: ReadonlySet<string>;
}

export interface PolicyRouterConfig extends PolicyDecisionConfig {
  appOrigins: readonly URL[];
  accountPendingJobLimit: number;
  networkPendingJobLimit: number;
  maximumQueuedAgeSeconds: number;
  maintainerSessionHashes: ReadonlySet<string>;
}

export interface PolicyUsageState {
  circuitClosed: boolean;
  accountReservedToday: number;
  accountSettledToday: number;
  accountPendingJobs: number;
  anonymousReservedToday: number;
  anonymousSettledToday: number;
  activeJobs: number;
  networkReservedToday: number;
  networkSettledToday: number;
  networkPendingJobs: number;
  oldestQueuedAgeSeconds: number;
}

export interface PolicyStateQuery {
  utcDay: string;
  nowEpochMilliseconds: number;
  sessionHash: string;
  dailyQuotaHashes: readonly string[];
  pendingHashes: readonly string[];
}

export interface PolicyRouteRuntime {
  config: PolicyRouterConfig;
  currentSecret: string;
  previousSecret: string;
  policyRateLimiter: Pick<RateLimit, "limit">;
  readState: (query: PolicyStateQuery) => Promise<PolicyUsageState>;
  readJson: (request: Request, maximumBytes?: number) => Promise<unknown>;
  now: () => Date;
  timeoutMilliseconds: number;
}

interface PolicyAggregateRow {
  circuit_open: number;
  account_reserved: number;
  account_settled: number;
  account_pending: number;
  anonymous_reserved: number;
  anonymous_settled: number;
  anonymous_active: number;
  network_reserved: number;
  network_settled: number;
  network_pending: number;
  oldest_queued_at: number | null;
}

const publicLimits = Object.freeze({
  maxFiles: imageCompressionProcessingManifest.limits.maxFiles,
  maxBytesPerFile: imageCompressionProcessingManifest.limits.maxBytesPerFile,
  maxPixelsPerFile: imageCompressionProcessingManifest.limits.maxPixelsPerFile,
});

function normalizedConfig(config: PolicyDecisionConfig): Required<PolicyDecisionConfig> {
  return {
    ...config,
    accountPendingJobLimit: config.accountPendingJobLimit ?? Number.MAX_SAFE_INTEGER,
    networkPendingJobLimit: config.networkPendingJobLimit ?? Number.MAX_SAFE_INTEGER,
    maximumQueuedAgeSeconds: config.maximumQueuedAgeSeconds ?? Number.MAX_SAFE_INTEGER,
    maintainerSessionHashes: config.maintainerSessionHashes ?? new Set<string>(),
  };
}

function localReason(
  config: PolicyDecisionConfig,
  circuitClosed: boolean,
): "SERVER_PROCESSING_DISABLED" | "LOCAL_FALLBACK_REQUIRED" {
  return config.accountDailyWeightedUnitLimit <= 0 ||
    config.anonymousDailyWeightedUnitLimit <= 0 ||
    config.networkDailyWeightedUnitLimit <= 0 ||
    !circuitClosed
    ? "SERVER_PROCESSING_DISABLED"
    : "LOCAL_FALLBACK_REQUIRED";
}

function makePolicyPayload(input: {
  config: PolicyDecisionConfig;
  state: PolicyUsageState;
  sessionHash: string | null;
  rolloutBucket: number | null;
}): ImageOptimizePolicyResponseV1 {
  const config = normalizedConfig(input.config);
  const maintainer =
    input.sessionHash !== null && config.maintainerSessionHashes.has(input.sessionHash);
  let admissionAllowed = false;
  if (input.state.circuitClosed) {
    try {
      admissionAllowed = decideAdmission({
        accountDailyLimit: config.accountDailyWeightedUnitLimit,
        accountReservedToday: input.state.accountReservedToday,
        accountSettledToday: input.state.accountSettledToday,
        anonymousDailyLimit: config.anonymousDailyWeightedUnitLimit,
        anonymousReservedToday: input.state.anonymousReservedToday,
        anonymousSettledToday: input.state.anonymousSettledToday,
        networkDailyLimit: config.networkDailyWeightedUnitLimit,
        networkReservedToday: input.state.networkReservedToday,
        networkSettledToday: input.state.networkSettledToday,
        requestedUnits: 1,
        activeJobs: input.state.activeJobs,
        networkPendingJobs: input.state.networkPendingJobs,
        networkPendingJobLimit: config.networkPendingJobLimit,
        accountPendingJobs: input.state.accountPendingJobs,
        accountPendingJobLimit: config.accountPendingJobLimit,
        oldestQueuedAgeSeconds: input.state.oldestQueuedAgeSeconds,
        maximumQueuedAgeSeconds: config.maximumQueuedAgeSeconds,
      }).allowed;
    } catch {
      admissionAllowed = false;
    }
  }

  const inRollout =
    input.rolloutBucket !== null && (maintainer || input.rolloutBucket < config.rolloutPercent);
  const execution = admissionAllowed && inRollout ? "server" : "local";
  if (execution === "server") {
    return {
      contract: "tool-job@1",
      toolContract: "image.optimize@1",
      maintainer,
      execution,
      reason: null,
      disclosure: {
        upload: true,
        inputDeletion: "terminal",
        resultDeletion: {
          mode: "server-temporary",
          acknowledged: "immediate-delete-attempt",
          unacknowledgedDueSeconds: 1800,
          applicationSloSeconds: 2100,
          lifecycleExpirationDays: 1,
          exceptionalDelayPossible: true,
        },
      },
      limits: publicLimits,
    };
  }

  return {
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    maintainer,
    execution,
    reason: localReason(config, input.state.circuitClosed),
    disclosure: {
      upload: false,
      inputDeletion: "not-uploaded",
      resultDeletion: { mode: "not-uploaded" },
    },
    limits: publicLimits,
  };
}

function unavailableState(circuitClosed = true): PolicyUsageState {
  return {
    circuitClosed,
    accountReservedToday: 0,
    accountSettledToday: 0,
    accountPendingJobs: 0,
    anonymousReservedToday: 0,
    anonymousSettledToday: 0,
    activeJobs: 0,
    networkReservedToday: 0,
    networkSettledToday: 0,
    networkPendingJobs: 0,
    oldestQueuedAgeSeconds: 0,
  };
}

function localPolicyResponse(
  config: PolicyDecisionConfig,
  options?: {
    status?: number;
    retryAfterSeconds?: number;
    circuitClosed?: boolean;
  },
): Response {
  const payload = makePolicyPayload({
    config,
    state: unavailableState(options?.circuitClosed ?? true),
    sessionHash: null,
    rolloutBucket: null,
  });
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (options?.retryAfterSeconds !== undefined) {
    headers.set("retry-after", `${options.retryAfterSeconds}`);
  }
  return Response.json(payload, {
    status: options?.status ?? 200,
    headers,
  });
}

function localPolicyResponseForSession(
  config: PolicyDecisionConfig,
  sessionHash: string,
): Response {
  return Response.json(
    makePolicyPayload({
      config,
      state: unavailableState(),
      sessionHash,
      rolloutBucket: null,
    }),
  );
}

export async function getPolicy(request: Request, config: PolicyDecisionConfig): Promise<Response> {
  let parsedBody: unknown;
  try {
    parsedBody = await readBoundedJson(request, MAXIMUM_POLICY_BODY_BYTES);
  } catch {
    return localPolicyResponse(config);
  }
  const parsedRequest = imageOptimizePolicyRequestSchema.safeParse(parsedBody);
  if (!parsedRequest.success) {
    return localPolicyResponse(config);
  }
  const [sessionHash, rolloutBucket] = await Promise.all([
    hashAnonymousSessionId(parsedRequest.data.anonymousSessionId),
    sessionRolloutBucket(parsedRequest.data.anonymousSessionId),
  ]);
  return Response.json(
    makePolicyPayload({
      config,
      state: unavailableState(),
      sessionHash,
      rolloutBucket,
    }),
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new RangeError("Policy timeout must be a positive safe integer.");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Policy state read timed out.")),
      timeoutMilliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function routePolicyRequest(
  request: Request,
  runtime: PolicyRouteRuntime,
): Promise<Response> {
  const now = runtime.now();
  const utcDay = now.toISOString().slice(0, 10);
  let networkHashes: Awaited<ReturnType<typeof hashNetworkBuckets>> | null = null;
  let limiterKey = INVALID_NETWORK_LIMITER_KEY;
  try {
    const ip = request.headers.get("cf-connecting-ip");
    if (ip === null) {
      throw new TypeError("Network address is required.");
    }
    networkHashes = await hashNetworkBuckets({
      ip,
      utcDay,
      currentSecret: runtime.currentSecret,
      previousSecret: runtime.previousSecret,
    });
    limiterKey = networkHashes.writeHash;
  } catch {
    networkHashes = null;
  }

  let limiterAllowed = false;
  try {
    // Cloudflare rate-limit bindings are location-local and eventually consistent.
    // This awaited call is a best-effort pre-body edge fence; D1 admission remains authoritative.
    limiterAllowed = (await runtime.policyRateLimiter.limit({ key: limiterKey })).success;
  } catch {
    return localPolicyResponse(runtime.config);
  }
  if (!limiterAllowed) {
    return localPolicyResponse(runtime.config, {
      status: 429,
      retryAfterSeconds: POLICY_RETRY_AFTER_SECONDS,
    });
  }
  if (networkHashes === null) {
    return localPolicyResponse(runtime.config);
  }

  let parsedBody: unknown;
  try {
    parsedBody = await runtime.readJson(request, MAXIMUM_POLICY_BODY_BYTES);
  } catch {
    return localPolicyResponse(runtime.config);
  }
  const parsedRequest = imageOptimizePolicyRequestSchema.safeParse(parsedBody);
  if (!parsedRequest.success) {
    return localPolicyResponse(runtime.config);
  }

  const [sessionHash, rolloutBucket] = await Promise.all([
    hashAnonymousSessionId(parsedRequest.data.anonymousSessionId),
    sessionRolloutBucket(parsedRequest.data.anonymousSessionId),
  ]);
  let state: PolicyUsageState;
  try {
    state = await withTimeout(
      runtime.readState({
        utcDay,
        nowEpochMilliseconds: now.valueOf(),
        sessionHash,
        dailyQuotaHashes: networkHashes.dailyQuotaHashes,
        pendingHashes: networkHashes.pendingHashes,
      }),
      runtime.timeoutMilliseconds,
    );
  } catch {
    return localPolicyResponseForSession(runtime.config, sessionHash);
  }

  return Response.json(
    makePolicyPayload({
      config: runtime.config,
      state,
      sessionHash,
      rolloutBucket,
    }),
  );
}

function placeholders(values: readonly string[], label: string, maximum: number): string {
  if (
    values.length < 1 ||
    values.length > maximum ||
    values.some((value) => !/^[0-9a-f]{64}$/.test(value))
  ) {
    throw new TypeError(`${label} must contain bounded canonical SHA-256 hashes.`);
  }
  return values.map(() => "?").join(", ");
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export async function readPolicyStateFromD1(
  database: D1Database,
  query: PolicyStateQuery,
): Promise<PolicyUsageState> {
  const dailyPlaceholders = placeholders(query.dailyQuotaHashes, "Daily quota hashes", 2);
  const pendingPlaceholders = placeholders(query.pendingHashes, "Pending hashes", 4);
  const statement = database
    .withSession("first-primary")
    .prepare(
      `SELECT
        COALESCE((SELECT circuit_open FROM rollout_control WHERE id = 1), 1) AS circuit_open,
        COALESCE((SELECT reserved_units FROM account_usage WHERE day_key = ?), 0) AS account_reserved,
        COALESCE((SELECT settled_units FROM account_usage WHERE day_key = ?), 0) AS account_settled,
        COALESCE((SELECT SUM(pending_jobs) FROM account_usage), 0) AS account_pending,
        COALESCE((
          SELECT reserved_units FROM anonymous_usage WHERE session_hash = ? AND day_key = ?
        ), 0) AS anonymous_reserved,
        COALESCE((
          SELECT settled_units FROM anonymous_usage WHERE session_hash = ? AND day_key = ?
        ), 0) AS anonymous_settled,
        COALESCE((
          SELECT SUM(active_jobs) FROM anonymous_usage WHERE session_hash = ?
        ), 0) AS anonymous_active,
        COALESCE((
          SELECT SUM(reserved_units) FROM network_usage
          WHERE day_key = ? AND network_hash IN (${dailyPlaceholders})
        ), 0) AS network_reserved,
        COALESCE((
          SELECT SUM(settled_units) FROM network_usage
          WHERE day_key = ? AND network_hash IN (${dailyPlaceholders})
        ), 0) AS network_settled,
        COALESCE((
          SELECT SUM(pending_jobs) FROM network_usage
          WHERE network_hash IN (${pendingPlaceholders})
        ), 0) AS network_pending,
        (SELECT MIN(queued_at) FROM jobs WHERE status = 'queued' AND queued_at IS NOT NULL)
          AS oldest_queued_at`,
    )
    .bind(
      query.utcDay,
      query.utcDay,
      query.sessionHash,
      query.utcDay,
      query.sessionHash,
      query.utcDay,
      query.sessionHash,
      query.utcDay,
      ...query.dailyQuotaHashes,
      query.utcDay,
      ...query.dailyQuotaHashes,
      ...query.pendingHashes,
    );
  const row = await statement.first<PolicyAggregateRow>();
  if (row === null) {
    throw new Error("Policy state query returned no row.");
  }
  const oldestQueuedAt =
    row.oldest_queued_at === null
      ? null
      : nonnegativeSafeInteger(row.oldest_queued_at, "oldest queued timestamp");
  const nowEpochMilliseconds = nonnegativeSafeInteger(
    query.nowEpochMilliseconds,
    "current timestamp",
  );
  if (oldestQueuedAt !== null && oldestQueuedAt > nowEpochMilliseconds) {
    throw new RangeError("Oldest queued timestamp cannot be in the future.");
  }

  return {
    circuitClosed: row.circuit_open === 0,
    accountReservedToday: nonnegativeSafeInteger(row.account_reserved, "account reserved units"),
    accountSettledToday: nonnegativeSafeInteger(row.account_settled, "account settled units"),
    accountPendingJobs: nonnegativeSafeInteger(row.account_pending, "account pending jobs"),
    anonymousReservedToday: nonnegativeSafeInteger(
      row.anonymous_reserved,
      "anonymous reserved units",
    ),
    anonymousSettledToday: nonnegativeSafeInteger(row.anonymous_settled, "anonymous settled units"),
    activeJobs: nonnegativeSafeInteger(row.anonymous_active, "anonymous active jobs"),
    networkReservedToday: nonnegativeSafeInteger(row.network_reserved, "network reserved units"),
    networkSettledToday: nonnegativeSafeInteger(row.network_settled, "network settled units"),
    networkPendingJobs: nonnegativeSafeInteger(row.network_pending, "network pending jobs"),
    oldestQueuedAgeSeconds:
      oldestQueuedAt === null ? 0 : Math.floor((nowEpochMilliseconds - oldestQueuedAt) / 1_000),
  };
}
