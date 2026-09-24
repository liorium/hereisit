import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkProductionHealth,
  runProductionHealthCheck,
} from "../scripts/check-production-health.mjs";

const serverPolicy = {
  contract: "tool-job@1",
  toolContract: "image.optimize@1",
  execution: "server",
  reason: null,
  maintainer: false,
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
  limits: { maxFiles: 20, maxBytesPerFile: 31_457_280, maxPixelsPerFile: 40_000_000 },
};

function healthyResponse(url: string) {
  if (url.endsWith("/v1/policy")) return Response.json(serverPolicy);
  if (url.includes("/health")) {
    return Response.json({ status: "ok", buildId: "test-build", serverJobsEnabled: true });
  }
  return new Response("<!doctype html><title>HereIsIt</title>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("production readiness monitor", () => {
  it("ends a real stalled JSON body before the external watchdog", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", "tests/fixtures/production-readiness-stall.mjs"],
      { timeout: 14_000 },
    );
    const result = JSON.parse(stdout);
    expect(result.watchdogFired).toBe(false);
    expect(result.check).toMatchObject({ ok: false, status: 200, code: "INVALID_RESPONSE" });
  }, 15_000);

  it.each([
    true,
    false,
  ])("returns the CI exit code and writes a safe summary (healthy: %s)", async (healthy) => {
    const directory = await mkdtemp(join(tmpdir(), "production-health-"));
    const summaryPath = join(directory, "summary.md");
    let output = "";
    try {
      const exitCode = await runProductionHealthCheck({
        fetchImpl: async (url: string) =>
          !healthy && url.endsWith("/v1/policy")
            ? new Response("private-secret-value", { status: 503 })
            : healthyResponse(url),
        stdout: {
          write: (chunk: string) => {
            output += chunk;
          },
        },
        summaryPath,
      });
      expect(exitCode).toBe(healthy ? 0 : 1);
      expect(JSON.parse(output).healthy).toBe(healthy);
      const summary = await readFile(summaryPath, "utf8");
      expect(summary).toContain(
        healthy ? "anonymous-image-policy: PASS" : "anonymous-image-policy: HTTP_ERROR",
      );
      expect(output + summary).not.toContain("private-secret-value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks public availability and anonymous admission without creating or uploading jobs", async () => {
    const requests: { url: string; method: string }[] = [];
    const report = await checkProductionHealth({
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method ?? "GET" });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        if (url.endsWith("/v1/policy")) {
          expect(new Headers(init.headers).get("origin")).toBe("https://hereisit.app");
          expect(JSON.parse(String(init.body))).toMatchObject({
            contract: "tool-job@1",
            toolContract: "image.optimize@1",
            anonymousSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          });
        }
        return healthyResponse(url);
      },
    });
    expect(report.healthy).toBe(true);
    expect(report.checks).toHaveLength(4);
    expect(requests).toEqual([
      { url: "https://hereisit.app/", method: "GET" },
      { url: "https://hereisit.app/image/compress", method: "GET" },
      { url: "https://api.hereisit.app/health?requireJobs=1", method: "GET" },
      { url: "https://api.hereisit.app/v1/policy", method: "POST" },
    ]);
  });

  it("detects a closed anonymous policy even when API health returns 200", async () => {
    const report = await checkProductionHealth({
      fetchImpl: async (url: string) =>
        url.endsWith("/v1/policy")
          ? Response.json({
              ...serverPolicy,
              execution: "local",
              reason: "SERVER_PROCESSING_DISABLED",
              disclosure: {
                upload: false,
                inputDeletion: "not-uploaded",
                resultDeletion: { mode: "not-uploaded" },
              },
            })
          : healthyResponse(url),
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.filter((check) => !check.ok)).toEqual([
      {
        name: "anonymous-image-policy",
        ok: false,
        status: 200,
        code: "SERVER_PROCESSING_DISABLED",
      },
    ]);
  });

  it.each([
    { ...serverPolicy, maintainer: true },
    { ...serverPolicy, disclosure: { upload: false } },
    { ...serverPolicy, reason: "private-secret-value" },
  ])("does not accept malformed or maintainer-only policy as public readiness", async (policy) => {
    const report = await checkProductionHealth({
      fetchImpl: async (url: string) =>
        url.endsWith("/v1/policy") ? Response.json(policy) : healthyResponse(url),
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.at(-1)?.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-secret-value");
  });

  it("reports HTTP failure without leaking response contents", async () => {
    const report = await checkProductionHealth({
      fetchImpl: async (url: string) =>
        url.includes("/health")
          ? new Response("private-secret-value", { status: 503 })
          : healthyResponse(url),
    });
    expect(report.healthy).toBe(false);
    expect(report.checks[2]).toEqual({
      name: "api-job-readiness",
      ok: false,
      status: 503,
      code: "HTTP_ERROR",
    });
    expect(JSON.stringify(report)).not.toContain("private-secret-value");
  });

  it("treats a network failure as unhealthy and still reports the other checks", async () => {
    const report = await checkProductionHealth({
      fetchImpl: async (url: string) => {
        if (url.endsWith("/image/compress")) throw new Error("private-secret-value");
        return healthyResponse(url);
      },
    });
    expect(report.healthy).toBe(false);
    expect(report.checks).toHaveLength(4);
    expect(report.checks[1]).toEqual({
      name: "image-compress-page",
      ok: false,
      status: null,
      code: "REQUEST_FAILED",
    });
    expect(JSON.stringify(report)).not.toContain("private-secret-value");
  });

  it("rejects non-HTML pages and an API body claiming jobs are disabled", async () => {
    const report = await checkProductionHealth({
      fetchImpl: async (url: string) =>
        url.endsWith("/")
          ? Response.json({ status: "ok" })
          : url.includes("/health")
            ? Response.json({ status: "ok", serverJobsEnabled: false })
            : healthyResponse(url),
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "home-page",
      "api-job-readiness",
    ]);
  });

  it("bounds JSON response consumption and cancels oversized bodies", async () => {
    let cancelled = false;
    const report = await checkProductionHealth({
      fetchImpl: async (url: string) =>
        url.endsWith("/v1/policy")
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(65_537));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : healthyResponse(url),
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.at(-1)?.code).toBe("INVALID_RESPONSE");
    expect(cancelled).toBe(true);
  });
});
