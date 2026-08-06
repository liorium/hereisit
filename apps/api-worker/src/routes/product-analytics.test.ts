import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "../bounded-json";
import { routeRequestWithDependencies } from "../router";
import type { PolicyRouteRuntime } from "./policy";
import {
  type ProductAnalyticsRouteRuntime,
  routeProductAnalyticsRequest,
} from "./product-analytics";

const allowedOrigin = "https://hereisit.pages.dev";

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema: "product-usage@1",
    toolId: "image.compress",
    event: "processing-succeeded",
    duration: "1-3s",
    ...overrides,
  };
}

function request(body: unknown = validEvent(), init: { method?: string; ip?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: allowedOrigin });
  if (init.ip !== null) headers.set("cf-connecting-ip", init.ip ?? "192.0.2.1");
  return new Request("https://api.example/v1/analytics/events", {
    method: init.method ?? "POST",
    headers,
    ...(init.method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

function makeRuntime(
  overrides: Partial<ProductAnalyticsRouteRuntime> = {},
): ProductAnalyticsRouteRuntime {
  return {
    environment: "staging",
    currentSecret: "current-secret",
    previousSecret: "previous-secret",
    versionId: "123e4567-e89b-42d3-a456-426614174000",
    releaseSha256: "a".repeat(64),
    rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    readJson: readBoundedJson,
    hashNetwork: vi.fn(async () => ({ writeHash: "daily-hmac" })),
    writePoint: vi.fn(),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    ...overrides,
  };
}

function streamingRequest(byteLength: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(byteLength).fill(32));
      controller.close();
    },
  });
  return new Request("https://api.example/v1/analytics/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: allowedOrigin,
      "cf-connecting-ip": "192.0.2.1",
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("product analytics route", () => {
  it("rejects non-POST requests without rate limiting", async () => {
    const runtime = makeRuntime();
    const response = await routeProductAnalyticsRequest(
      request(undefined, { method: "GET" }),
      runtime,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    expect(runtime.rateLimiter.limit).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid network without writing", async () => {
    const missingRuntime = makeRuntime();
    expect(
      (await routeProductAnalyticsRequest(request(validEvent(), { ip: null }), missingRuntime))
        .status,
    ).toBe(400);
    expect(missingRuntime.writePoint).not.toHaveBeenCalled();

    const invalidRuntime = makeRuntime({
      hashNetwork: vi.fn(async () => {
        throw new TypeError("invalid network");
      }),
    });
    expect((await routeProductAnalyticsRequest(request(), invalidRuntime)).status).toBe(400);
    expect(invalidRuntime.writePoint).not.toHaveBeenCalled();
  });

  it("rejects a streamed 513-byte body", async () => {
    const runtime = makeRuntime();
    const response = await routeProductAnalyticsRequest(streamingRequest(513), runtime);

    expect(response.status).toBe(413);
    expect(runtime.writePoint).not.toHaveBeenCalled();
  });

  it.each([
    ["an incomplete event", { schema: "product-usage@1" }],
    ["an extra field", validEvent({ filename: "private.png" })],
    ["a planned tool", validEvent({ toolId: "media.video-compress" })],
  ])("rejects %s", async (_label, body) => {
    const runtime = makeRuntime();
    const response = await routeProductAnalyticsRequest(request(body), runtime);

    expect(response.status).toBe(400);
    expect(runtime.writePoint).not.toHaveBeenCalled();
  });

  it("returns 429 with a retry hint when the network limit is exhausted", async () => {
    const runtime = makeRuntime({
      rateLimiter: { limit: vi.fn(async () => ({ success: false })) },
    });
    const response = await routeProductAnalyticsRequest(request(), runtime);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(runtime.writePoint).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when the dataset write fails", async () => {
    const runtime = makeRuntime({
      writePoint: vi.fn(() => {
        throw new Error("dataset detail");
      }),
    });
    const response = await routeProductAnalyticsRequest(request(), runtime);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "ANALYTICS_UNAVAILABLE" });
  });

  it("rate-limits by a transient HMAC and writes only allowlisted fields", async () => {
    const runtime = makeRuntime();
    const response = await routeProductAnalyticsRequest(request(), runtime);

    expect(response.status).toBe(204);
    expect(runtime.hashNetwork).toHaveBeenCalledWith({
      ip: "192.0.2.1",
      utcDay: "2026-08-06",
      currentSecret: "current-secret",
      previousSecret: "previous-secret",
    });
    expect(runtime.rateLimiter.limit).toHaveBeenCalledWith({ key: "daily-hmac" });
    expect(runtime.writePoint).toHaveBeenCalledWith({
      environment: "staging",
      toolId: "image.compress",
      event: "processing-succeeded",
      duration: "1-3s",
      versionId: "123e4567-e89b-42d3-a456-426614174000",
      releaseSha256: "a".repeat(64),
    });
  });
});

describe("product analytics CORS boundary", () => {
  const policyRuntime = {
    config: { appOrigins: [new URL(allowedOrigin)] },
  } as unknown as PolicyRouteRuntime;

  it("requires an exact Origin before invoking analytics", async () => {
    const runtime = makeRuntime();
    const noOrigin = request();
    noOrigin.headers.delete("origin");
    const response = await routeRequestWithDependencies(noOrigin, policyRuntime, {
      analytics: runtime,
    });

    expect(response.status).toBe(403);
    expect(runtime.writePoint).not.toHaveBeenCalled();
  });

  it("accepts an exact configured Origin", async () => {
    const runtime = makeRuntime();
    const response = await routeRequestWithDependencies(request(), policyRuntime, {
      analytics: runtime,
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
  });
});
