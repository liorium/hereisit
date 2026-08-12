import { describe, expect, it, vi } from "vitest";
import {
  ArtifactUploadError,
  createOpaqueObjectKey,
  deleteAuthorizedArtifact,
  storeExactInputArtifact,
  verifyInputArtifactHead,
} from "./r2-artifacts";

const INPUT_ID = "550e8400-e29b-41d4-a716-446655440000";
const INPUT_KEY = `inputs/${INPUT_ID}`;

function inputHead(overrides: Record<string, unknown> = {}) {
  return {
    key: INPUT_KEY,
    size: 3,
    etag: "raw-etag",
    httpEtag: '"raw-etag"',
    httpMetadata: { contentType: "image/png" },
    customMetadata: { kind: "input", uploadVersion: "1" },
    ...overrides,
  };
}

function pdfHead(overrides: Record<string, unknown> = {}) {
  return inputHead({
    size: 40 * 1024 * 1024,
    httpMetadata: { contentType: "application/pdf" },
    ...overrides,
  });
}

function bytes(...values: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from(values));
      controller.close();
    },
  });
}

function passthroughFixedLengthStream() {
  return new TransformStream<ArrayBuffer | ArrayBufferView, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    },
  });
}

describe("opaque R2 artifact keys", () => {
  it("creates only canonical lowercase UUID keys", () => {
    expect(createOpaqueObjectKey("inputs", INPUT_ID)).toBe(INPUT_KEY);
    expect(createOpaqueObjectKey("outputs", INPUT_ID)).toBe(`outputs/${INPUT_ID}`);
  });

  it.each([
    "../private.jpg",
    "550E8400-E29B-41D4-A716-446655440000",
    "550e8400-e29b-01d4-a716-446655440000",
    "550e8400-e29b-41d4-7716-446655440000",
    "550e8400-e29b-41d4-a716-446655440000/extra",
    "550e8400-e29b-41d4-a716-446655440000\u0000suffix",
  ])("rejects noncanonical object identifier %j", (value) => {
    expect(() => createOpaqueObjectKey("inputs", value)).toThrow();
  });
});

describe("R2 input invariants", () => {
  it("returns the raw ETag only for an exact key, size, MIME, and bounded metadata match", () => {
    expect(
      verifyInputArtifactHead(inputHead(), {
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
      }),
    ).toEqual({
      key: INPUT_KEY,
      byteLength: 3,
      mime: "image/png",
      etag: "raw-etag",
      uploadVersion: 1,
    });
  });

  it("accepts a bounded PDF while retaining the smaller image byte ceiling", () => {
    expect(
      verifyInputArtifactHead(pdfHead(), {
        key: INPUT_KEY,
        byteLength: 40 * 1024 * 1024,
        mime: "application/pdf",
        uploadVersion: 1,
      }),
    ).toMatchObject({ mime: "application/pdf", etag: "raw-etag" });
    expect(() =>
      verifyInputArtifactHead(inputHead({ size: 30 * 1024 * 1024 + 1 }), {
        key: INPUT_KEY,
        byteLength: 30 * 1024 * 1024 + 1,
        mime: "image/png",
        uploadVersion: 1,
      }),
    ).toThrow(ArtifactUploadError);
  });

  it.each([
    ["key", { key: `inputs/${crypto.randomUUID()}` }],
    ["size", { size: 4 }],
    ["MIME", { httpMetadata: { contentType: "image/jpeg" } }],
    ["kind", { customMetadata: { kind: "output", uploadVersion: "1" } }],
    ["version", { customMetadata: { kind: "input", uploadVersion: "2" } }],
    [
      "extra metadata",
      { customMetadata: { kind: "input", uploadVersion: "1", filename: "private.jpg" } },
    ],
  ])("rejects a mismatched %s", (_label, override) => {
    expect(() =>
      verifyInputArtifactHead(inputHead(override), {
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
      }),
    ).toThrow(ArtifactUploadError);
  });
});

