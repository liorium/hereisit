import { z } from "zod";

export type Env = Cloudflare.Env & {
  readonly ABUSE_HMAC_SECRET_CURRENT: string;
  readonly ABUSE_HMAC_SECRET_PREVIOUS: string;
  readonly ANALYTICS_READ_TOKEN: string;
  readonly LOGPUSH_STATUS_TOKEN: string;
  readonly PRODUCT_ANALYTICS: AnalyticsEngineDataset;
  readonly PRODUCT_ANALYTICS_RATE_LIMITER: RateLimit;
};

export interface LiveCostModelV1 {
  version: 1;
  containerVcpuSecondMicrousd: number;
  containerGibSecondMicrousd: number;
  containerDiskGbSecondMicrousd: number;
  containerEgressGbMicrousd: number;
  containerEgressRegionPricesMicrousd: Readonly<Record<string, number>>;
  containerEgressRegionPricesSha256: string;
  containerInstanceVcpu: number;
  containerInstanceMemoryGib: number;
  containerInstanceDiskGb: number;
  containerSleepAfterSeconds: 60;
  workersMillionRequestsMicrousd: number;
  workersMillionCpuMsMicrousd: number;
  durableObjectMillionRequestsMicrousd: number;
  durableObjectGibSecondMicrousd: number;
  durableObjectStorageGbMonthMicrousd: number;
  r2StorageGbMonthMicrousd: number;
  r2ClassAMillionMicrousd: number;
  r2ClassBMillionMicrousd: number;
  queueMillionOperationsMicrousd: number;
  d1MillionRowsReadMicrousd: number;
  d1MillionRowsWrittenMicrousd: number;
  d1StorageGbMonthMicrousd: number;
  observabilityMillionLogEventsMicrousd: number;
  workersLogpushMillionEventsMicrousd: number;
  analyticsEngineMillionDataPointsMicrousd: number;
  analyticsEngineMillionReadQueriesMicrousd: number;
  monthlyFixedMicrousd: number;
  projectedMonthlyJobs: number;
  routeCpuBenchmarkSha256: string;
  routeCpuEnvelopeMs: {
    policy: number;
    create: number;
    upload: number;
    read: number;
    result: number;
    maintenance: number;
    queue: number;
  };
  arrivalProjection: {
    algorithm: "arrival-union-tail-v1";
    steadyHourlyJobs: readonly number[];
    burstyHourlyJobs: readonly number[];
    sparseHourlyJobs: readonly number[];
    scenariosSha256: string;
  };
}

export interface OperationalConfig {
  environment: "local" | "staging" | "production";
  appOrigins: readonly URL[];
  accountDailyWeightedUnitLimit: number;
  anonymousDailyWeightedUnitLimit: number;
  networkDailyWeightedUnitLimit: number;
  accountPendingJobLimit: number;
  networkPendingJobLimit: number;
  maximumQueuedAgeSeconds: number;
  maximumLiveMedianOutputRatioBasisPoints: number;
  maximumLiveP95WeightedUnits: number;
  maximumLiveOriginalRetainedRateBasisPoints: number;
  maximumLiveCostPer1000Microusd: number;
  maximumProjectedMonthlyCostMicrousd: number;
  liveCostModel: LiveCostModelV1;
  liveCostModelSha256: string;
  providerUsageSchemaSha256: string;
  releaseReportSha256: string;
  rolloutPercent: number;
  maintainerSessionHashes: ReadonlySet<string>;
  engineInstanceName: "image-slot-0";
  engineImageDigest: string;
}

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hourlyJobCountSchema = z.number().int().min(0).max(1_000_000_000);
const positiveFiniteNumberSchema = z.number().finite().positive();
const nonnegativeFiniteNumberSchema = z.number().finite().min(0);
const regionNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

const routeCpuEnvelopeSchema = z
  .object({
    policy: nonnegativeFiniteNumberSchema,
    create: nonnegativeFiniteNumberSchema,
    upload: nonnegativeFiniteNumberSchema,
    read: nonnegativeFiniteNumberSchema,
    result: nonnegativeFiniteNumberSchema,
    maintenance: nonnegativeFiniteNumberSchema,
    queue: nonnegativeFiniteNumberSchema,
  })
  .strict();

