import { imageOptimizePolicyResponseSchema } from "@hereisit/tool-contracts/image-optimize";
import { pdfOptimizePolicyResponseSchema } from "@hereisit/tool-contracts/pdf-optimize";
import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "../bounded-json";
import { routeRequestWithDependencies } from "../router";
import {
  getPolicy,
  type PolicyRouteRuntime,
  readPolicyStateFromD1,
  routePolicyRequest,
} from "./policy";

const currentSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString(
  "base64url",
);
const previousSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString(
  "base64url",
);
const anonymousSessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const allowedOrigin = "https://app.example";
const fixedNow = new Date("2026-07-16T12:00:00.000Z");

function policyBody(sessionId = anonymousSessionId) {
  return {
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId: sessionId,
  };
}

function pdfPolicyBody(sessionId = "123e4567-e89b-42d3-a456-426614174000") {
  return {
    contract: "tool-job@1",
    toolContract: "pdf.optimize@1",
    anonymousSessionId: sessionId,
  };
}

function policyRequest(
  body: unknown = policyBody(),
  init: {
    origin?: string;
    ip?: string;
    url?: string;
  } = {},
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "cf-connecting-ip": init.ip ?? "203.0.113.77",
  });
  if (init.origin !== undefined) {
    headers.set("origin", init.origin);
  }
  return new Request(init.url ?? "https://api.example/v1/policy", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makePolicyConfig(overrides: Record<string, unknown> = {}) {
  return {
    appOrigins: [new URL(allowedOrigin)],
    rolloutPercent: 100,
    accountDailyWeightedUnitLimit: 10_000_000,
    anonymousDailyWeightedUnitLimit: 1_000_000,
    networkDailyWeightedUnitLimit: 3_000_000,
    accountPendingJobLimit: 10,
    networkPendingJobLimit: 3,
    maximumQueuedAgeSeconds: 600,
    maintainerSessionHashes: new Set<string>(),
    pdfPublicAdmissionEnabled: false,
    ...overrides,
  };
}

function availableState(overrides: Record<string, unknown> = {}) {
  return {
    circuitClosed: true,
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
    ...overrides,
  };
}

function policyAggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    circuit_open: 0,
    account_reserved: 0,
    account_settled: 0,
    account_pending: 0,
    anonymous_reserved: 0,
    anonymous_settled: 0,
    anonymous_active: 0,
    network_reserved: 0,
    network_settled: 0,
    network_pending: 0,
    oldest_queued_at: null,
    ...overrides,
  };
}

function makePolicyDatabase(row: ReturnType<typeof policyAggregateRow>) {
  const capture: {
    bindings: unknown[];
    constraint: string | undefined;
    sql: string;
  } = {
    bindings: [],
    constraint: undefined,
    sql: "",
  };
  const statement = {
    bind: (...bindings: unknown[]) => {
      capture.bindings = bindings;
      return statement;
    },
    first: async <T>() => row as T,
  };
  const withSession = vi.fn((constraint?: string) => {
    capture.constraint = constraint;
    return {
      prepare: (sql: string) => {
        capture.sql = sql;
        return statement;
      },
    };
  });
  const database = new Proxy({} as D1Database, {
    get: (_target, property) => {
      if (property === "withSession") {
        return withSession;
      }
      throw new Error(`Unexpected D1 database property: ${String(property)}`);
    },
  });
  return { capture, database };
}

function policyStateQuery(overrides: Record<string, unknown> = {}) {
  return {
    utcDay: "2026-07-16",
    nowEpochMilliseconds: fixedNow.valueOf(),
    sessionHash: "a".repeat(64),
    dailyQuotaHashes: ["b".repeat(64), "c".repeat(64)],
    pendingHashes: ["b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)],
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<PolicyRouteRuntime> = {}): PolicyRouteRuntime {
  return {
    config: makePolicyConfig(),
    currentSecret,
    previousSecret,
    policyRateLimiter: {
      limit: vi.fn(async () => ({ success: true })),
    },
    readState: vi.fn(async () => availableState()),
    readJson: readBoundedJson,
    now: () => fixedNow,
    timeoutMilliseconds: 100,
    ...overrides,
  };
}

async function expectLocalPolicy(
  response: Response,
  reason: "SERVER_PROCESSING_DISABLED" | "LOCAL_FALLBACK_REQUIRED",
) {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    execution: "local",
    reason,
    maintainer: false,
    disclosure: {
      upload: false,
      inputDeletion: "not-uploaded",
      resultDeletion: { mode: "not-uploaded" },
    },
  });
}

