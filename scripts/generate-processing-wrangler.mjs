const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const NAMESPACE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_STANDARD_ATTEMPT_WEIGHTED_UNITS = 2_502_994_560;

export const CANONICAL_PROVIDER_USAGE_SCHEMA_SHA256 = createHash("sha256")
  .update(JSON.stringify(providerUsageContract))
  .digest("hex");

const liveCostKeys = [
  "version",
  "containerVcpuSecondMicrousd",
  "containerGibSecondMicrousd",
  "containerDiskGbSecondMicrousd",
  "containerEgressGbMicrousd",
  "containerEgressRegionPricesMicrousd",
  "containerEgressRegionPricesSha256",
  "containerInstanceVcpu",
  "containerInstanceMemoryGib",
  "containerInstanceDiskGb",
  "containerSleepAfterSeconds",
  "workersMillionRequestsMicrousd",
  "workersMillionCpuMsMicrousd",
  "durableObjectMillionRequestsMicrousd",
  "durableObjectGibSecondMicrousd",
  "durableObjectStorageGbMonthMicrousd",
  "r2StorageGbMonthMicrousd",
  "r2ClassAMillionMicrousd",
  "r2ClassBMillionMicrousd",
  "queueMillionOperationsMicrousd",
  "d1MillionRowsReadMicrousd",
  "d1MillionRowsWrittenMicrousd",
  "d1StorageGbMonthMicrousd",
  "observabilityMillionLogEventsMicrousd",
  "workersLogpushMillionEventsMicrousd",
  "analyticsEngineMillionDataPointsMicrousd",
  "analyticsEngineMillionReadQueriesMicrousd",
  "monthlyFixedMicrousd",
  "routeCpuBenchmarkSha256",
  "routeCpuEnvelopeMs",
  "arrivalProjection",
];

const monetaryCostKeys = liveCostKeys.filter(
  (key) =>
    key.endsWith("Microusd") &&
    key !== "containerEgressRegionPricesMicrousd" &&
    !key.startsWith("containerInstance"),
);

const inputKeys = new Set([
  "environment",
  "accountId",
  "databaseId",
  "appOrigins",
  "bucketName",
  "usageLogBucketName",
  "usageAnalyticsDatasetName",
  "queueName",
  "dlqName",
  "engineImage",
  "accountDailyWeightedUnitLimit",
  "anonymousDailyWeightedUnitLimit",
  "networkDailyWeightedUnitLimit",
  "accountPendingJobLimit",
  "networkPendingJobLimit",
  "maximumQueuedAgeSeconds",
  "maximumLiveMedianOutputRatioBasisPoints",
  "maximumLiveP95WeightedUnits",
  "maximumLiveOriginalRetainedRateBasisPoints",
  "maximumLiveCostPer1000Microusd",
  "maximumProjectedMonthlyCostMicrousd",
  "liveCostModel",
  "liveCostModelSha256",
  "providerUsageSchemaSha256",
  "releaseReportSha256",
  "rolloutPercent",
  "maintainerSessionHashes",
  "sessionRateLimitNamespaceId",
  "networkRateLimitNamespaceId",
  "jobReadRateLimitNamespaceId",
  "resultDownloadRateLimitNamespaceId",
  "policyRateLimitNamespaceId",
  "jobApiNetworkRateLimitNamespaceId",
  "alertDestinationAddress",
]);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains missing or unknown fields`);
  }
}

function assertSafeInteger(value, label, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be a non-negative safe integer at most ${maximum}`);
  }
  return value;
}

function assertPositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateLiveCostModel(value, requirePositiveCosts) {
  const model = assertPlainObject(value, "liveCostModel");
  assertExactKeys(model, liveCostKeys, "liveCostModel");
  if (model.version !== 1 || model.containerSleepAfterSeconds !== 60) {
    throw new TypeError("liveCostModel version and sleep policy must be fixed");
  }
  assertSha256(model.containerEgressRegionPricesSha256, "container egress price hash");
  assertSha256(model.routeCpuBenchmarkSha256, "route CPU benchmark hash");
  for (const key of monetaryCostKeys) {
    assertSafeInteger(model[key], `liveCostModel.${key}`);
    if (requirePositiveCosts && model[key] === 0) {
      throw new RangeError(`liveCostModel.${key} must be positive while admission is enabled`);
    }
  }
  for (const key of [
    "containerInstanceVcpu",
    "containerInstanceMemoryGib",
    "containerInstanceDiskGb",
  ]) {
    assertPositiveNumber(model[key], `liveCostModel.${key}`);
  }
  const regional = assertPlainObject(
    model.containerEgressRegionPricesMicrousd,
    "liveCostModel.containerEgressRegionPricesMicrousd",
  );
  if (Object.keys(regional).length === 0)
    throw new TypeError("at least one egress region is required");
  for (const [region, price] of Object.entries(regional)) {
    if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(region)) throw new TypeError("egress region is invalid");
    assertSafeInteger(price, `egress price ${region}`);
    if (requirePositiveCosts && price === 0) throw new RangeError("egress prices must be positive");
  }
  const routes = assertPlainObject(model.routeCpuEnvelopeMs, "liveCostModel.routeCpuEnvelopeMs");
  const routeKeys = ["policy", "create", "upload", "read", "result", "maintenance", "queue"];
  assertExactKeys(routes, routeKeys, "liveCostModel.routeCpuEnvelopeMs");
  for (const key of routeKeys) assertPositiveNumber(routes[key], `routeCpuEnvelopeMs.${key}`);
  const projection = assertPlainObject(model.arrivalProjection, "liveCostModel.arrivalProjection");
  assertExactKeys(
    projection,
    ["algorithm", "steadyHourlyJobs", "burstyHourlyJobs", "sparseHourlyJobs", "scenariosSha256"],
    "liveCostModel.arrivalProjection",
  );
  if (projection.algorithm !== "arrival-union-tail-v1") {
    throw new TypeError("arrival projection algorithm is invalid");
  }
  assertSha256(projection.scenariosSha256, "arrival projection hash");
  for (const key of ["steadyHourlyJobs", "burstyHourlyJobs", "sparseHourlyJobs"]) {
    if (!Array.isArray(projection[key]) || projection[key].length !== 24) {
      throw new TypeError(`${key} must contain exactly 24 hours`);
    }
    for (const value of projection[key]) assertSafeInteger(value, `${key} entry`);
  }
}

function normalizeOrigins(origins, environment) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError("appOrigins must be a non-empty array");
  }
  const normalized = origins.map((entry) => {
    if (typeof entry !== "string") throw new TypeError("appOrigins entries must be strings");
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new TypeError("appOrigins entries must be absolute origins");
    }
    if (
      url.origin !== entry ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError("appOrigins entries must contain only an exact origin");
    }
    if (environment === "production" && url.protocol !== "https:") {
      throw new TypeError("production origins must use HTTPS");
    }
    return url.origin;
  });
  if (new Set(normalized).size !== normalized.length)
    throw new TypeError("appOrigins must be unique");
  if (environment === "staging" && normalized.includes("https://hereisit.pages.dev")) {
    throw new TypeError("staging must not admit the production origin");
  }
  if (environment === "production" && normalized.some((origin) => origin.includes("staging"))) {
    throw new TypeError("production must not admit a staging origin");
  }
  return normalized;
}

