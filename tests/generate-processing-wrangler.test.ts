import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROVIDER_USAGE_SCHEMA_SHA256,
  generateProcessingWrangler,
  parseProcessingWranglerArguments,
  writeProcessingWrangler,
} from "../scripts/generate-processing-wrangler.mjs";

const validLiveCostModel = {
  version: 1,
  containerVcpuSecondMicrousd: 1,
  containerGibSecondMicrousd: 2,
  containerDiskGbSecondMicrousd: 3,
  containerEgressGbMicrousd: 4,
  containerEgressRegionPricesMicrousd: { APAC: 4 },
  containerEgressRegionPricesSha256: "a".repeat(64),
  containerInstanceVcpu: 0.25,
  containerInstanceMemoryGib: 0.5,
  containerInstanceDiskGb: 2,
  containerSleepAfterSeconds: 60,
  workersMillionRequestsMicrousd: 5,
  workersMillionCpuMsMicrousd: 6,
  durableObjectMillionRequestsMicrousd: 7,
  durableObjectGibSecondMicrousd: 8,
  durableObjectStorageGbMonthMicrousd: 9,
  r2StorageGbMonthMicrousd: 10,
  r2ClassAMillionMicrousd: 11,
  r2ClassBMillionMicrousd: 12,
  queueMillionOperationsMicrousd: 13,
  d1MillionRowsReadMicrousd: 14,
  d1MillionRowsWrittenMicrousd: 15,
  d1StorageGbMonthMicrousd: 16,
  observabilityMillionLogEventsMicrousd: 17,
  workersLogpushMillionEventsMicrousd: 18,
  analyticsEngineMillionDataPointsMicrousd: 19,
  analyticsEngineMillionReadQueriesMicrousd: 20,
  monthlyFixedMicrousd: 21,
  routeCpuBenchmarkSha256: "b".repeat(64),
  routeCpuEnvelopeMs: {
    policy: 1,
    create: 2,
    upload: 3,
    read: 4,
    result: 5,
    maintenance: 6,
    queue: 7,
  },
  arrivalProjection: {
    algorithm: "arrival-union-tail-v1",
    steadyHourlyJobs: Array(24).fill(100),
    burstyHourlyJobs: Array(24).fill(200),
    sparseHourlyJobs: Array(24).fill(5),
    scenariosSha256: "c".repeat(64),
  },
};

function validInput(environment: "staging" | "production" = "staging") {
  const suffix = environment;
  return {
    environment,
    accountId: "0123456789abcdef0123456789abcdef",
    databaseId: "11111111-2222-3333-4444-555555555555",
    appOrigins:
      environment === "staging"
        ? [
            "http://127.0.0.1:4173",
            "http://localhost:4173",
            "https://processing-staging.hereisit.pages.dev",
          ]
        : ["https://hereisit.pages.dev"],
    bucketName: `hereisit-processing-${suffix}`,
    usageLogBucketName: `hereisit-processing-usage-${suffix}`,
    usageAnalyticsDatasetName: `hereisit_processing_usage_${suffix}`,
    costAccountingMode: "active" as const,
    logpushJobId: 123,
    containerApplicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    queueName: `hereisit-image-jobs-${suffix}`,
    dlqName: `hereisit-image-jobs-dlq-${suffix}`,
    engineImage:
      "registry.cloudflare.com/0123456789abcdef0123456789abcdef/hereisit-image-engine@sha256:" +
      "d".repeat(64),
    accountDailyWeightedUnitLimit: 80_000_000_000,
    anonymousDailyWeightedUnitLimit: 8_000_000_000,
    networkDailyWeightedUnitLimit: 24_000_000_000,
    accountPendingJobLimit: 10,
    networkPendingJobLimit: 3,
    maximumQueuedAgeSeconds: 600,
    maximumLiveMedianOutputRatioBasisPoints: 8500,
    maximumLiveP95WeightedUnits: 150_000_000,
    maximumLiveOriginalRetainedRateBasisPoints: 7000,
    maximumLiveCostPer1000Microusd: 500_000,
    maximumProjectedMonthlyCostMicrousd: 100_000_000,
    liveCostModel: validLiveCostModel,
    liveCostModelSha256: "e".repeat(64),
    providerUsageSchemaSha256: CANONICAL_PROVIDER_USAGE_SCHEMA_SHA256,
    releaseReportSha256: "1".repeat(64),
    rolloutPercent: environment === "staging" ? 0 : 5,
    maintainerSessionHashes: ["2".repeat(64)],
    sessionRateLimitNamespaceId: "21001",
    networkRateLimitNamespaceId: "21002",
    jobReadRateLimitNamespaceId: "21003",
    resultDownloadRateLimitNamespaceId: "21004",
    policyRateLimitNamespaceId: "21005",
    jobApiNetworkRateLimitNamespaceId: "21006",
    alertDestinationAddress: "operator@example.com",
  };
}

