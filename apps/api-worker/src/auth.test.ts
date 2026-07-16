import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  hashAnonymousSessionId,
  hashJobToken,
  hashNetworkBuckets,
  jobTokenMatches,
  sessionRolloutBucket,
  verifyJobToken,
} from "./auth";
import { type Env, parseOperationalConfig } from "./env";

const currentSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString(
  "base64url",
);
const previousSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString(
  "base64url",
);
const jobToken = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 7) % 256)).toString(
  "base64url",
);
const anonymousSessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function makeTimingSafeEqualSpy() {
  return vi.fn((left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) =>
    nodeTimingSafeEqual(
      Buffer.from(
        left instanceof ArrayBuffer
          ? new Uint8Array(left)
          : new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
      ),
      Buffer.from(
        right instanceof ArrayBuffer
          ? new Uint8Array(right)
          : new Uint8Array(right.buffer, right.byteOffset, right.byteLength),
      ),
    ),
  );
}

const regionPrices = {
  apac: 3,
  europe: 2,
  northAmerica: 1,
} as const;

const steadyHourlyJobs: number[] = Array.from({ length: 24 }, (_, hour) => 100 + hour);
const burstyHourlyJobs: number[] = Array.from({ length: 24 }, (_, hour) =>
  hour >= 17 && hour <= 20 ? 1_000 : 20,
);
const sparseHourlyJobs: number[] = Array.from({ length: 24 }, (_, hour) =>
  hour % 8 === 0 ? 5 : 0,
);

function arrivalScenariosHash(input: {
  steadyHourlyJobs: readonly number[];
  burstyHourlyJobs: readonly number[];
  sparseHourlyJobs: readonly number[];
}): string {
  return sha256Hex(
    canonicalJson({
      steadyHourlyJobs: input.steadyHourlyJobs,
      burstyHourlyJobs: input.burstyHourlyJobs,
      sparseHourlyJobs: input.sparseHourlyJobs,
    }),
  );
}

function makeLiveCostModel() {
  return {
    version: 1,
    containerVcpuSecondMicrousd: 1,
    containerGibSecondMicrousd: 2,
    containerDiskGbSecondMicrousd: 3,
    containerEgressGbMicrousd: 4,
    containerEgressRegionPricesMicrousd: regionPrices,
    containerEgressRegionPricesSha256: sha256Hex(canonicalJson(regionPrices)),
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
    routeCpuBenchmarkSha256: "1".repeat(64),
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
      steadyHourlyJobs: [...steadyHourlyJobs],
      burstyHourlyJobs: [...burstyHourlyJobs],
      sparseHourlyJobs: [...sparseHourlyJobs],
      scenariosSha256: arrivalScenariosHash({
        steadyHourlyJobs,
        burstyHourlyJobs,
        sparseHourlyJobs,
      }),
    },
  };
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  const liveCostModel = makeLiveCostModel();
  const liveCostModelJson = canonicalJson(liveCostModel);
  return {
    ENVIRONMENT: "local",
    CLOUDFLARE_ACCOUNT_ID: "local-account",
    APP_ORIGINS: JSON.stringify([
      "http://127.0.0.1:3000",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]),
    R2_BUCKET_NAME: "hereisit-job-objects-local",
    ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: "80000000000",
    ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT: "8000000000",
    NETWORK_DAILY_WEIGHTED_UNIT_LIMIT: "24000000000",
    ACCOUNT_PENDING_JOB_LIMIT: "10",
    NETWORK_PENDING_JOB_LIMIT: "3",
    MAX_QUEUED_AGE_SECONDS: "600",
    MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS: "10000",
    MAX_LIVE_P95_WEIGHTED_UNITS: "1000000000",
    MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS: "10000",
    MAX_LIVE_COST_PER_1000_MICROUSD: "1000000000",
    MAX_PROJECTED_MONTHLY_COST_MICROUSD: "1000000000",
    LIVE_COST_MODEL_JSON: liveCostModelJson,
    LIVE_COST_MODEL_SHA256: sha256Hex(canonicalJson(liveCostModel)),
    PROVIDER_USAGE_SCHEMA_SHA256: "2".repeat(64),
    RELEASE_REPORT_SHA256: "3".repeat(64),
    IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "100",
    MAINTAINER_SESSION_HASHES: "[]",
    ENGINE_INSTANCE_NAME: "image-slot-0",
    ENGINE_IMAGE_DIGEST: "local-dockerfile",
    IMAGE_JOBS_QUEUE_NAME: "hereisit-image-jobs-local",
    IMAGE_JOBS_DLQ_NAME: "hereisit-image-jobs-dlq-local",
    ABUSE_HMAC_SECRET_CURRENT: currentSecret,
    ABUSE_HMAC_SECRET_PREVIOUS: previousSecret,
    ANALYTICS_READ_TOKEN: "non-working-read-token",
    LOGPUSH_STATUS_TOKEN: "non-working-logpush-token",
    ...overrides,
  } as Env;
}