const hourlyProjectionSchema = z.array(hourlyJobCountSchema).length(24).readonly();

const arrivalProjectionSchema = z
  .object({
    algorithm: z.literal("arrival-union-tail-v1"),
    steadyHourlyJobs: hourlyProjectionSchema,
    burstyHourlyJobs: hourlyProjectionSchema,
    sparseHourlyJobs: hourlyProjectionSchema,
    scenariosSha256: sha256HexSchema,
  })
  .strict();

const regionPricesSchema = z
  .record(regionNameSchema, nonnegativeSafeIntegerSchema)
  .refine((prices) => Object.keys(prices).length > 0, {
    message: "At least one container egress region price is required.",
  });

const liveCostModelSchema = z
  .object({
    version: z.literal(1),
    containerVcpuSecondMicrousd: nonnegativeSafeIntegerSchema,
    containerGibSecondMicrousd: nonnegativeSafeIntegerSchema,
    containerDiskGbSecondMicrousd: nonnegativeSafeIntegerSchema,
    containerEgressGbMicrousd: nonnegativeSafeIntegerSchema,
    containerEgressRegionPricesMicrousd: regionPricesSchema,
    containerEgressRegionPricesSha256: sha256HexSchema,
    containerInstanceVcpu: positiveFiniteNumberSchema,
    containerInstanceMemoryGib: positiveFiniteNumberSchema,
    containerInstanceDiskGb: positiveFiniteNumberSchema,
    containerSleepAfterSeconds: z.literal(60),
    workersMillionRequestsMicrousd: nonnegativeSafeIntegerSchema,
    workersMillionCpuMsMicrousd: nonnegativeSafeIntegerSchema,
    durableObjectMillionRequestsMicrousd: nonnegativeSafeIntegerSchema,
    durableObjectGibSecondMicrousd: nonnegativeSafeIntegerSchema,
    durableObjectStorageGbMonthMicrousd: nonnegativeSafeIntegerSchema,
    r2StorageGbMonthMicrousd: nonnegativeSafeIntegerSchema,
    r2ClassAMillionMicrousd: nonnegativeSafeIntegerSchema,
    r2ClassBMillionMicrousd: nonnegativeSafeIntegerSchema,
    queueMillionOperationsMicrousd: nonnegativeSafeIntegerSchema,
    d1MillionRowsReadMicrousd: nonnegativeSafeIntegerSchema,
    d1MillionRowsWrittenMicrousd: nonnegativeSafeIntegerSchema,
    d1StorageGbMonthMicrousd: nonnegativeSafeIntegerSchema,
    observabilityMillionLogEventsMicrousd: nonnegativeSafeIntegerSchema,
    workersLogpushMillionEventsMicrousd: nonnegativeSafeIntegerSchema,
    analyticsEngineMillionDataPointsMicrousd: nonnegativeSafeIntegerSchema,
    analyticsEngineMillionReadQueriesMicrousd: nonnegativeSafeIntegerSchema,
    monthlyFixedMicrousd: nonnegativeSafeIntegerSchema,
    projectedMonthlyJobs: nonnegativeSafeIntegerSchema.min(1),
    routeCpuBenchmarkSha256: sha256HexSchema,
    routeCpuEnvelopeMs: routeCpuEnvelopeSchema,
    arrivalProjection: arrivalProjectionSchema,
  })
  .strict();

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON numbers must be finite.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonValue(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Value is not representable as canonical JSON.");
}

function canonicalJson(value: unknown): string {
  return `${canonicalJsonValue(value)}\n`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${label} must be valid JSON.`);
  }
}

function parseEnvironment(value: string): OperationalConfig["environment"] {
  if (value === "local" || value === "staging" || value === "production") {
    return value;
  }
  throw new TypeError("ENVIRONMENT must be local, staging, or production.");
}

function parseUnsignedInteger(value: string, label: string, options?: { emptyIsZero?: boolean }) {
  if (value === "" && options?.emptyIsZero === true) {
    return 0;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${label} must be a safe integer.`);
  }
  return parsed;
}