describe("deterministic image optimization policy", () => {
  it("returns one deterministic server execution policy per session", async () => {
    const request = policyRequest();
    const response = await getPolicy(request, {
      rolloutPercent: 100,
      accountDailyWeightedUnitLimit: 10_000_000,
      anonymousDailyWeightedUnitLimit: 1_000_000,
      networkDailyWeightedUnitLimit: 3_000_000,
    });

    await expect(response.json()).resolves.toEqual({
      contract: "tool-job@1",
      toolContract: "image.optimize@1",
      maintainer: false,
      execution: "server",
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
      limits: {
        maxFiles: 20,
        maxBytesPerFile: 31_457_280,
        maxPixelsPerFile: 40_000_000,
      },
    });
  });

  it("keeps the reviewed public limits contract while concurrency remains internal", async () => {
    const response = await getPolicy(policyRequest(), {
      rolloutPercent: 100,
      accountDailyWeightedUnitLimit: 10_000_000,
      anonymousDailyWeightedUnitLimit: 1_000_000,
      networkDailyWeightedUnitLimit: 3_000_000,
    });
    const payload = imageOptimizePolicyResponseSchema.parse(await response.json());

    expect(payload.limits).not.toHaveProperty("maxConcurrentPerAnonymousSession");
  });

  it("returns the same cohort decision for repeated requests from a session", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const response = await getPolicy(policyRequest(), {
          rolloutPercent: 37,
          accountDailyWeightedUnitLimit: 10_000_000,
          anonymousDailyWeightedUnitLimit: 1_000_000,
          networkDailyWeightedUnitLimit: 3_000_000,
        });
        return imageOptimizePolicyResponseSchema.parse(await response.json()).execution;
      }),
    );

    expect(new Set(decisions).size).toBe(1);
  });

  it("allows a maintainer cohort to bypass rollout percentage but not global controls", async () => {
    const sessionHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(anonymousSessionId),
    );
    const maintainerHash = Array.from(new Uint8Array(sessionHash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const runtime = makeRuntime({
      config: makePolicyConfig({
        rolloutPercent: 0,
        maintainerSessionHashes: new Set([maintainerHash]),
      }),
    });

    const response = await routePolicyRequest(policyRequest(), runtime);
    await expect(response.json()).resolves.toMatchObject({
      maintainer: true,
      execution: "server",
      reason: null,
    });

    const circuitResponse = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        config: runtime.config,
        readState: vi.fn(async () => availableState({ circuitClosed: false })),
      }),
    );
    const payload = await circuitResponse.json();
    expect(payload).toMatchObject({
      maintainer: true,
      execution: "local",
      reason: "SERVER_PROCESSING_DISABLED",
    });
  });

  it.each([
    ["account budget", { accountDailyWeightedUnitLimit: 0 }],
    ["anonymous budget", { anonymousDailyWeightedUnitLimit: 0 }],
    ["network budget", { networkDailyWeightedUnitLimit: 0 }],
  ])("reports server processing disabled for a non-positive %s", async (_label, configOverride) => {
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({ config: makePolicyConfig(configOverride) }),
    );

    await expectLocalPolicy(response, "SERVER_PROCESSING_DISABLED");
  });

  it("reports server processing disabled when the circuit is open", async () => {
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        readState: vi.fn(async () => availableState({ circuitClosed: false })),
      }),
    );

    await expectLocalPolicy(response, "SERVER_PROCESSING_DISABLED");
  });

  it.each([
    ["account quota", { accountReservedToday: 10_000_000 }],
    ["anonymous quota", { anonymousSettledToday: 1_000_000 }],
    ["network quota", { networkReservedToday: 3_000_000 }],
    ["active anonymous job", { activeJobs: 1 }],
    ["network pending cap", { networkPendingJobs: 3 }],
    ["account pending cap", { accountPendingJobs: 10 }],
    ["queue age", { oldestQueuedAgeSeconds: 601 }],
  ])("falls back locally without exposing exhausted %s values", async (_label, stateOverride) => {
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        readState: vi.fn(async () => availableState(stateOverride)),
      }),
    );
    const payload = await response.json();

    expect(payload).toMatchObject({
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
    });
    expect(JSON.stringify(payload)).not.toMatch(/10000000|3000000|601/);
  });
});