function cliArguments(input: ReturnType<typeof validInput>, liveCostModelPath: string) {
  return [
    "--environment",
    input.environment,
    "--account-id",
    input.accountId,
    "--database-id",
    input.databaseId,
    ...input.appOrigins.flatMap((origin) => ["--app-origin", origin]),
    "--bucket-name",
    input.bucketName,
    "--usage-log-bucket-name",
    input.usageLogBucketName,
    "--usage-analytics-dataset-name",
    input.usageAnalyticsDatasetName,
    "--cost-accounting-mode",
    input.costAccountingMode,
    "--logpush-job-id",
    String(input.logpushJobId),
    "--container-application-id",
    input.containerApplicationId,
    "--queue-name",
    input.queueName,
    "--dlq-name",
    input.dlqName,
    "--engine-image",
    input.engineImage,
    "--account-daily-weighted-unit-limit",
    String(input.accountDailyWeightedUnitLimit),
    "--anonymous-daily-weighted-unit-limit",
    String(input.anonymousDailyWeightedUnitLimit),
    "--network-daily-weighted-unit-limit",
    String(input.networkDailyWeightedUnitLimit),
    "--account-pending-job-limit",
    String(input.accountPendingJobLimit),
    "--network-pending-job-limit",
    String(input.networkPendingJobLimit),
    "--maximum-queued-age-seconds",
    String(input.maximumQueuedAgeSeconds),
    "--max-live-median-output-ratio-bps",
    String(input.maximumLiveMedianOutputRatioBasisPoints),
    "--max-live-p95-weighted-units",
    String(input.maximumLiveP95WeightedUnits),
    "--max-live-original-retained-rate-bps",
    String(input.maximumLiveOriginalRetainedRateBasisPoints),
    "--max-live-cost-per-1000-microusd",
    String(input.maximumLiveCostPer1000Microusd),
    "--max-projected-monthly-cost-microusd",
    String(input.maximumProjectedMonthlyCostMicrousd),
    "--live-cost-model",
    liveCostModelPath,
    "--live-cost-model-sha256",
    input.liveCostModelSha256,
    "--provider-usage-schema-sha256",
    input.providerUsageSchemaSha256,
    "--release-report-sha256",
    input.releaseReportSha256,
    "--session-rate-limit-namespace-id",
    input.sessionRateLimitNamespaceId,
    "--network-rate-limit-namespace-id",
    input.networkRateLimitNamespaceId,
    "--job-read-rate-limit-namespace-id",
    input.jobReadRateLimitNamespaceId,
    "--result-download-rate-limit-namespace-id",
    input.resultDownloadRateLimitNamespaceId,
    "--policy-rate-limit-namespace-id",
    input.policyRateLimitNamespaceId,
    "--job-api-network-rate-limit-namespace-id",
    input.jobApiNetworkRateLimitNamespaceId,
    "--alert-destination-address",
    input.alertDestinationAddress,
    "--maintainer-session-hashes-json",
    JSON.stringify(input.maintainerSessionHashes),
    "--rollout-percent",
    String(input.rolloutPercent),
  ];
}

