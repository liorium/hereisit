import type { EngineCreateJobRequest } from "@hereisit/server-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

import {
  createEngineClientFromStub,
  EngineCrashError,
  EngineProtocolError,
} from "./container-client";

const jobId = "550e8400-e29b-41d4-a716-446655440000";
const request = {
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
  input: { byteLength: 3, etag: "etag-1", mimeHint: "image/png" },
  resourceClass: "image-standard-v1",
} satisfies EngineCreateJobRequest;

describe("fixed-slot engine client", () => {
  it("uses the protocol endpoints and streams upload bodies without buffering", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    Object.defineProperty(stream, "arrayBuffer", {
      value: () => {
        throw new Error("must not buffer");
      },
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/v1/jobs/${jobId}/input`)) {
        expect(init?.body).toBe(stream);
      }
      return new Response(null, { status: 204 });
    });
    const client = createEngineClientFromStub({
      getState: vi.fn(async () => ({ status: "stopped", lastChange: 0 })),
      fetch,
    });

    await expect(client.create(request)).resolves.toMatchObject({ coldStart: true });
    await expect(client.upload(jobId, stream, 3, "image/png")).resolves.toBeUndefined();
    await expect(client.run(jobId)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("strictly validates status payloads", async () => {
    const client = createEngineClientFromStub({
      getState: vi.fn(async () => ({ status: "healthy", lastChange: 0 })),
      fetch: vi.fn(async () =>
        Response.json({ protocol: 1, jobId, state: "running", extra: true }),
      ),
    });

    await expect(client.status(jobId)).rejects.toBeInstanceOf(EngineProtocolError);
  });

  it("normalizes platform startup failures without retaining their text", async () => {
    const secret = "container stderr with a private path";
    const client = createEngineClientFromStub({
      getState: vi.fn(async () => ({ status: "stopped", lastChange: 0 })),
      fetch: vi.fn(async () => {
        throw new Error(secret);
      }),
    });

    const error = await client.create(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineCrashError);
    expect(String(error)).not.toContain(secret);
  });
});
