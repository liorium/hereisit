import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineCreateJobRequest, EngineJobStatus } from "@hereisit/server-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobController, type RunnerStartInput } from "../job/job-controller";
import { createEngineRequestHandler } from "./router";

const jobId = "123e4567-e89b-42d3-a456-426614174001";
const createBody: EngineCreateJobRequest = {
  protocol: 1,
  jobId,
  attempt: 1,
  tool: "image.optimize",
  toolVersion: 1,
  spec: {
    version: 1,
    mode: "smart",
    preset: "balanced",
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  },
  specHash: "a".repeat(64),
  input: { byteLength: 3, etag: "opaque-r2-version", mimeHint: "image/jpeg" },
  resourceClass: "image-standard-v1",
};

describe("image engine HTTP lifecycle", () => {
  let root = "";
  let server: Server;
  let controller: JobController;
  let origin = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hereisit-engine-router-"));
    await mkdir(root, { recursive: true, mode: 0o700 });
    controller = new JobController({
      workspaceRoot: root,
      runner: {
        start: vi.fn(async ({ request, workspace }: RunnerStartInput) => {
          await writeFile(workspace.output, Uint8Array.of(9, 8), { mode: 0o600 });
          return {
            runnerPgid: 999_999,
            completion: Promise.resolve({
              protocol: 1,
              jobId: request.jobId,
              state: "succeeded",
              phase: "preparing-output",
              fraction: 1,
              sequence: 4,
              result: {
                kind: "download",
                mime: "image/jpeg",
                byteLength: 2,
                width: 1,
                height: 1,
                testedCandidates: 1,
                engineBuildId: "engine-test",
                codecBuildId: "jpeg-test",
                warnings: [],
              },
              inspection: {
                verifiedInputMime: "image/jpeg",
                inputHasAlpha: false,
                contentClass: "photo",
              },
              measurements: {
                processedInputBytes: 3,
                processedPixels: 1,
                cpuMs: 1,
                memoryByteMilliseconds: 1,
                peakMemoryBytes: 1,
                testedCandidates: 1,
                processingMs: 1,
              },
            } satisfies EngineJobStatus),
          };
        }),
      },
    });
    server = createServer(
      createEngineRequestHandler({
        controller,
        build: {
          protocol: 1,
          engineBuildId: "engine-test",
          codecs: { jpeg: "jpeg-test", png: "png-test", webp: "webp-test", transform: "vips-test" },
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing server address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);
  const rawRequest = (path: string, headers: Readonly<Record<string, string>>, body: Uint8Array) =>
    new Promise<number>((resolve, reject) => {
      const target = new URL(origin);
      const outgoing = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path,
          method: "PUT",
          headers: { ...headers, connection: "close" },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode ?? 0));
        },
      );
      outgoing.once("error", reject);
      if (headers["content-length"] === undefined && body.byteLength > 1) {
        outgoing.write(body.subarray(0, 1));
        outgoing.end(body.subarray(1));
      } else {
        outgoing.end(body);
      }
    });

  it("creates idempotently and rejects an identity mismatch", async () => {
    expect(
      (await request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) })).status,
    ).toBe(201);
    expect(
      (await request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) })).status,
    ).toBe(200);
    expect(
      (
        await request("/v1/jobs", {
          method: "POST",
          body: JSON.stringify({ ...createBody, specHash: "b".repeat(64) }),
        })
      ).status,
    ).toBe(409);
  });

  it("deduplicates concurrent identical creates", async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
  });

  it("accepts one exact-length input and exposes ready status", async () => {
    await request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) });
    expect(
      (
        await request(`/v1/jobs/${jobId}/input`, {
          method: "PUT",
          headers: { "content-length": "3", "content-type": "image/jpeg" },
          body: Uint8Array.of(1, 2, 3),
        })
      ).status,
    ).toBe(204);
    await expect((await request(`/v1/jobs/${jobId}`)).json()).resolves.toMatchObject({
      protocol: 1,
      jobId,
      state: "ready",
    });
  });

  it("accepts an identical input replay and rejects different bytes", async () => {
    await request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) });
    const upload = (body: Uint8Array) =>
      rawRequest(
        `/v1/jobs/${jobId}/input`,
        { "content-length": "3", "content-type": "image/jpeg" },
        body,
      );
    expect(await upload(Uint8Array.of(1, 2, 3))).toBe(204);
    expect(await upload(Uint8Array.of(1, 2, 3))).toBe(204);
    expect(await upload(Uint8Array.of(3, 2, 1))).toBe(409);
  });

  it.each([
    ["missing length", { "content-type": "image/jpeg" }, Uint8Array.of(1, 2, 3), 411],
    [
      "length mismatch",
      { "content-length": "2", "content-type": "image/jpeg" },
      Uint8Array.of(1, 2),
      400,
    ],
    [
      "MIME mismatch",
      { "content-length": "3", "content-type": "image/png" },
      Uint8Array.of(1, 2, 3),
      415,
    ],
  ])("rejects %s", async (_name, headers, body, expected) => {
    await request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) });
    expect(await rawRequest(`/v1/jobs/${jobId}/input`, headers, body)).toBe(expected);
  });

  it("rejects traversal, unknown output, and unsupported routes", async () => {
    expect(await rawRequest("/v1/jobs/%2e%2e/output", {}, new Uint8Array())).toBe(400);
    expect((await request(`/v1/jobs/${jobId}/output`)).status).toBe(404);
    expect((await request("/unknown")).status).toBe(404);
  });

  it("runs idempotently and streams verified output only after success", async () => {
    await request("/v1/jobs", { method: "POST", body: JSON.stringify(createBody) });
    await rawRequest(
      `/v1/jobs/${jobId}/input`,
      { "content-length": "3", "content-type": "image/jpeg" },
      Uint8Array.of(1, 2, 3),
    );
    expect((await request(`/v1/jobs/${jobId}/run`, { method: "POST" })).status).toBe(202);
    expect((await request(`/v1/jobs/${jobId}/run`, { method: "POST" })).status).toBe(202);
    await expect
      .poll(async () => (await request(`/v1/jobs/${jobId}`)).json())
      .toMatchObject({ state: "succeeded" });
    const output = await request(`/v1/jobs/${jobId}/output`);
    expect(output.status).toBe(200);
    expect(output.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(Uint8Array.of(9, 8));
    const descriptor = await controller.output(jobId);
    expect(descriptor).toMatchObject({ byteLength: 2 });
    expect(descriptor?.stream.readable).toBe(true);
    descriptor?.stream.destroy();
    expect((await request(`/v1/jobs/${jobId}`, { method: "DELETE" })).status).toBe(204);
    await expect(stat(join(root, jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns 503 for new creates after rollout shutdown begins", async () => {
    const localController = new JobController({
      workspaceRoot: root,
      runner: { start: vi.fn() },
    });
    localController.stopAccepting();
    const localServer = createServer(
      createEngineRequestHandler({
        controller: localController,
        build: {
          protocol: 1,
          engineBuildId: "engine-test",
          codecs: { jpeg: "jpeg-test", png: "png-test", webp: "webp-test", transform: "vips-test" },
        },
      }),
    );
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address();
    if (address === null || typeof address === "string") throw new Error("missing server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/jobs`, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(503);
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });
});