function parseRolloutPercent(value: string): number {
  const parsed = parseUnsignedInteger(value, "IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT");
  if (parsed > 100) {
    throw new RangeError("IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT must be between 0 and 100.");
  }
  return parsed;
}

function parseBasisPoints(value: string, label: string): number {
  const parsed = parseUnsignedInteger(value, label);
  if (parsed > 10_000) {
    throw new RangeError(`${label} must be between 0 and 10000 basis points.`);
  }
  return parsed;
}

function parseOrigins(
  value: string,
  environment: OperationalConfig["environment"],
): readonly URL[] {
  const parsed = parseJson(value, "APP_ORIGINS");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError("APP_ORIGINS must be a non-empty JSON array.");
  }

  const seen = new Set<string>();
  return Object.freeze(
    parsed.map((entry) => {
      if (typeof entry !== "string") {
        throw new TypeError("Every APP_ORIGINS entry must be a string.");
      }
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new TypeError("Every APP_ORIGINS entry must be a valid absolute origin.");
      }
      if (
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        entry !== url.origin
      ) {
        throw new TypeError("Every APP_ORIGINS entry must contain only an exact origin.");
      }
      if (environment === "production" && url.protocol !== "https:") {
        throw new TypeError("Production APP_ORIGINS entries must use HTTPS.");
      }
      if (seen.has(url.origin)) {
        throw new TypeError("APP_ORIGINS entries must be unique.");
      }
      seen.add(url.origin);
      return url;
    }),
  );
}

function parseMaintainerHashes(value: string): ReadonlySet<string> {
  const parsed = parseJson(value, "MAINTAINER_SESSION_HASHES");
  if (!Array.isArray(parsed)) {
    throw new TypeError("MAINTAINER_SESSION_HASHES must be a JSON array.");
  }
  const hashes = new Set<string>();
  for (const entry of parsed) {
    const hash = sha256HexSchema.parse(entry);
    if (hashes.has(hash)) {
      throw new TypeError("MAINTAINER_SESSION_HASHES entries must be unique.");
    }
    hashes.add(hash);
  }
  return hashes;
}

function parseNonemptySetting(value: string, label: string): string {
  const containsControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (value.length === 0 || value.trim() !== value || containsControlCharacter) {
    throw new TypeError(`${label} must be a non-empty normalized string.`);
  }
  return value;
}

async function parseLiveCostModel(
  serializedModel: string,
  configuredHash: string,
): Promise<LiveCostModelV1> {
  const model = liveCostModelSchema.parse(parseJson(serializedModel, "LIVE_COST_MODEL_JSON"));
  const canonicalModel = canonicalJson(model);
  if (serializedModel !== canonicalModel) {
    throw new TypeError("LIVE_COST_MODEL_JSON must use deterministic canonical JSON.");
  }

  const expectedModelHash = sha256HexSchema.parse(configuredHash);
  const [actualModelHash, actualRegionHash, actualScenariosHash] = await Promise.all([
    sha256Hex(canonicalModel),
    sha256Hex(canonicalJson(model.containerEgressRegionPricesMicrousd)),
    sha256Hex(
      canonicalJson({
        steady: model.arrivalProjection.steadyHourlyJobs,
        bursty: model.arrivalProjection.burstyHourlyJobs,
        sparse: model.arrivalProjection.sparseHourlyJobs,
      }),
    ),
  ]);

  if (actualModelHash !== expectedModelHash) {
    throw new TypeError("LIVE_COST_MODEL_SHA256 does not match the canonical model SHA-256.");
  }
  if (actualRegionHash !== model.containerEgressRegionPricesSha256) {
    throw new TypeError("Container egress region price hash does not match its canonical map.");
  }
  if (actualScenariosHash !== model.arrivalProjection.scenariosSha256) {
    throw new TypeError("Arrival scenario hash does not match its canonical hourly arrays.");
  }

  return model;
}