describe("exact streaming R2 upload", () => {
  it("starts a create-only streaming put and verifies the authoritative head", async () => {
    const head = inputHead();
    const put = vi.fn(async (_key: string, stream: ReadableStream<Uint8Array>, options: object) => {
      expect(options).toMatchObject({
        httpMetadata: { contentType: "image/png" },
        customMetadata: { kind: "input", uploadVersion: "1" },
      });
      const onlyIf = (options as { onlyIf: Headers }).onlyIf;
      expect(onlyIf.get("if-none-match")).toBe("*");

      const reader = stream.getReader();
      const observed: number[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        observed.push(...next.value);
      }
      expect(observed).toEqual([1, 2, 3]);
      return head;
    });
    const bucket = {
      put,
      head: vi.fn(async () => head),
      delete: vi.fn(async () => undefined),
    };

    await expect(
      storeExactInputArtifact({
        bucket,
        source: bytes(1, 2, 3),
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 10_000,
        createFixedLengthStream: passthroughFixedLengthStream,
      }),
    ).resolves.toEqual({
      kind: "stored",
      artifact: {
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        etag: "raw-etag",
        uploadVersion: 1,
      },
    });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("returns the existing authoritative first-writer head after a conditional loser", async () => {
    const head = inputHead();
    const bucket = {
      put: vi.fn(async () => null),
      head: vi.fn(async () => head),
      delete: vi.fn(async () => undefined),
    };

    await expect(
      storeExactInputArtifact({
        bucket,
        source: bytes(1, 2, 3),
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 10_000,
        createFixedLengthStream: passthroughFixedLengthStream,
      }),
    ).resolves.toEqual({
      kind: "existing-authoritative",
      artifact: expect.objectContaining({ etag: "raw-etag" }),
    });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("returns the authoritative head after response loss only when the producer completed", async () => {
    const head = inputHead();
    const bucket = {
      put: vi.fn(async (key: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        while (!(await reader.read()).done) {
          // Consume the stream before simulating response loss.
        }
        throw new Error(`lost response for ${key}`);
      }),
      head: vi.fn(async () => head),
      delete: vi.fn(async () => undefined),
    };

    await expect(
      storeExactInputArtifact({
        bucket,
        source: bytes(1, 2, 3),
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 10_000,
        createFixedLengthStream: passthroughFixedLengthStream,
      }),
    ).resolves.toMatchObject({ kind: "existing-authoritative" });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it.each([
    "stored",
    "conditional",
    "response-loss",
  ])("normalizes a head provider failure on the %s path", async (path) => {
    const bucket = {
      put: vi.fn(async (_key: string, stream: ReadableStream<Uint8Array>) => {
        if (path === "conditional") return null;
        const reader = stream.getReader();
        while (!(await reader.read()).done) {
          // Drain without buffering.
        }
        if (path === "response-loss") throw new Error("private provider response");
        return inputHead();
      }),
      head: vi.fn(async () => {
        throw new Error("private provider head failure");
      }),
      delete: vi.fn(async () => undefined),
    };

    await expect(
      storeExactInputArtifact({
        bucket,
        source: bytes(1, 2, 3),
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 10_000,
        createFixedLengthStream: passthroughFixedLengthStream,
      }),
    ).rejects.toEqual(new ArtifactUploadError("STORAGE_FAILURE"));
  });

  it("cancels the producer and awaits termination when R2 fails", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const bucket = {
      put: vi.fn(async () => {
        throw new Error("provider failure");
      }),
      head: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    };

    await expect(
      storeExactInputArtifact({
        bucket,
        source,
        key: INPUT_KEY,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 10_000,
        createFixedLengthStream: passthroughFixedLengthStream,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(cancelled).toBe(true);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("requires explicit repository authorization before deletion", async () => {
    const bucket = {
      put: vi.fn(),
      head: vi.fn(),
      delete: vi.fn(async () => undefined),
    };

    await deleteAuthorizedArtifact(bucket, {
      kind: "delete-unowned-object",
      key: INPUT_KEY,
    });

    expect(bucket.delete).toHaveBeenCalledWith(INPUT_KEY);
  });

  it("rejects deletion without a canonical repository authorization", async () => {
    const bucket = {
      put: vi.fn(),
      head: vi.fn(),
      delete: vi.fn(async () => undefined),
    };

    await expect(
      deleteAuthorizedArtifact(bucket, {
        kind: "delete-unowned-object",
        key: "inputs/../private.jpg",
      } as never),
    ).rejects.toThrow("Artifact deletion requires repository authorization");
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("normalizes deletion provider errors without exposing their message", async () => {
    const bucket = {
      put: vi.fn(),
      head: vi.fn(),
      delete: vi.fn(async () => {
        throw new Error("private provider deletion failure");
      }),
    };

    await expect(
      deleteAuthorizedArtifact(bucket, {
        kind: "delete-unowned-object",
        key: INPUT_KEY,
      }),
    ).rejects.toEqual(new ArtifactUploadError("STORAGE_FAILURE"));
  });
});