function validateInput(input) {
  const value = assertPlainObject(input, "processing Wrangler input");
  for (const key of Object.keys(value)) {
    if (!inputKeys.has(key)) throw new TypeError(`unknown processing Wrangler field: ${key}`);
  }
  if (value.environment !== "staging" && value.environment !== "production") {
    throw new TypeError("environment must be staging or production");
  }
  const environment = value.environment;
  if (!ACCOUNT_ID_PATTERN.test(value.accountId ?? "")) throw new TypeError("accountId is invalid");
  if (!UUID_PATTERN.test(value.databaseId ?? "")) throw new TypeError("databaseId is invalid");
  const expected = {
    bucketName: `hereisit-processing-${environment}`,
    usageLogBucketName: `hereisit-processing-usage-${environment}`,
    usageAnalyticsDatasetName: `hereisit_processing_usage_${environment}`,
    queueName: `hereisit-image-jobs-${environment}`,
    dlqName: `hereisit-image-jobs-dlq-${environment}`,
  };
  for (const [key, expectedName] of Object.entries(expected)) {
    if (value[key] !== expectedName) throw new TypeError(`${key} does not match ${environment}`);
  }
  const imagePattern = new RegExp(
    `^registry\\.cloudflare\\.com/(${value.accountId})/hereisit-image-engine@sha256:([0-9a-f]{64})$`,
  );
  if (typeof value.engineImage !== "string" || !imagePattern.test(value.engineImage)) {
    throw new TypeError("engineImage must be an immutable same-account Cloudflare registry digest");
  }
  const appOrigins = normalizeOrigins(value.appOrigins, environment);
  for (const key of [
    "accountDailyWeightedUnitLimit",
    "anonymousDailyWeightedUnitLimit",
    "networkDailyWeightedUnitLimit",
    "accountPendingJobLimit",
    "networkPendingJobLimit",
    "maximumQueuedAgeSeconds",
    "maximumLiveP95WeightedUnits",
    "maximumLiveCostPer1000Microusd",
    "maximumProjectedMonthlyCostMicrousd",
  ]) {
    assertSafeInteger(value[key], key);
  }
  assertSafeInteger(
    value.maximumLiveMedianOutputRatioBasisPoints,
    "maximumLiveMedianOutputRatioBasisPoints",
    { maximum: 10_000 },
  );
  assertSafeInteger(
    value.maximumLiveOriginalRetainedRateBasisPoints,
    "maximumLiveOriginalRetainedRateBasisPoints",
    { maximum: 10_000 },
  );
  assertSafeInteger(value.rolloutPercent, "rolloutPercent", { maximum: 100 });
  for (const key of ["liveCostModelSha256", "providerUsageSchemaSha256", "releaseReportSha256"]) {
    assertSha256(value[key], key);
  }
  if (value.providerUsageSchemaSha256 !== CANONICAL_PROVIDER_USAGE_SCHEMA_SHA256) {
    throw new TypeError("provider usage schema hash does not match the checked-in contract");
  }
  if (!Array.isArray(value.maintainerSessionHashes)) {
    throw new TypeError("maintainerSessionHashes must be an array");
  }
  for (const hash of value.maintainerSessionHashes) assertSha256(hash, "maintainer hash");
  if (new Set(value.maintainerSessionHashes).size !== value.maintainerSessionHashes.length) {
    throw new TypeError("maintainerSessionHashes must be unique");
  }
  const namespaceKeys = [
    "sessionRateLimitNamespaceId",
    "networkRateLimitNamespaceId",
    "jobReadRateLimitNamespaceId",
    "resultDownloadRateLimitNamespaceId",
    "policyRateLimitNamespaceId",
    "jobApiNetworkRateLimitNamespaceId",
  ];
  const namespaceIds = namespaceKeys.map((key) => {
    if (typeof value[key] !== "string" || !NAMESPACE_PATTERN.test(value[key])) {
      throw new TypeError(`${key} must be a canonical integer string`);
    }
    return value[key];
  });
  if (new Set(namespaceIds).size !== namespaceIds.length) {
    throw new TypeError("Rate Limit namespace IDs must be unique");
  }
  if (
    typeof value.alertDestinationAddress !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.alertDestinationAddress)
  ) {
    throw new TypeError("alert destination must be a verified email address");
  }
  if (environment === "staging") {
    if (value.rolloutPercent !== 0) throw new RangeError("staging rollout must remain zero");
    if (value.maintainerSessionHashes.length === 0) {
      throw new RangeError("staging requires a maintainer allowlist");
    }
  }
  const admissionEnabled = value.rolloutPercent > 0 || value.maintainerSessionHashes.length > 0;
  if (admissionEnabled) {
    for (const key of [
      "accountDailyWeightedUnitLimit",
      "anonymousDailyWeightedUnitLimit",
      "networkDailyWeightedUnitLimit",
    ]) {
      if (value[key] < MAX_STANDARD_ATTEMPT_WEIGHTED_UNITS) {
        throw new RangeError(`${key} must cover one maximum standard attempt`);
      }
    }
    if (
      value.maximumLiveCostPer1000Microusd <= 0 ||
      value.maximumProjectedMonthlyCostMicrousd <= 0
    ) {
      throw new RangeError("positive live and monthly cost ceilings are required");
    }
  }
  validateLiveCostModel(value.liveCostModel, admissionEnabled);
  return { ...value, appOrigins, namespaceIds };
}

