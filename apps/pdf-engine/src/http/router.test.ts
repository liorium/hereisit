import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineCreatePdfJobRequest, PdfEngineJobStatus } from "@hereisit/server-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfJobController, type PdfOptimizationRunner } from "../job/job-runner";
import { createPdfEngineRequestHandler } from "./router";

const jobId = "123e4567-e89b-42d3-a456-426614174001";
const createBody: EngineCreatePdfJobRequest = {
  protocol: 1,
  jobId,
  attempt: 1,
  tool: "pdf.optimize",
  toolVersion: 1,
  spec: { version: 1, preset: "balanced" },
  specHash: "a".repeat(64),
  input: { byteLength: 12, etag: "opaque", mimeHint: "application/pdf", pageCount: 1 },
  resourceClass: "pdf-standard-v1",
};

const terminal = (id: string): PdfEngineJobStatus => ({
  protocol: 1,
  jobId: id,
  state: "succeeded",
  phase: "preparing-output",
  fraction: 1,
  sequence: 4,
  result: {
    kind: "download",
    mime: "application/pdf",
    sourceByteLength: 12,
    byteLength: 9,
    pageCount: 1,
    profile: "structural",
    engineBuildId: "pdf-test",
    warnings: ["SIGNATURES_INVALIDATED"],
  },
  inspection: { verifiedInputMime: "application/pdf", verifiedPageCount: 1, encrypted: false },
  measurements: {
    processedInputBytes: 12,
    cpuMs: 1,
    memoryByteMilliseconds: 1,
    peakMemoryBytes: 1,
    testedCandidates: 1,
    processingMs: 1,
  },
});

describe("PDF engine HTTP lifecycle", () => {
  let root = "";
  let server: Server;
  let origin = "";
  let controller: PdfJobController;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hereisit-pdf-router-"));
    const runner: PdfOptimizationRunner = vi.fn(async ({ request, workspace }) => {
      await writeFile(workspace.output, Buffer.from("%PDF%%EOF"), { mode: 0o600 });
      return terminal(request.jobId);
    });
    controller = new PdfJobController({ workspaceRoot: root, runner });
    server = createServer(
      createPdfEngineRequestHandler({
        controller,
        build: { protocol: 1, engineBuildId: "pdf-test", qpdf: "12.4.0" },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server address missing");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const call = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
  const rawUpload = (headers: Record<string, string>, body: Uint8Array) =>
    new Promise<number>((resolve, reject) => {
      const target = new URL(origin);
      const outgoing = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: `/v1/jobs/${jobId}/input`,
          method: "PUT",
          headers: { ...headers, connection: "close" },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode ?? 0));
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  const rawGet = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const target = new URL(origin);
      const outgoing = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path,
          method: "GET",
          headers: { connection: "close" },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode ?? 0));
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });

  it("creates idempotently and rejects conflicting or non-PDF jobs", async () => {
    expect(
      (await call("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) })).status,
    ).toBe(201);
    expect(
      (await call("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) })).status,
    ).toBe(200);
    expect(
      (
        await call("/v1/jobs", {
          method: "POST",
          body: JSON.stringify({ ...createBody, specHash: "b".repeat(64) }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/v1/jobs", {
          method: "POST",
          body: JSON.stringify({ ...createBody, tool: "image.optimize" }),
        })
      ).status,
    ).toBe(400);
  });

  it("requires exact PDF input length and MIME", async () => {
    await call("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) });
    expect(
      await rawUpload({ "content-length": "12", "content-type": "image/png" }, Buffer.alloc(12)),
    ).toBe(415);
    expect(
      await rawUpload(
        { "content-length": "11", "content-type": "application/pdf" },
        Buffer.alloc(11),
      ),
    ).toBe(400);
    expect(
      await rawUpload(
        { "content-length": "12", "content-type": "application/pdf" },
        Buffer.from("%PDF-x%%EOF\n"),
      ),
    ).toBe(204);
    await expect((await call(`/v1/jobs/${jobId}`)).json()).resolves.toMatchObject({
      state: "ready",
    });
  });

  it("runs idempotently, streams a verified output, and deletes", async () => {
    await call("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) });
    await rawUpload(
      { "content-length": "12", "content-type": "application/pdf" },
      Buffer.from("%PDF-x%%EOF\n"),
    );
    expect((await call(`/v1/jobs/${jobId}/run`, { method: "POST" })).status).toBe(202);
    expect((await call(`/v1/jobs/${jobId}/run`, { method: "POST" })).status).toBe(202);
    await expect
      .poll(async () => (await call(`/v1/jobs/${jobId}`)).json())
      .toMatchObject({ state: "succeeded" });
    const output = await call(`/v1/jobs/${jobId}/output`);
    expect(output.status).toBe(200);
    expect(output.headers.get("content-type")).toBe("application/pdf");
    expect(output.headers.get("digest")).toBe(
      `sha-256=${createHash("sha256").update("%PDF%%EOF").digest("base64")}`,
    );
    expect(await output.text()).toBe("%PDF%%EOF");
    expect((await call(`/v1/jobs/${jobId}`, { method: "DELETE" })).status).toBe(204);
    await expect(stat(join(root, jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns busy, supports cancellation, and sanitizes errors", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = new PdfJobController({
      workspaceRoot: root,
      runner: async ({ request }) => {
        await waiting;
        return terminal(request.jobId);
      },
    });
    const secondServer = createServer(
      createPdfEngineRequestHandler({
        controller: local,
        build: { protocol: 1, engineBuildId: "pdf-test", qpdf: "12.4.0" },
      }),
    );
    await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
    const address = secondServer.address();
    if (address === null || typeof address === "string") throw new Error("server address missing");
    const base = `http://127.0.0.1:${address.port}`;
    const first = createBody;
    const second = { ...createBody, jobId: "223e4567-e89b-42d3-a456-426614174002" };
    for (const body of [first, second]) {
      await fetch(`${base}/v1/jobs`, { method: "POST", body: JSON.stringify(body) });
      await fetch(`${base}/v1/jobs/${body.jobId}/input`, {
        method: "PUT",
        headers: { "content-length": "12", "content-type": "application/pdf" },
        body: Buffer.from("%PDF-x%%EOF\n"),
      });
    }
    await fetch(`${base}/v1/jobs/${first.jobId}/run`, { method: "POST" });
    const busy = await fetch(`${base}/v1/jobs/${second.jobId}/run`, { method: "POST" });
    expect(busy.status).toBe(409);
    expect(await busy.text()).toBe("");
    const deletion = fetch(`${base}/v1/jobs/${first.jobId}`, { method: "DELETE" });
    release();
    expect((await deletion).status).toBe(204);
    await new Promise<void>((resolve) => secondServer.close(() => resolve()));
  });

  it("rejects traversal and oversized JSON without details", async () => {
    expect(await rawGet("/v1/jobs/%2e%2e/output")).toBe(400);
    const response = await call("/v1/jobs", { method: "POST", body: "x".repeat(70_000) });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});