describe("deterministic PDF optimization policy", () => {
  it("fails local before state lookup for a job-token-shaped PDF browser session", async () => {
    const runtime = makeRuntime({
      readJson: vi.fn(async () => pdfPolicyBody("a".repeat(43))),
    });
    const response = await routePolicyRequest(policyRequest(), runtime);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      toolContract: "image.optimize@1",
      execution: "local",
    });
    expect(runtime.readState).not.toHaveBeenCalled();
  });

  it("advertises the exact PDF limits only to maintainers", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const response = await getPolicy(policyRequest(pdfPolicyBody()), {
      rolloutPercent: 100,
      accountDailyWeightedUnitLimit: 10_000_000,
      anonymousDailyWeightedUnitLimit: 1_000_000,
      networkDailyWeightedUnitLimit: 3_000_000,
      maintainerSessionHashes: new Set([hash]),
    });

    expect(pdfOptimizePolicyResponseSchema.parse(await response.json())).toEqual({
      contract: "tool-job@1",
      toolContract: "pdf.optimize@1",
      maintainer: true,
      execution: "server",
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
      limits: { maxFiles: 1, maxBytesPerFile: 50 * 1024 * 1024, maxPagesPerFile: 100 },
    });
  });

  it("keeps non-maintainer PDF requests local even at full image rollout", async () => {
    const response = await getPolicy(policyRequest(pdfPolicyBody()), {
      rolloutPercent: 100,
      accountDailyWeightedUnitLimit: 10_000_000,
      anonymousDailyWeightedUnitLimit: 1_000_000,
      networkDailyWeightedUnitLimit: 3_000_000,
    });
    expect(pdfOptimizePolicyResponseSchema.parse(await response.json())).toMatchObject({
      toolContract: "pdf.optimize@1",
      maintainer: false,
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
    });
  });

  it("admits a non-maintainer PDF request only when the release-bound public gate is enabled", async () => {
    const response = await getPolicy(policyRequest(pdfPolicyBody()), {
      rolloutPercent: 100,
      accountDailyWeightedUnitLimit: 10_000_000,
      anonymousDailyWeightedUnitLimit: 1_000_000,
      networkDailyWeightedUnitLimit: 3_000_000,
      pdfPublicAdmissionEnabled: true,
    });

    expect(pdfOptimizePolicyResponseSchema.parse(await response.json())).toMatchObject({
      toolContract: "pdf.optimize@1",
      maintainer: false,
      execution: "server",
      reason: null,
    });
  });
});