export function generateProcessingWrangler(input) {
  const value = validateInput(input);
  const environment = value.environment;
  const rateLimits = [
    ["SESSION_JOB_RATE_LIMITER", value.sessionRateLimitNamespaceId, 20],
    ["NETWORK_JOB_RATE_LIMITER", value.networkRateLimitNamespaceId, 10],
    ["JOB_READ_RATE_LIMITER", value.jobReadRateLimitNamespaceId, 90],
    ["RESULT_DOWNLOAD_RATE_LIMITER", value.resultDownloadRateLimitNamespaceId, 3],
    ["POLICY_RATE_LIMITER", value.policyRateLimitNamespaceId, 60],
    ["JOB_API_NETWORK_RATE_LIMITER", value.jobApiNetworkRateLimitNamespaceId, 180],
  ];
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: `hereisit-processing-${environment}`,
    main: "../../apps/api-worker/src/index.ts",
    compatibility_date: "2026-07-16",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: environment === "staging",
    logpush: true,
    triggers: { crons: ["*/5 * * * *"] },
    d1_databases: [
      {
        binding: "DB",
        database_name: `hereisit-processing-${environment}`,
        database_id: value.databaseId,
        migrations_dir: "../../apps/api-worker/migrations",
      },
    ],
    r2_buckets: [
      { binding: "JOB_OBJECTS", bucket_name: value.bucketName },
      { binding: "USAGE_LOGS", bucket_name: value.usageLogBucketName },
    ],
    analytics_engine_datasets: [
      { binding: "USAGE_ANALYTICS", dataset: value.usageAnalyticsDatasetName },
    ],
    version_metadata: { binding: "WORKER_VERSION" },
    queues: {
      producers: [{ binding: "IMAGE_JOBS", queue: value.queueName }],
      consumers: [
        {
          queue: value.queueName,
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 2,
          dead_letter_queue: value.dlqName,
          max_concurrency: 1,
        },
        {
          queue: value.dlqName,
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 0,
          max_concurrency: 1,
        },
      ],
    },
    containers: [
      {
        class_name: "ImageEngineContainer",
        image: value.engineImage,
        instance_type: "standard-2",
        max_instances: 1,
        rollout_active_grace_period: 180,
        rollout_step_percentage: [100],
      },
    ],
    durable_objects: {
      bindings: [{ name: "IMAGE_ENGINE", class_name: "ImageEngineContainer" }],
    },
    migrations: [{ tag: "image-engine-v1", new_sqlite_classes: ["ImageEngineContainer"] }],
    ratelimits: rateLimits.map(([name, namespace_id, limit]) => ({
      name,
      namespace_id,
      simple: { limit, period: 60 },
    })),
    send_email: [{ name: "ALERT_EMAIL", destination_address: value.alertDestinationAddress }],
    vars: {
      ENVIRONMENT: environment,
      CLOUDFLARE_ACCOUNT_ID: value.accountId,
      APP_ORIGINS: JSON.stringify(value.appOrigins),
      R2_BUCKET_NAME: value.bucketName,
      USAGE_LOG_BUCKET_NAME: value.usageLogBucketName,
      USAGE_ANALYTICS_DATASET_NAME: value.usageAnalyticsDatasetName,
      ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: String(value.accountDailyWeightedUnitLimit),
      ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT: String(value.anonymousDailyWeightedUnitLimit),
      NETWORK_DAILY_WEIGHTED_UNIT_LIMIT: String(value.networkDailyWeightedUnitLimit),
      ACCOUNT_PENDING_JOB_LIMIT: String(value.accountPendingJobLimit),
      NETWORK_PENDING_JOB_LIMIT: String(value.networkPendingJobLimit),
      MAX_QUEUED_AGE_SECONDS: String(value.maximumQueuedAgeSeconds),
      MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS: String(value.maximumLiveMedianOutputRatioBasisPoints),
      MAX_LIVE_P95_WEIGHTED_UNITS: String(value.maximumLiveP95WeightedUnits),
      MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS: String(value.maximumLiveOriginalRetainedRateBasisPoints),
      MAX_LIVE_COST_PER_1000_MICROUSD: String(value.maximumLiveCostPer1000Microusd),
      MAX_PROJECTED_MONTHLY_COST_MICROUSD: String(value.maximumProjectedMonthlyCostMicrousd),
      LIVE_COST_MODEL_JSON: JSON.stringify(value.liveCostModel),
      LIVE_COST_MODEL_SHA256: value.liveCostModelSha256,
      PROVIDER_USAGE_SCHEMA_SHA256: value.providerUsageSchemaSha256,
      RELEASE_REPORT_SHA256: value.releaseReportSha256,
      IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: String(value.rolloutPercent),
      MAINTAINER_SESSION_HASHES: JSON.stringify(value.maintainerSessionHashes),
      ENGINE_INSTANCE_NAME: "image-slot-0",
      ENGINE_IMAGE_DIGEST: value.engineImage,
      IMAGE_JOBS_QUEUE_NAME: value.queueName,
      IMAGE_JOBS_DLQ_NAME: value.dlqName,
    },
  };
}

