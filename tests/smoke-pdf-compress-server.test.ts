import { describe, expect, it } from "vitest";
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
    const json = (body: unknown, status = 200) =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (path === "/v1/policy") return json({ maintainer: true, execution: "server" });
      if (path === "/v1/jobs" && method === "POST") {
        return json(
          {
            jobId,
            mode: "upload-required",
            upload: {
              path: `/v1/jobs/${jobId}/input`,
              byteLength: 1024,
              contentType: "application/pdf",
            },
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
              state: "succeeded",
              sequence: 4,
              result: {
                kind: "download",
                mime: "application/pdf",
                sourceByteLength: 1024,
                byteLength: resultBytes.byteLength,
                pageCount: 1,
                profile: "structural",
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
});