export async function parseOperationalConfig(env: Env): Promise<OperationalConfig> {
  const environment = parseEnvironment(env.ENVIRONMENT);
  const rolloutPercent = parseRolloutPercent(env.IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT);
  const maximumLiveCostPer1000Microusd = parseUnsignedInteger(
    env.MAX_LIVE_COST_PER_1000_MICROUSD,
    "MAX_LIVE_COST_PER_1000_MICROUSD",
    { emptyIsZero: true },
  );
  const maximumProjectedMonthlyCostMicrousd = parseUnsignedInteger(
    env.MAX_PROJECTED_MONTHLY_COST_MICROUSD,
    "MAX_PROJECTED_MONTHLY_COST_MICROUSD",
    { emptyIsZero: true },
  );
  if (
    rolloutPercent > 0 &&
    (maximumLiveCostPer1000Microusd <= 0 || maximumProjectedMonthlyCostMicrousd <= 0)
  ) {
    throw new RangeError("A non-zero rollout requires both explicit positive live cost ceilings.");
  }

  const liveCostModel = await parseLiveCostModel(
    env.LIVE_COST_MODEL_JSON,
    env.LIVE_COST_MODEL_SHA256,
  );
  const liveCostModelSha256 = sha256HexSchema.parse(env.LIVE_COST_MODEL_SHA256);
  const providerUsageSchemaSha256 = sha256HexSchema.parse(env.PROVIDER_USAGE_SCHEMA_SHA256);
  const releaseReportSha256 = sha256HexSchema.parse(env.RELEASE_REPORT_SHA256);
  if (env.ENGINE_INSTANCE_NAME !== "image-slot-0") {
    throw new TypeError("ENGINE_INSTANCE_NAME must be image-slot-0.");
  }

  return {
    environment,
    appOrigins: parseOrigins(env.APP_ORIGINS, environment),
    accountDailyWeightedUnitLimit: parseUnsignedInteger(
      env.ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT,
      "ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT",
      { emptyIsZero: true },
    ),
    anonymousDailyWeightedUnitLimit: parseUnsignedInteger(
      env.ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT,
      "ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT",
      { emptyIsZero: true },
    ),
    networkDailyWeightedUnitLimit: parseUnsignedInteger(
      env.NETWORK_DAILY_WEIGHTED_UNIT_LIMIT,
      "NETWORK_DAILY_WEIGHTED_UNIT_LIMIT",
      { emptyIsZero: true },
    ),
    accountPendingJobLimit: parseUnsignedInteger(
      env.ACCOUNT_PENDING_JOB_LIMIT,
      "ACCOUNT_PENDING_JOB_LIMIT",
    ),
    networkPendingJobLimit: parseUnsignedInteger(
      env.NETWORK_PENDING_JOB_LIMIT,
      "NETWORK_PENDING_JOB_LIMIT",
    ),
    maximumQueuedAgeSeconds: parseUnsignedInteger(
      env.MAX_QUEUED_AGE_SECONDS,
      "MAX_QUEUED_AGE_SECONDS",
    ),
    maximumLiveMedianOutputRatioBasisPoints: parseBasisPoints(
      env.MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS,
      "MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS",
    ),
    maximumLiveP95WeightedUnits: parseUnsignedInteger(
      env.MAX_LIVE_P95_WEIGHTED_UNITS,
      "MAX_LIVE_P95_WEIGHTED_UNITS",
    ),
    maximumLiveOriginalRetainedRateBasisPoints: parseBasisPoints(
      env.MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS,
      "MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS",
    ),
    maximumLiveCostPer1000Microusd,
    maximumProjectedMonthlyCostMicrousd,
    liveCostModel,
    liveCostModelSha256,
    providerUsageSchemaSha256,
    releaseReportSha256,
    rolloutPercent,
    maintainerSessionHashes: parseMaintainerHashes(env.MAINTAINER_SESSION_HASHES),
    engineInstanceName: "image-slot-0",
    engineImageDigest: parseNonemptySetting(env.ENGINE_IMAGE_DIGEST, "ENGINE_IMAGE_DIGEST"),
  };
}