const cliScalarFields = {
  environment: "environment",
  "account-id": "accountId",
  "database-id": "databaseId",
  "bucket-name": "bucketName",
  "usage-log-bucket-name": "usageLogBucketName",
  "usage-analytics-dataset-name": "usageAnalyticsDatasetName",
  "queue-name": "queueName",
  "dlq-name": "dlqName",
  "engine-image": "engineImage",
  "live-cost-model-sha256": "liveCostModelSha256",
  "provider-usage-schema-sha256": "providerUsageSchemaSha256",
  "release-report-sha256": "releaseReportSha256",
  "session-rate-limit-namespace-id": "sessionRateLimitNamespaceId",
  "network-rate-limit-namespace-id": "networkRateLimitNamespaceId",
  "job-read-rate-limit-namespace-id": "jobReadRateLimitNamespaceId",
  "result-download-rate-limit-namespace-id": "resultDownloadRateLimitNamespaceId",
  "policy-rate-limit-namespace-id": "policyRateLimitNamespaceId",
  "job-api-network-rate-limit-namespace-id": "jobApiNetworkRateLimitNamespaceId",
  "alert-destination-address": "alertDestinationAddress",
};

const cliIntegerFields = {
  "account-daily-weighted-unit-limit": "accountDailyWeightedUnitLimit",
  "anonymous-daily-weighted-unit-limit": "anonymousDailyWeightedUnitLimit",
  "network-daily-weighted-unit-limit": "networkDailyWeightedUnitLimit",
  "account-pending-job-limit": "accountPendingJobLimit",
  "network-pending-job-limit": "networkPendingJobLimit",
  "maximum-queued-age-seconds": "maximumQueuedAgeSeconds",
  "max-live-median-output-ratio-bps": "maximumLiveMedianOutputRatioBasisPoints",
  "max-live-p95-weighted-units": "maximumLiveP95WeightedUnits",
  "max-live-original-retained-rate-bps": "maximumLiveOriginalRetainedRateBasisPoints",
  "max-live-cost-per-1000-microusd": "maximumLiveCostPer1000Microusd",
  "max-projected-monthly-cost-microusd": "maximumProjectedMonthlyCostMicrousd",
  "rollout-percent": "rolloutPercent",
};

function parseCanonicalInteger(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`--${label} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`--${label} exceeds safe integer range`);
  return parsed;
}

export function parseProcessingWranglerArguments(argv, liveCostModel) {
  if (!Array.isArray(argv)) throw new TypeError("CLI arguments must be an array");
  const parsed = { appOrigins: [], liveCostModel };
  const seen = new Set();
  let liveCostModelPath;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      throw new TypeError("CLI arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (name === "app-origin") {
      parsed.appOrigins.push(value);
      continue;
    }
    if (seen.has(name)) throw new TypeError(`duplicate CLI argument --${name}`);
    seen.add(name);
    if (name === "live-cost-model") {
      liveCostModelPath = value;
    } else if (name === "maintainer-session-hashes-json") {
      try {
        parsed.maintainerSessionHashes = JSON.parse(value);
      } catch {
        throw new TypeError("--maintainer-session-hashes-json must be valid JSON");
      }
    } else if (Object.hasOwn(cliScalarFields, name)) {
      parsed[cliScalarFields[name]] = value;
    } else if (Object.hasOwn(cliIntegerFields, name)) {
      parsed[cliIntegerFields[name]] = parseCanonicalInteger(value, name);
    } else {
      throw new TypeError(`unknown processing Wrangler argument --${name}`);
    }
  }
  if (liveCostModel === undefined) {
    if (liveCostModelPath === undefined) throw new TypeError("--live-cost-model is required");
    parsed.liveCostModelPath = liveCostModelPath;
  } else if (liveCostModelPath === undefined) {
    parsed.liveCostModelPath = "[provided]";
  }
  return parsed;
}

async function readBoundedJson(path, label) {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength > 1024 * 1024) throw new RangeError(`${label} exceeds 1 MiB`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
}

export async function writeProcessingWrangler({ argv, cwd = process.cwd() }) {
  const firstPass = parseProcessingWranglerArguments(argv, undefined);
  const liveCostModel = await readBoundedJson(firstPass.liveCostModelPath, "live cost model");
  const input = parseProcessingWranglerArguments(argv, liveCostModel);
  delete input.liveCostModelPath;
  const config = generateProcessingWrangler(input);
  const output = resolve(cwd, `.wrangler/generated/wrangler.${input.environment}.jsonc`);
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporary, output);
  } catch (error) {
    await import("node:fs/promises").then(({ unlink }) => unlink(temporary).catch(() => undefined));
    throw error;
  }
  return output;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await writeProcessingWrangler({ argv: process.argv.slice(2) });
}

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import providerUsageContract from "../docs/deployment/provider-usage-schema.v1.json" with {
  type: "json",
};
