import { imageOptimizePolicyResponseSchema } from "@hereisit/tool-contracts/image-optimize";
import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "../bounded-json";
import { routeRequestWithDependencies } from "../router";
import { getPolicy, type PolicyRouteRuntime, routePolicyRequest } from "./policy";

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
      "authorization, content-type, x-download-lease",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "content-length, content-type, etag, retry-after, x-download-lease",
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