describe("job and session authentication hashes", () => {
  it("hashes a valid 32-byte base64url token as the SHA-256 of its decoded bytes", async () => {
    await expect(hashJobToken(jobToken)).resolves.toBe(
      createHash("sha256").update(Buffer.from(jobToken, "base64url")).digest("hex"),
    );
  });

  it("compares valid token hashes with the Workers timing-safe primitive", async () => {
    const expectedHash = await hashJobToken(jobToken);
    const timingSafeEqualSpy = makeTimingSafeEqualSpy();

    await expect(
      jobTokenMatches(jobToken, expectedHash, {
        timingSafeEqual: timingSafeEqualSpy,
      }),
    ).resolves.toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledOnce();
    expect(timingSafeEqualSpy.mock.calls[0]?.[0]).toHaveLength(32);
    expect(timingSafeEqualSpy.mock.calls[0]?.[1]).toHaveLength(32);
  });

  it("uses a fixed-length byte-loop fallback when Node lacks the Workers primitive", async () => {
    const expectedHash = await hashJobToken(jobToken);

    await expect(jobTokenMatches(jobToken, expectedHash)).resolves.toBe(true);
    await expect(jobTokenMatches(jobToken, "f".repeat(64))).resolves.toBe(false);
  });

  it("rejects malformed tokens before repository access", async () => {
    const loadExpectedHash = vi.fn(async () => "0".repeat(64));
    const recordResult = vi.fn();

    await expect(
      verifyJobToken({
        token: "not-a-token",
        loadExpectedHash,
        recordResult,
      }),
    ).rejects.toThrow(/32-byte base64url/i);
    expect(loadExpectedHash).not.toHaveBeenCalled();
    expect(recordResult).not.toHaveBeenCalled();
  });

  it("never passes the raw token to repository or telemetry helpers", async () => {
    const expectedHash = await hashJobToken(jobToken);
    const loadExpectedHash = vi.fn(async () => expectedHash);
    const recordResult = vi.fn();

    await expect(
      verifyJobToken({
        token: jobToken,
        loadExpectedHash,
        recordResult,
      }),
    ).resolves.toBe(true);
    expect(loadExpectedHash).toHaveBeenCalledWith();
    expect(JSON.stringify(loadExpectedHash.mock.calls)).not.toContain(jobToken);
    expect(JSON.stringify(recordResult.mock.calls)).not.toContain(jobToken);
    expect(recordResult).toHaveBeenCalledWith({ matched: true });
  });

  it("hashes anonymous sessions deterministically without returning the identifier", async () => {
    const first = await hashAnonymousSessionId(anonymousSessionId);
    const second = await hashAnonymousSessionId(anonymousSessionId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(anonymousSessionId);
  });

  it("assigns a stable bounded rollout bucket", async () => {
    const first = await sessionRolloutBucket(anonymousSessionId);
    const second = await sessionRolloutBucket(anonymousSessionId);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });
});

describe("rotating network hashes", () => {
  it.each([
    ["192.0.2.1", "192.0.2.254"],
    ["10.20.30.0", "10.20.30.255"],
  ])("canonicalizes IPv4 addresses to /24 (%s and %s)", async (left, right) => {
    const [leftHashes, rightHashes] = await Promise.all([
      hashNetworkBuckets({
        ip: left,
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
      hashNetworkBuckets({
        ip: right,
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
    ]);

    expect(leftHashes).toEqual(rightHashes);
  });

  it.each([
    ["2001:db8:abcd:12ff::1", "2001:0db8:abcd:12aa:0000:0000:0000:0002"],
    ["2001:db8::1", "2001:0db8:0000:00ff:0000:0000:0000:ffff"],
  ])("canonicalizes compressed and expanded IPv6 addresses to /56", async (left, right) => {
    const [leftHashes, rightHashes] = await Promise.all([
      hashNetworkBuckets({
        ip: left,
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
      hashNetworkBuckets({
        ip: right,
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
    ]);

    expect(leftHashes).toEqual(rightHashes);
  });

  it("preserves exactly the first seven IPv6 bytes and domain-separates address families", async () => {
    const [base, sameFirstSevenBytes, differentSeventhByte, ipv4] = await Promise.all([
      hashNetworkBuckets({
        ip: "2001:db8:abcd:12ff::1",
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
      hashNetworkBuckets({
        ip: "2001:db8:abcd:1200:ffff:ffff:ffff:ffff",
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
      hashNetworkBuckets({
        ip: "2001:db8:abcd:13ff::1",
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
      hashNetworkBuckets({
        ip: "32.1.13.184",
        utcDay: "2026-07-16",
        currentSecret,
        previousSecret,
      }),
    ]);

    expect(base).toEqual(sameFirstSevenBytes);
    expect(base.writeHash).not.toBe(differentSeventhByte.writeHash);
    expect(base.writeHash).not.toBe(ipv4.writeHash);
  });

  it("covers the current and previous secret/day overlap with deterministic hashes", async () => {
    const today = await hashNetworkBuckets({
      ip: "203.0.113.91",
      utcDay: "2026-07-16",
      currentSecret,
      previousSecret,
    });
    const yesterday = await hashNetworkBuckets({
      ip: "203.0.113.91",
      utcDay: "2026-07-15",
      currentSecret,
      previousSecret,
    });

    expect(today.writeHash).toBe(today.dailyQuotaHashes[0]);
    expect(today.dailyQuotaHashes).toHaveLength(2);
    expect(today.pendingHashes).toHaveLength(4);
    expect(today.pendingHashes).toEqual(expect.arrayContaining([...today.dailyQuotaHashes]));
    expect(today.pendingHashes).toEqual(expect.arrayContaining([...yesterday.dailyQuotaHashes]));
    expect(today.writeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(today)).not.toContain("203.0.113");
  });

  it("deduplicates overlap when both secrets are the same", async () => {
    const result = await hashNetworkBuckets({
      ip: "203.0.113.91",
      utcDay: "2026-07-16",
      currentSecret,
      previousSecret: currentSecret,
    });

    expect(result.dailyQuotaHashes).toHaveLength(1);
    expect(result.pendingHashes).toHaveLength(2);
  });

  it.each([
    { ip: "999.0.0.1", currentSecret, previousSecret, utcDay: "2026-07-16" },
    { ip: "203.0.113.999", currentSecret, previousSecret, utcDay: "2026-07-16" },
    { ip: "2001:db8::1::2", currentSecret, previousSecret, utcDay: "2026-07-16" },
    { ip: "203.0.113.1", currentSecret: "short", previousSecret, utcDay: "2026-07-16" },
    {
      ip: "203.0.113.1",
      currentSecret,
      previousSecret: `${previousSecret}=`,
      utcDay: "2026-07-16",
    },
    { ip: "203.0.113.1", currentSecret, previousSecret, utcDay: "2026-02-30" },
  ])("rejects malformed network hashing input", async (input) => {
    await expect(hashNetworkBuckets(input)).rejects.toThrow();
  });
});

describe("strict operational configuration", () => {
  it("parses the complete synthetic local model and normalizes exact origins", async () => {
    const config = await parseOperationalConfig(makeEnv());

    expect(config.environment).toBe("local");
    expect(config.appOrigins.map((origin) => origin.origin)).toEqual([
      "http://127.0.0.1:3000",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]);
    expect(config.liveCostModel.arrivalProjection.steadyHourlyJobs).toHaveLength(24);
    expect(config.rolloutPercent).toBe(100);
  });

  it("keeps production processing disabled when the account budget is absent", async () => {
    const config = await parseOperationalConfig(
      makeEnv({
        ENVIRONMENT: "production",
        APP_ORIGINS: '["https://hereisit.pages.dev"]',
        ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: "",
      }),
    );

    expect(config.accountDailyWeightedUnitLimit).toBe(0);
  });

  it.each([
    "[",
    "{}",
    '["https://one.example","https://one.example"]',
    '["https://user:secret@one.example"]',
    '["https://one.example/path"]',
    '["https://one.example?query=1"]',
    '["https://one.example#fragment"]',
  ])("rejects malformed or unsafe origin arrays: %s", async (appOrigins) => {
    await expect(parseOperationalConfig(makeEnv({ APP_ORIGINS: appOrigins }))).rejects.toThrow();
  });

  it("requires every production origin to use HTTPS", async () => {
    await expect(
      parseOperationalConfig(
        makeEnv({
          ENVIRONMENT: "production",
          APP_ORIGINS: '["http://hereisit.example"]',
        }),
      ),
    ).rejects.toThrow(/https/i);
  });

  it.each([
    "[",
    "{}",
    `["${"a".repeat(64)}","${"a".repeat(64)}"]`,
    `["${"A".repeat(64)}"]`,
    '["not-a-hash"]',
  ])("rejects malformed, duplicate, or non-canonical maintainer hashes: %s", async (hashes) => {
    await expect(
      parseOperationalConfig(makeEnv({ MAINTAINER_SESSION_HASHES: hashes })),
    ).rejects.toThrow();
  });

  it.each([
    ["ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT", "1.5"],
    ["NETWORK_DAILY_WEIGHTED_UNIT_LIMIT", "-1"],
    ["ACCOUNT_PENDING_JOB_LIMIT", "01"],
    ["NETWORK_PENDING_JOB_LIMIT", "NaN"],
    ["MAX_QUEUED_AGE_SECONDS", `${Number.MAX_SAFE_INTEGER + 1}`],
    ["IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT", "101"],
  ])("rejects a malformed numeric setting %s=%s", async (name, value) => {
    await expect(parseOperationalConfig(makeEnv({ [name]: value }))).rejects.toThrow();
  });

  it.each(["0", "10000"])("accepts canonical basis-point boundaries at %s", async (value) => {
    const config = await parseOperationalConfig(
      makeEnv({
        MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS: value,
        MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS: value,
      }),
    );

    expect(config.maximumLiveMedianOutputRatioBasisPoints).toBe(Number(value));
    expect(config.maximumLiveOriginalRetainedRateBasisPoints).toBe(Number(value));
  });

  it.each([
    "MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS",
    "MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS",
  ])("rejects an out-of-range basis-point setting %s", async (name) => {
    await expect(parseOperationalConfig(makeEnv({ [name]: "10001" }))).rejects.toThrow(
      /basis points|between 0 and 10000/i,
    );
  });

  it.each([
    ["MAX_LIVE_COST_PER_1000_MICROUSD", ""],
    ["MAX_LIVE_COST_PER_1000_MICROUSD", "0"],
    ["MAX_PROJECTED_MONTHLY_COST_MICROUSD", ""],
    ["MAX_PROJECTED_MONTHLY_COST_MICROUSD", "0"],
  ])("fails closed for a non-zero rollout when %s is %s", async (name, value) => {
    await expect(parseOperationalConfig(makeEnv({ [name]: value }))).rejects.toThrow(/cost/i);
  });

  it("accepts zero cost ceilings only while server rollout is disabled", async () => {
    const config = await parseOperationalConfig(
      makeEnv({
        IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
        MAX_LIVE_COST_PER_1000_MICROUSD: "",
        MAX_PROJECTED_MONTHLY_COST_MICROUSD: "0",
      }),
    );

    expect(config.rolloutPercent).toBe(0);
    expect(config.maximumLiveCostPer1000Microusd).toBe(0);
    expect(config.maximumProjectedMonthlyCostMicrousd).toBe(0);
  });

  it("rejects an unknown or missing live cost coefficient", async () => {
    const unknownModel = { ...makeLiveCostModel(), surpriseCoefficient: 99 };
    const missingModel = makeLiveCostModel();
    Reflect.deleteProperty(missingModel, "queueMillionOperationsMicrousd");

    for (const model of [unknownModel, missingModel]) {
      const json = canonicalJson(model);
      await expect(
        parseOperationalConfig(
          makeEnv({
            LIVE_COST_MODEL_JSON: json,
            LIVE_COST_MODEL_SHA256: sha256Hex(canonicalJson(model)),
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects a live cost model whose configured SHA-256 does not match its canonical JSON", async () => {
    await expect(
      parseOperationalConfig(makeEnv({ LIVE_COST_MODEL_SHA256: "f".repeat(64) })),
    ).rejects.toThrow(/sha-256|hash/i);
  });

  it("rejects non-canonical model JSON even when it is semantically identical", async () => {
    const model = makeLiveCostModel();
    const reversedModel = Object.fromEntries(Object.entries(model).reverse());

    await expect(
      parseOperationalConfig(
        makeEnv({
          LIVE_COST_MODEL_JSON: JSON.stringify(reversedModel, null, 2),
          LIVE_COST_MODEL_SHA256: sha256Hex(canonicalJson(model)),
        }),
      ),
    ).rejects.toThrow(/canonical/i);
  });

  it("rejects region prices whose embedded hash does not match the strict price map", async () => {
    const model = makeLiveCostModel();
    model.containerEgressRegionPricesSha256 = "f".repeat(64);
    const json = canonicalJson(model);

    await expect(
      parseOperationalConfig(
        makeEnv({
          LIVE_COST_MODEL_JSON: json,
          LIVE_COST_MODEL_SHA256: sha256Hex(canonicalJson(model)),
        }),
      ),
    ).rejects.toThrow(/region|hash/i);
  });

  it.each([
    (model: ReturnType<typeof makeLiveCostModel>) => {
      model.arrivalProjection.algorithm = "other" as "arrival-union-tail-v1";
    },
    (model: ReturnType<typeof makeLiveCostModel>) => {
      model.arrivalProjection.steadyHourlyJobs = model.arrivalProjection.steadyHourlyJobs.slice(1);
    },
    (model: ReturnType<typeof makeLiveCostModel>) => {
      model.arrivalProjection.burstyHourlyJobs[0] = -1;
    },
    (model: ReturnType<typeof makeLiveCostModel>) => {
      model.arrivalProjection.sparseHourlyJobs[0] = 1.5;
    },
    (model: ReturnType<typeof makeLiveCostModel>) => {
      model.arrivalProjection.steadyHourlyJobs[0] = 1_000_000_001;
    },
    (model: ReturnType<typeof makeLiveCostModel>) => {
      model.arrivalProjection.scenariosSha256 = "f".repeat(64);
    },
  ])("rejects malformed or drifted arrival projection arrays", async (mutate) => {
    const model = makeLiveCostModel();
    mutate(model);
    const json = canonicalJson(model);

    await expect(
      parseOperationalConfig(
        makeEnv({
          LIVE_COST_MODEL_JSON: json,
          LIVE_COST_MODEL_SHA256: sha256Hex(canonicalJson(model)),
        }),
      ),
    ).rejects.toThrow(/arrival|scenario|hour/i);
  });

  it.each([
    ["PROVIDER_USAGE_SCHEMA_SHA256", "A".repeat(64)],
    ["RELEASE_REPORT_SHA256", "short"],
    ["ENGINE_INSTANCE_NAME", "image-slot-1"],
    ["ENGINE_IMAGE_DIGEST", ""],
  ])("rejects malformed immutable release setting %s", async (name, value) => {
    await expect(parseOperationalConfig(makeEnv({ [name]: value }))).rejects.toThrow();
  });
});

describe("Wrangler source-of-truth and generated environment", () => {
  it("declares only Task 4 bindings with the exact current compatibility settings", () => {
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.local.jsonc", import.meta.url), "utf8"),
    ) as {
      compatibility_date: string;
      compatibility_flags: string[];
      observability?: unknown;
      d1_databases: { binding: string; database_id: string }[];
      r2_buckets: { binding: string }[];
      ratelimits: {
        name: string;
        namespace_id: string;
        simple: { limit: number; period: number };
      }[];
      vars: Record<string, string>;
    };

    expect(config.compatibility_date).toBe("2026-07-16");
    expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(config.observability).toBeUndefined();
    expect(config.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB",
        database_id: "00000000-0000-0000-0000-000000000001",
      }),
    ]);
    expect(config.r2_buckets.map(({ binding }) => binding)).toEqual(["JOB_OBJECTS"]);
    expect(config.ratelimits).toEqual([
      {
        name: "SESSION_JOB_RATE_LIMITER",
        namespace_id: "1001",
        simple: { limit: 20, period: 60 },
      },
      {
        name: "NETWORK_JOB_RATE_LIMITER",
        namespace_id: "1002",
        simple: { limit: 10, period: 60 },
      },
      {
        name: "JOB_READ_RATE_LIMITER",
        namespace_id: "1003",
        simple: { limit: 90, period: 60 },
      },
      {
        name: "RESULT_DOWNLOAD_RATE_LIMITER",
        namespace_id: "1004",
        simple: { limit: 3, period: 60 },
      },
      {
        name: "POLICY_RATE_LIMITER",
        namespace_id: "1005",
        simple: { limit: 60, period: 60 },
      },
      {
        name: "JOB_API_NETWORK_RATE_LIMITER",
        namespace_id: "1006",
        simple: { limit: 180, period: 60 },
      },
    ]);
    expect(JSON.parse(config.vars.APP_ORIGINS ?? "null")).toEqual([
      "http://127.0.0.1:3000",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]);
    expect(JSON.parse(config.vars.MAINTAINER_SESSION_HASHES ?? "null")).toEqual([]);
  });

  it("hardens cleanup tombstones against inconsistent keys and raw error text", () => {
    const migration = readFileSync(
      new URL("../migrations/0001_processing_jobs.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      "CHECK ((input_key IS NULL AND input_exists = 0) OR (input_key IS NOT NULL AND input_exists = 1))",
    );
    expect(migration).toContain(
      "CHECK ((output_key IS NULL AND output_exists = 0) OR (output_key IS NOT NULL AND output_exists = 1))",
    );
    expect(migration).toContain("CHECK (input_exists = 1 OR output_exists = 1)");
    expect(migration).toContain("substr(input_key, 1, 7) = 'inputs/'");
    expect(migration).toContain("length(input_key) = 43");
    expect(migration).toContain("substr(input_key, 16, 1) = '-'");
    expect(migration).toContain("substr(input_key, 21, 1) = '-'");
    expect(migration).toContain("substr(input_key, 26, 1) = '-'");
    expect(migration).toContain("substr(input_key, 31, 1) = '-'");
    expect(migration).toContain("length(replace(substr(input_key, 8), '-', '')) = 32");
    expect(migration).toContain("replace(substr(input_key, 8), '-', '') NOT GLOB '*[^0-9a-f]*'");
    expect(migration).toContain("substr(output_key, 1, 8) = 'outputs/'");
    expect(migration).toContain("length(output_key) = 44");
    expect(migration).toContain("substr(output_key, 17, 1) = '-'");
    expect(migration).toContain("substr(output_key, 22, 1) = '-'");
    expect(migration).toContain("substr(output_key, 27, 1) = '-'");
    expect(migration).toContain("substr(output_key, 32, 1) = '-'");
    expect(migration).toContain("length(replace(substr(output_key, 9), '-', '')) = 32");
    expect(migration).toContain("replace(substr(output_key, 9), '-', '') NOT GLOB '*[^0-9a-f]*'");
    expect(migration).toContain("CHECK (first_failed_at >= 0)");
    expect(migration).toContain("CHECK (next_attempt_at >= 0)");
    expect(migration).toContain("CHECK (attempt_count >= 0)");
    expect(migration).toContain("length(last_error_code) BETWEEN 1 AND 64");
    expect(migration).toContain("last_error_code = upper(last_error_code)");
    expect(migration).toContain("last_error_code NOT GLOB '*[^A-Z0-9_]*'");
  });

  it("enforces canonical tombstone object keys in an actual SQLite database", () => {
    const migrationPath = fileURLToPath(
      new URL("../migrations/0001_processing_jobs.sql", import.meta.url),
    );
    const probe = `
      const { readFileSync } = require("node:fs");
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(":memory:");
      database.exec(readFileSync(process.argv[1], "utf8"));

      const insertInput = database.prepare(
        "INSERT INTO artifact_cleanup_tombstones " +
          "(id, input_key, output_key, input_exists, output_exists, first_failed_at, " +
          "next_attempt_at, attempt_count, last_error_code) " +
          "VALUES (?, ?, NULL, 1, 0, 0, 0, 0, NULL)",
      );
      const insertOutput = database.prepare(
        "INSERT INTO artifact_cleanup_tombstones " +
          "(id, input_key, output_key, input_exists, output_exists, first_failed_at, " +
          "next_attempt_at, attempt_count, last_error_code) " +
          "VALUES (?, NULL, ?, 0, 1, 0, 0, 0, NULL)",
      );
      const uuid = "01234567-89ab-cdef-0123-456789abcdef";
      insertInput.run("valid-input", "inputs/" + uuid);
      insertOutput.run("valid-output", "outputs/" + uuid);

      function expectRejected(statement, id, key) {
        try {
          statement.run(id, key);
        } catch {
          return;
        }
        throw new Error("Accepted invalid tombstone key: " + key);
      }

      const invalidInputKeys = [
        "inputs/" + "-".repeat(36),
        "inputs/" + uuid + "-",
        "inputs/01234567-89ab-cdeg-0123-456789abcdef",
        "inputz/" + uuid,
      ];
      const invalidOutputKeys = [
        "outputs/" + "-".repeat(36),
        "outputs/" + uuid + "-",
        "outputs/01234567-89ab-cdeg-0123-456789abcdef",
        "outputz/" + uuid,
      ];
      invalidInputKeys.forEach((key, index) =>
        expectRejected(insertInput, "invalid-input-" + index, key),
      );
      invalidOutputKeys.forEach((key, index) =>
        expectRejected(insertOutput, "invalid-output-" + index, key),
      );
      database.close();
    `;

    expect(() =>
      execFileSync(process.execPath, ["--no-warnings", "-e", probe, migrationPath], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("keeps generated bindings in sync without inventing future platform resources", () => {
    const generated = readFileSync(new URL("./worker-configuration.d.ts", import.meta.url), "utf8");
    const envSource = readFileSync(new URL("./env.ts", import.meta.url), "utf8");

    for (const binding of [
      "DB",
      "JOB_OBJECTS",
      "SESSION_JOB_RATE_LIMITER",
      "NETWORK_JOB_RATE_LIMITER",
      "JOB_READ_RATE_LIMITER",
      "RESULT_DOWNLOAD_RATE_LIMITER",
      "POLICY_RATE_LIMITER",
      "JOB_API_NETWORK_RATE_LIMITER",
    ]) {
      expect(generated).toContain(`${binding}:`);
    }
    for (const futureBinding of [
      "USAGE_LOGS",
      "IMAGE_JOBS",
      "IMAGE_ENGINE",
      "USAGE_ANALYTICS",
      "WORKER_VERSION",
      "ALERT_EMAIL",
    ]) {
      expect(generated).not.toContain(`${futureBinding}:`);
    }
    expect(envSource).toContain("Cloudflare.Env &");
    expect(envSource).not.toMatch(/interface\s+(?:Env|WranglerGeneratedEnv)\b/);
    expect(envSource).not.toContain("any");
    expect(envSource).not.toContain("as unknown as");
  });
});
