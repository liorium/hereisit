import type { EngineCreateJobRequest, EngineCreatePdfJobRequest } from "@hereisit/server-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

import {
  createEngineClientFromStub,
  createImageEngineEnvironment,
  createPdfEngineClientFromStub,
  createPdfEngineEnvironment,
  EngineCrashError,
  EngineProtocolError,
  ImageEngineContainer,
  PdfEngineContainer,
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

const pdfRequest = {
  protocol: 1,
  jobId,
  attempt: 1,
  tool: "pdf.optimize",
  toolVersion: 1,
  spec: { version: 1, preset: "balanced" },
  specHash: "b".repeat(64),
  input: {
    byteLength: 1_000,
    etag: "etag-pdf",
    mimeHint: "application/pdf",
    pageCount: 3,
  },
  resourceClass: "pdf-standard-v1",
} satisfies EngineCreatePdfJobRequest;

describe("fixed-slot engine client", () => {
  it("passes immutable build identities into every Cloudflare Container start", () => {
    const digest = "d".repeat(64);
    const engineImage = `registry.cloudflare.com/${"a".repeat(32)}/hereisit-image-engine@sha256:${digest}`;
    const container = new ImageEngineContainer(
      {} as never,
      {
        ENGINE_IMAGE_DIGEST: engineImage,
      } as never,
    );

    expect(container.envVars).toEqual({
      ENGINE_BUILD_ID: `sha256:${digest}`,
      JPEG_CODEC_BUILD_ID: "mozjpeg-4.1.1+a2d2907",
      PNG_CODEC_BUILD_ID: "quantizr-1.4.3+oxipng-10.1.1",
      WEBP_CODEC_BUILD_ID: "libwebp-1.6.0+4fa2191",
      TRANSFORM_BUILD_ID: "libvips-8.18.4+e01a479",
    });
    expect(createImageEngineEnvironment("local-dockerfile").ENGINE_BUILD_ID).toBe(
      "local-dockerfile",
    );
    expect(() => createImageEngineEnvironment("registry.example/image:latest")).toThrow(/identity/);
  });

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

describe("fixed-slot PDF engine client", () => {
  it("uses a distinct immutable image identity and fixed environment", () => {
    const digest = "e".repeat(64);
    const image = `registry.cloudflare.com/${"a".repeat(32)}/hereisit-pdf-engine@sha256:${digest}`;
    const container = new PdfEngineContainer(
      {} as never,
      { PDF_ENGINE_IMAGE_DIGEST: image } as never,
    );
    expect(container.envVars).toEqual({
      ENGINE_BUILD_ID: `sha256:${digest}`,
      QPDF_BUILD_ID: "qpdf-12.4.0",
    });
    expect(createPdfEngineEnvironment("local-dockerfile").ENGINE_BUILD_ID).toBe("local-dockerfile");
    expect(() => createPdfEngineEnvironment("registry.example/pdf:latest")).toThrow(/identity/);
    expect(() =>
      createPdfEngineEnvironment(
        `registry.cloudflare.com/${"a".repeat(32)}/hereisit-image-engine@sha256:${digest}`,
      ),
    ).toThrow(/identity/);
  });

  it("accepts only strict PDF requests and PDF status payloads", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(`/v1/jobs/${jobId}`)) {
        return Response.json({
          protocol: 1,
          jobId,
          state: "running",
          phase: "optimizing",
          fraction: 0.5,
          sequence: 1,
        });
      }
      return new Response(null, { status: 204 });
    });
    const client = createPdfEngineClientFromStub({
      getState: vi.fn(async () => ({ status: "stopped", lastChange: 0 })),
      fetch,
    });
    await expect(client.create(pdfRequest)).resolves.toMatchObject({ coldStart: true });
    await expect(client.status(jobId)).resolves.toMatchObject({
      state: "running",
      phase: "optimizing",
    });
    await expect(client.create(request as never)).rejects.toBeInstanceOf(Error);
  });
});