describe("policy rate limiting and fail-closed ordering", () => {
  it("calls the network rate limiter before body parsing and D1 state", async () => {
    const events: string[] = [];
    const runtime = makeRuntime({
      policyRateLimiter: {
        limit: vi.fn(async () => {
          events.push("rate-limit");
          return { success: true };
        }),
      },
      readJson: async (request, maximumBytes) => {
        events.push(`parse:${maximumBytes}`);
        return readBoundedJson(request, maximumBytes);
      },
      readState: vi.fn(async () => {
        events.push("d1");
        return availableState();
      }),
    });

    const response = await routePolicyRequest(policyRequest(), runtime);

    expect(response.status).toBe(200);
    expect(events).toEqual(["rate-limit", "parse:16384", "d1"]);
  });

  it("returns local before parsing or D1 when the limiter denies the network", async () => {
    const readJson = vi.fn(readBoundedJson);
    const readState = vi.fn(async () => availableState());
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        policyRateLimiter: { limit: vi.fn(async () => ({ success: false })) },
        readJson,
        readState,
      }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
      disclosure: {
        upload: false,
        inputDeletion: "not-uploaded",
        resultDeletion: { mode: "not-uploaded" },
      },
    });
    expect(response.headers.get("retry-after")).toBe("60");
    expect(readJson).not.toHaveBeenCalled();
    expect(readState).not.toHaveBeenCalled();
  });

  it.each([
    ["", previousSecret],
    ["not-base64url", previousSecret],
    [currentSecret, ""],
    [currentSecret, "not-base64url"],
  ])("uses a constant limiter key and returns local for malformed abuse secrets", async (malformedCurrent, malformedPrevious) => {
    const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
    const readJson = vi.fn(readBoundedJson);
    const readState = vi.fn(async () => availableState());
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        currentSecret: malformedCurrent,
        previousSecret: malformedPrevious,
        policyRateLimiter: { limit },
        readJson,
        readState,
      }),
    );

    await expectLocalPolicy(response, "LOCAL_FALLBACK_REQUIRED");
    expect(limit).toHaveBeenCalledWith({ key: "invalid-network-secret" });
    expect(readJson).not.toHaveBeenCalled();
    expect(readState).not.toHaveBeenCalled();
  });

  it("uses the same fail-closed key for absent or malformed network addresses", async () => {
    for (const ip of ["", "not-an-ip"]) {
      const limit = vi.fn(async () => ({ success: true }));
      const request = policyRequest();
      if (ip === "") {
        request.headers.delete("cf-connecting-ip");
      } else {
        request.headers.set("cf-connecting-ip", ip);
      }
      const response = await routePolicyRequest(
        request,
        makeRuntime({ policyRateLimiter: { limit } }),
      );

      await expectLocalPolicy(response, "LOCAL_FALLBACK_REQUIRED");
      expect(limit).toHaveBeenCalledWith({ key: "invalid-network-secret" });
    }
  });

  it("keys the best-effort edge fence by HMAC network prefix, never random session IDs", async () => {
    const keys: string[] = [];
    const runtime = makeRuntime({
      policyRateLimiter: {
        limit: vi.fn(async ({ key }) => {
          keys.push(key);
          return { success: true };
        }),
      },
    });

    for (let index = 0; index < 5; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      await routePolicyRequest(
        policyRequest(policyBody(`018f47a2-65d4-7f31-a377-${suffix}`)),
        runtime,
      );
    }

    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    () => Promise.reject(new Error("D1 unavailable")),
    () => new Promise<never>(() => {}),
  ])("returns an explicit local policy for a D1 error or timeout", async (readState) => {
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        readState,
        timeoutMilliseconds: 5,
      }),
    );

    await expectLocalPolicy(response, "LOCAL_FALLBACK_REQUIRED");
  });

  it("preserves a hashed maintainer decision when D1 fails closed", async () => {
    const sessionHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(anonymousSessionId),
    );
    const maintainerHash = Array.from(new Uint8Array(sessionHash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const response = await routePolicyRequest(
      policyRequest(),
      makeRuntime({
        config: makePolicyConfig({
          maintainerSessionHashes: new Set([maintainerHash]),
        }),
        readState: async () => {
          throw new Error("D1 unavailable");
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
      maintainer: true,
    });
  });

  it.each([
    { ...policyBody(), anonymousSessionId: "not-a-uuid" },
    { ...policyBody(), unknown: true },
    [],
  ])("returns local without D1 for malformed policy JSON", async (body) => {
    const readState = vi.fn(async () => availableState());
    const response = await routePolicyRequest(policyRequest(body), makeRuntime({ readState }));

    await expectLocalPolicy(response, "LOCAL_FALLBACK_REQUIRED");
    expect(readState).not.toHaveBeenCalled();
  });

  it("passes only HMAC/SHA-256 values, never raw network or session data, to dependencies", async () => {
    const rawIp = "203.0.113.77";
    const rawSession = anonymousSessionId;
    const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
    const readState = vi.fn(async () => availableState());
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await routePolicyRequest(
      policyRequest(policyBody(rawSession), { ip: rawIp }),
      makeRuntime({
        policyRateLimiter: { limit },
        readState,
      }),
    );

    const limiterArguments = JSON.stringify(limit.mock.calls);
    const stateArguments = JSON.stringify(readState.mock.calls);
    expect(limiterArguments).not.toContain(rawIp);
    expect(limiterArguments).not.toContain("203.0.113.0");
    expect(limit.mock.calls[0]?.[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(stateArguments).not.toContain(rawIp);
    expect(stateArguments).not.toContain(rawSession);
    expect(stateArguments).not.toContain("203.0.113.0");
    expect(stateArguments).not.toContain("jobToken");
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("passes the exact current epoch milliseconds to the D1 state adapter", async () => {
    const readState = vi.fn(async (_query: Parameters<PolicyRouteRuntime["readState"]>[0]) =>
      availableState(),
    );

    await routePolicyRequest(policyRequest(), makeRuntime({ readState }));

    const query = readState.mock.calls[0]?.[0];
    expect(query).toMatchObject({
      utcDay: "2026-07-16",
      nowEpochMilliseconds: fixedNow.valueOf(),
    });
    expect(query).not.toHaveProperty("nowEpochSeconds");
  });
});

describe("D1 policy state adapter", () => {
  it("keeps daily units day-scoped while carrying pending and active jobs across midnight", async () => {
    const { capture, database } = makePolicyDatabase(
      policyAggregateRow({
        account_reserved: 11,
        account_settled: 12,
        account_pending: 13,
        anonymous_reserved: 21,
        anonymous_settled: 22,
        anonymous_active: 1,
        network_reserved: 31,
        network_settled: 32,
        network_pending: 33,
      }),
    );
    const query = policyStateQuery();

    const state = await readPolicyStateFromD1(database, query);
    const compactSql = capture.sql.replace(/\s+/g, " ");

    expect(capture.constraint).toBe("first-primary");
    expect(compactSql).toContain("SELECT reserved_units FROM account_usage WHERE day_key = ?");
    expect(compactSql).toContain("SELECT settled_units FROM account_usage WHERE day_key = ?");
    expect(compactSql).toContain("SELECT SUM(pending_jobs) FROM account_usage");
    expect(compactSql).not.toContain(
      "SELECT SUM(pending_jobs) FROM account_usage WHERE day_key = ?",
    );
    expect(compactSql).toContain(
      "SELECT reserved_units FROM anonymous_usage WHERE session_hash = ? AND day_key = ?",
    );
    expect(compactSql).toContain(
      "SELECT settled_units FROM anonymous_usage WHERE session_hash = ? AND day_key = ?",
    );
    expect(compactSql).toContain(
      "SELECT SUM(active_jobs) FROM anonymous_usage WHERE session_hash = ?",
    );
    expect(compactSql).not.toContain(
      "SELECT SUM(active_jobs) FROM anonymous_usage WHERE session_hash = ? AND day_key = ?",
    );
    expect(compactSql).toContain(
      "SELECT SUM(pending_jobs) FROM network_usage WHERE network_hash IN",
    );
    expect(capture.bindings).toEqual([
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
    ]);
    expect(state).toMatchObject({
      accountReservedToday: 11,
      accountSettledToday: 12,
      accountPendingJobs: 13,
      anonymousReservedToday: 21,
      anonymousSettledToday: 22,
      activeJobs: 1,
      networkReservedToday: 31,
      networkSettledToday: 32,
      networkPendingJobs: 33,
    });
  });

  it("converts a 601-second-old millisecond timestamp with floor semantics", async () => {
    const { database } = makePolicyDatabase(
      policyAggregateRow({
        oldest_queued_at: fixedNow.valueOf() - 601_000,
      }),
    );

    await expect(readPolicyStateFromD1(database, policyStateQuery())).resolves.toMatchObject({
      oldestQueuedAgeSeconds: 601,
    });
  });

  it("rejects an oldest queued timestamp from the future", async () => {
    const { database } = makePolicyDatabase(
      policyAggregateRow({
        oldest_queued_at: fixedNow.valueOf() + 1,
      }),
    );

    await expect(readPolicyStateFromD1(database, policyStateQuery())).rejects.toThrow(/future/i);
  });
});

describe("exact routing and CORS", () => {
  it("returns exact CORS headers for a configured Origin", async () => {
    const response = await routeRequestWithDependencies(
      policyRequest(policyBody(), { origin: allowedOrigin }),
      makeRuntime(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, digest, x-download-lease",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "content-length, content-type, digest, etag, retry-after, x-download-lease, x-hereisit-rate-limit-scope",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("answers an allowed preflight without invoking the policy route", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const request = new Request("https://api.example/v1/policy", {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
      },
    });
    const response = await routeRequestWithDependencies(
      request,
      makeRuntime({ policyRateLimiter: { limit } }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(limit).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example",
    "null",
    "https://app.example/",
    "https://APP.example",
    "not an origin",
  ])("rejects every non-exact or malformed Origin with 403: %s", async (origin) => {
    const response = await routeRequestWithDependencies(
      policyRequest(policyBody(), { origin }),
      makeRuntime(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it.each([
    "https://api.example/v1/policy/018f47a2-65d4-7f31-a377-5afbb8f53f27",
    "https://api.example/v1/policy?anonymousSessionId=018f47a2-65d4-7f31-a377-5afbb8f53f27",
    "https://api.example/v1/unknown",
  ])("never accepts a session identifier or unknown route in the URL: %s", async (url) => {
    const limit = vi.fn(async () => ({ success: true }));
    const response = await routeRequestWithDependencies(
      policyRequest(policyBody(), { url, origin: allowedOrigin }),
      makeRuntime({ policyRateLimiter: { limit } }),
    );

    expect(response.status).toBe(404);
    expect(limit).not.toHaveBeenCalled();
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects non-POST policy methods without reading a body", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const request = new Request("https://api.example/v1/policy", {
      method: "GET",
      headers: { origin: allowedOrigin },
    });
    const response = await routeRequestWithDependencies(
      request,
      makeRuntime({ policyRateLimiter: { limit } }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    expect(limit).not.toHaveBeenCalled();
  });
});