describe("processing Wrangler generator", () => {
  it("supports repeated origins and atomically writes the generated environment file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-wrangler-"));
    try {
      const modelPath = join(root, "live-cost-model.json");
      await writeFile(modelPath, JSON.stringify(validLiveCostModel));
      const input = validInput();
      const argv = cliArguments(input, modelPath);

      expect(parseProcessingWranglerArguments(argv, validLiveCostModel).appOrigins).toEqual(
        input.appOrigins,
      );
      const output = await writeProcessingWrangler({ argv, cwd: root });
      expect(output).toBe(join(root, ".wrangler/generated/wrangler.staging.jsonc"));
      const config = JSON.parse(await readFile(output, "utf8"));
      expect(config.vars.APP_ORIGINS).toBe(JSON.stringify(input.appOrigins));
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates an environment-bound deployment config without secrets", () => {
    const input = validInput();
    const config = generateProcessingWrangler(input);

    expect(config).toMatchObject({
      name: "hereisit-processing-staging",
      main: "../../apps/api-worker/src/index.ts",
      compatibility_date: "2026-07-16",
      workers_dev: true,
      logpush: true,
      d1_databases: [
        {
          binding: "DB",
          database_name: "hereisit-processing-staging",
          database_id: input.databaseId,
          migrations_dir: "../../apps/api-worker/migrations",
        },
      ],
      r2_buckets: [
        { binding: "JOB_OBJECTS", bucket_name: input.bucketName },
        { binding: "USAGE_LOGS", bucket_name: input.usageLogBucketName },
      ],
      analytics_engine_datasets: [
        { binding: "USAGE_ANALYTICS", dataset: input.usageAnalyticsDatasetName },
      ],
      version_metadata: { binding: "WORKER_VERSION" },
      durable_objects: {
        bindings: [{ name: "IMAGE_ENGINE", class_name: "ImageEngineContainer" }],
      },
      containers: [
        {
          class_name: "ImageEngineContainer",
          image: input.engineImage,
          instance_type: "standard-2",
          max_instances: 1,
          rollout_active_grace_period: 180,
          rollout_step_percentage: [100],
        },
      ],
      send_email: [{ name: "ALERT_EMAIL", destination_address: "operator@example.com" }],
    });
    expect(config.queues.consumers).toHaveLength(2);
    expect(config.ratelimits.map((entry) => entry.namespace_id)).toEqual([
      "21001",
      "21002",
      "21003",
      "21004",
      "21005",
      "21006",
    ]);
    expect(config.vars).toMatchObject({
      ENVIRONMENT: "staging",
      CLOUDFLARE_ACCOUNT_ID: input.accountId,
      APP_ORIGINS: JSON.stringify(input.appOrigins),
      R2_BUCKET_NAME: input.bucketName,
      USAGE_LOG_BUCKET_NAME: input.usageLogBucketName,
      USAGE_ANALYTICS_DATASET_NAME: input.usageAnalyticsDatasetName,
      COST_ACCOUNTING_MODE: "active",
      LOGPUSH_JOB_ID: "123",
      CONTAINER_APPLICATION_ID: input.containerApplicationId,
      WORKER_SCRIPT_NAME: "hereisit-processing-staging",
      USAGE_LOG_PREFIX: "workers-trace-events/staging/",
      IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
      ENGINE_IMAGE_DIGEST: input.engineImage,
    });
    expect(JSON.stringify(config)).not.toMatch(/SECRET|TOKEN|r2\.dev|upload origin/i);
  });

  it("permits a fully disabled production admission configuration", () => {
    const input = {
      ...validInput("production"),
      accountDailyWeightedUnitLimit: 0,
      anonymousDailyWeightedUnitLimit: 0,
      networkDailyWeightedUnitLimit: 0,
      rolloutPercent: 0,
      maintainerSessionHashes: [],
    };

    expect(generateProcessingWrangler(input).vars).toMatchObject({
      ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: "0",
      ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT: "0",
      NETWORK_DAILY_WEIGHTED_UNIT_LIMIT: "0",
      IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
    });
  });

  it("permits a rollout-zero bootstrap before Cloudflare assigns the Container application ID", () => {
    const input = {
      ...validInput(),
      costAccountingMode: "bootstrap" as const,
      containerApplicationId: "00000000-0000-4000-8000-000000000000",
    };

    expect(generateProcessingWrangler(input).vars).toMatchObject({
      COST_ACCOUNTING_MODE: "bootstrap",
      CONTAINER_APPLICATION_ID: input.containerApplicationId,
      IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
    });
  });

  it.each([
    ["mutable image", { engineImage: "registry.cloudflare.com/account/repo:latest" }],
    [
      "cross-account image",
      {
        engineImage: `registry.cloudflare.com/${"a".repeat(32)}/hereisit-image-engine@sha256:${"d".repeat(64)}`,
      },
    ],
    ["rollout overflow", { rolloutPercent: 101 }],
    ["duplicate namespaces", { networkRateLimitNamespaceId: "21001" }],
    ["negative quota", { accountDailyWeightedUnitLimit: -1 }],
    ["zero Logpush job id", { logpushJobId: 0 }],
    ["invalid Container application id", { containerApplicationId: "not-a-uuid" }],
    [
      "active placeholder Container application id",
      { containerApplicationId: "00000000-0000-4000-8000-000000000000" },
    ],
    ["wrong bucket", { bucketName: "hereisit-processing-production" }],
    ["wrong dataset", { usageAnalyticsDatasetName: "hereisit_processing_usage_production" }],
  ])("rejects %s", (_label, override) => {
    expect(() => generateProcessingWrangler({ ...validInput(), ...override })).toThrow();
  });

  it("rejects public admission without a complete positive cost and quota fence", () => {
    expect(() =>
      generateProcessingWrangler({
        ...validInput("production"),
        maximumProjectedMonthlyCostMicrousd: 0,
      }),
    ).toThrow(/cost|ceiling/i);
  });

  it("requires staging to remain maintainer-only", () => {
    expect(() => generateProcessingWrangler({ ...validInput(), rolloutPercent: 5 })).toThrow(
      /staging/i,
    );
    expect(() =>
      generateProcessingWrangler({ ...validInput(), maintainerSessionHashes: [] }),
    ).toThrow(/maintainer/i);
  });

  it("rejects a provider usage schema hash that differs from the checked-in contract", () => {
    expect(() =>
      generateProcessingWrangler({
        ...validInput(),
        providerUsageSchemaSha256: "f".repeat(64),
      }),
    ).toThrow(/provider usage schema/i);
  });
});
