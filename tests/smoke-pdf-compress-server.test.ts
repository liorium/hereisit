import { describe, expect, it } from "vitest";
import {
  pdfOptimizeCreateResponseSchema,
  pdfOptimizePolicyResponseSchema,
  pdfOptimizeStatusResponseSchema,
} from "../packages/tool-contracts/src/pdf-optimize";
import {
  createPdfSmokeResult,
  runPdfSmokeLifecycle,
  validatePdfSmokeTrace,
} from "../scripts/smoke-pdf-compress-server.mjs";

const digest = `sha-256=${Buffer.alloc(32, 7).toString("base64")}`;

describe("native PDF server smoke", () => {
  it("accepts only the authenticated exact-length lifecycle with deletion and queue isolation", () => {
    const result = createPdfSmokeResult({
      sourceBytes: 1000,
      outputBytes: 800,
      profile: "structural",
      visualVerified: false,
      trace: [
        { method: "POST", path: "/v1/policy", status: 200 },
        { method: "POST", path: "/v1/jobs", status: 201 },
        { method: "PUT", path: "/v1/jobs/[job]/input", status: 204, contentLength: 1000, digest },
        { method: "GET", path: "/v1/jobs/[job]", status: 200 },
        { method: "GET", path: "/v1/jobs/[job]/result", status: 200 },
        { method: "POST", path: "/v1/jobs/[job]/downloaded", status: 204 },
        { method: "DELETE", path: "/v1/jobs/[job]", status: 204 },
      ],
      queues: { image: "paused", imageDlq: "paused", pdf: "resumed", pdfDlq: "paused" },
      sweepPassed: true,
    });

    expect(validatePdfSmokeTrace(result)).toEqual(result);
    expect(result).toMatchObject({
      passed: true,
      exactLengthUpload: true,
      digestVerified: true,
      deleted: true,
      queueIsolation: true,
      visualVerified: false,
      publicAdmissionReady: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/filename|presigned|objectKey|contents/i);
  });

  it.each([
    ["missing delete", { removePath: "/v1/jobs/[job]" }],
    ["missing digest", { removeDigest: true }],
    ["image queue resumed", { imageQueue: "resumed" }],
    ["false visual admission", { visualVerified: false, publicAdmissionReady: true }],
  ])("rejects %s", (_label, mutation) => {
    expect(() =>
      validatePdfSmokeTrace({
        schema: "hereisit-processing-pdf-smoke@1",
        version: 1,
        passed: true,
        sourceBytes: 1000,
        outputBytes: 800,
        profile: "image-optimized",
        visualVerified: mutation.visualVerified ?? true,
        publicAdmissionReady: mutation.publicAdmissionReady ?? true,
        exactLengthUpload: true,
        digestVerified: true,
        downloadedAcknowledged: true,
        deleted: true,
        sweepPassed: true,
        queueIsolation: true,
        queues: {
          image: mutation.imageQueue ?? "paused",
          imageDlq: "paused",
          pdf: "resumed",
          pdfDlq: "paused",
        },
        trace: [
          { method: "POST", path: "/v1/policy", status: 200 },
          { method: "POST", path: "/v1/jobs", status: 201 },
          {
            method: "PUT",
            path: "/v1/jobs/[job]/input",
            status: 204,
            contentLength: 1000,
            ...(mutation.removeDigest ? {} : { digest }),
          },
          { method: "GET", path: "/v1/jobs/[job]", status: 200 },
          { method: "GET", path: "/v1/jobs/[job]/result", status: 200 },
          { method: "POST", path: "/v1/jobs/[job]/downloaded", status: 204 },
          ...(mutation.removePath === "/v1/jobs/[job]"
            ? []
            : [{ method: "DELETE", path: "/v1/jobs/[job]", status: 204 }]),
        ],
      }),
    ).toThrow();
  });

  it("executes the authenticated lifecycle without exposing a filename", async () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const resultBytes = new TextEncoder().encode("%PDF-1.7\nsmall\n%%EOF\n");
    const resultDigest = `sha-256=${Buffer.from(
      await crypto.subtle.digest("SHA-256", resultBytes),
    ).toString("base64")}`;
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const json = (body: unknown, status = 200, includeLength = true) =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers:
          body === null
            ? undefined
            : {
                "content-type": "application/json",
                ...(includeLength
                  ? { "content-length": String(Buffer.byteLength(JSON.stringify(body))) }
                  : {}),
              },
      });
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (path === "/v1/policy")
        return json(
          {
            contract: "tool-job@1",
            toolContract: "pdf.optimize@1",
            maintainer: true,
            execution: "server",
            reason: null,
            limits: { maxFiles: 1, maxBytesPerFile: 50 * 1024 * 1024, maxPagesPerFile: 100 },
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
          },
          200,
          false,
        );
      if (path === "/v1/jobs" && method === "POST") {
        return json(
          {
            contract: "tool-job@1",
            jobId,
            mode: "upload-required",
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              byteLength: 1024,
              contentType: "application/pdf",
              expiresAt: "2026-08-12T01:00:00.000Z",
            },
            reservedWeightedUnits: 1024,
          },
          201,
        );
      }
      if (path.endsWith("/input")) return json(null, 204);
      if (path.endsWith("/result")) {
        return new Response(resultBytes, {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(resultBytes.byteLength),
            digest: resultDigest,
            "x-download-lease": "b".repeat(43),
          },
        });
      }
      if (path === `/v1/jobs/${jobId}` && method === "GET") {
        return calls.some((call) => call.method === "DELETE")
          ? json({}, 404)
          : json({
              contract: "tool-job@1",
              jobId,
              state: "succeeded",
              sequence: 4,
              attempt: 1,
              phase: "completed",
              phaseFraction: 1,
              updatedAt: "2026-08-12T00:00:00.000Z",
              result: {
                kind: "download",
                mime: "application/pdf",
                sourceByteLength: 1024,
                byteLength: resultBytes.byteLength,
                pageCount: 1,
                profile: "structural",
                engineBuildId: "qpdf-12.2.0",
                warnings: ["SIGNATURES_INVALIDATED"],
              },
            });
      }
      if (path.endsWith("/downloaded")) return json(null, 204);
      if (path === `/v1/jobs/${jobId}` && method === "DELETE") return json(null, 204);
      throw new Error(`unexpected request ${method} ${path}`);
    };

    const result = await runPdfSmokeLifecycle({
      pageOrigin: "https://processing-staging.hereisit.pages.dev",
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      fetch: fetcher,
      source: new Uint8Array(1024).fill(1),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      passed: true,
      profile: "structural",
      publicAdmissionReady: false,
      deleted: true,
      sweepPassed: true,
    });
    expect(JSON.stringify(calls)).not.toMatch(/filename|private|presigned|https?:/i);
  });

  it("uses the shared strict versioned schemas for every JSON control response", () => {
    expect(pdfOptimizePolicyResponseSchema).toBeDefined();
    expect(pdfOptimizeCreateResponseSchema).toBeDefined();
    expect(pdfOptimizeStatusResponseSchema).toBeDefined();
    const source = String(runPdfSmokeLifecycle);
    expect(source).toContain("pdfOptimizePolicyResponseSchema.parse");
    expect(source).toContain("pdfOptimizeCreateResponseSchema.parse");
    expect(source).toContain("pdfOptimizeStatusResponseSchema.parse");
  });

  it.each([
    [
      "oversized declaration",
      { headers: { "content-type": "application/json", "content-length": "20000" }, body: "{}" },
    ],
    [
      "stream overrun",
      { headers: { "content-type": "application/json", "content-length": "2" }, body: "{}x" },
    ],
    [
      "wrong content type",
      { headers: { "content-type": "text/plain", "content-length": "2" }, body: "{}" },
    ],
    [
      "malformed JSON",
      { headers: { "content-type": "application/json", "content-length": "1" }, body: "{" },
    ],
    [
      "oversized undeclared stream",
      { headers: { "content-type": "application/json" }, body: `{${"x".repeat(16 * 1024)}` },
    ],
  ])("rejects a %s control response without exposing its private body", async (_label, fixture) => {
    const fetcher: typeof fetch = async () =>
      new Response(fixture.body, { status: 200, headers: fixture.headers });
    let message = "";
    await runPdfSmokeLifecycle({
      pageOrigin: "https://processing-staging.hereisit.pages.dev",
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      fetch: fetcher,
      source: new Uint8Array(1024).fill(1),
    }).catch((error) => {
      message = error instanceof Error ? error.message : String(error);
    });
    expect(message).toMatch(/response|envelope|control/i);
    expect(message).not.toContain(fixture.body);
  });

  it("uses a fresh bounded cleanup deadline after the lifecycle deadline expires", async () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const timeouts: number[] = [];
    let now = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      const method = init?.method ?? "GET";
      const reply = (value: unknown, status: number) => {
        const body = value === null ? null : JSON.stringify(value);
        return new Response(body, {
          status,
          headers:
            body === null
              ? undefined
              : {
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(body)),
                },
        });
      };
      if (path === "/v1/policy")
        return reply(
          {
            contract: "tool-job@1",
            toolContract: "pdf.optimize@1",
            maintainer: true,
            execution: "server",
            reason: null,
            limits: { maxFiles: 1, maxBytesPerFile: 50 * 1024 * 1024, maxPagesPerFile: 100 },
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
          },
          200,
        );
      if (path === "/v1/jobs" && method === "POST") {
        return reply(
          {
            contract: "tool-job@1",
            jobId,
            mode: "upload-required",
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              byteLength: 1024,
              contentType: "application/pdf",
              expiresAt: "2026-08-12T01:00:00.000Z",
            },
            reservedWeightedUnits: 1024,
          },
          201,
        );
      }
      if (method === "PUT") {
        now = 20_000;
        throw new Error("private upload failure");
      }
      if (method === "DELETE") return reply(null, 204);
      throw new Error("unexpected request");
    };

    await expect(
      runPdfSmokeLifecycle({
        pageOrigin: "https://processing-staging.hereisit.pages.dev",
        sessionId: "123e4567-e89b-42d3-a456-426614174001",
        fetch: fetcher,
        source: new Uint8Array(1024).fill(1),
        deadlineMs: 10_000,
        now: () => now,
        timeoutSignal: (milliseconds: number) => {
          timeouts.push(milliseconds);
          return new AbortController().signal;
        },
      }),
    ).rejects.toThrow(/private upload failure/);
    expect(timeouts.at(-1)).toBe(10_000);
  });
});
