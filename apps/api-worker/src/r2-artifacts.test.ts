import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactHead,
  ArtifactUploadError,
  createOpaqueObjectKey,
  deleteAuthorizedArtifact,
  storeExactInputArtifact,
  verifyInputArtifactHead,
} from "./r2-artifacts";

const INPUT_ID = "550e8400-e29b-41d4-a716-446655440000";
const INPUT_KEY = `inputs/${INPUT_ID}`;
const PDF_DIGEST = "sha-256=A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=";
const OTHER_PDF_DIGEST = "sha-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

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
    customMetadata: { kind: "input", uploadVersion: "1", verifiedSha256: PDF_DIGEST },
    ...overrides,
  });
}

type StoredObject = ArtifactHead & { readonly body: Uint8Array };

function pdfObject(
  key: string,
  body: Uint8Array,
  customMetadata: Readonly<Record<string, string>>,
  etag = `etag-${key}`,
): StoredObject {
  return {
    key,
    size: body.byteLength,
    etag,
    httpEtag: `"${etag}"`,
    httpMetadata: { contentType: "application/pdf" },
    customMetadata,
    body,
  };
}

function pdfBucket(
  input: {
    readonly canonical?: StoredObject;
    readonly throwAfterCanonicalStore?: boolean;
    readonly throwAfterPendingStore?: boolean;
    readonly rejectPendingWithoutStore?: boolean;
    readonly replacePendingBeforeHead?: StoredObject;
    readonly failPendingHead?: boolean;
    readonly hangPendingHead?: boolean;
  } = {},
) {
  const objects = new Map<string, StoredObject>();
  if (input.canonical !== undefined) objects.set(INPUT_KEY, input.canonical);
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    bucket: {
      async put(
        key: string,
        stream: ReadableStream<Uint8Array>,
        options: {
          onlyIf: Headers;
          httpMetadata: { contentType: "application/pdf" };
          customMetadata: Readonly<Record<string, string>>;
        },
      ) {
        const body = new Uint8Array(await new Response(stream).arrayBuffer());
        if (objects.has(key)) return null;
        if (key.startsWith("pending-inputs/") && input.rejectPendingWithoutStore) {
          throw new Error("pending put rejected before storage");
        }
        const stored = pdfObject(key, body, options.customMetadata);
        objects.set(key, stored);
        if (key.startsWith("pending-inputs/") && input.throwAfterPendingStore) {
          throw new Error("lost pending put response");
        }
        if (key === INPUT_KEY && input.throwAfterCanonicalStore) {
          throw new Error("lost canonical put response");
        }
        return stored;
      },
      async get(key: string) {
        const stored = objects.get(key);
        return stored === undefined ? null : { ...stored, body: bytes(...stored.body) };
      },
      async head(key: string) {
        if (key.startsWith("pending-inputs/") && input.hangPendingHead) {
          return await new Promise<StoredObject | null>(() => undefined);
        }
        if (key.startsWith("pending-inputs/") && input.failPendingHead) {
          throw new Error("private pending head failure");
        }
        if (key.startsWith("pending-inputs/") && input.replacePendingBeforeHead !== undefined) {
          objects.set(key, input.replacePendingBeforeHead);
        }
        return objects.get(key) ?? null;
      },
      async delete(key: string) {
        deleted.push(key);
        objects.delete(key);
      },
    },
  };
}

function storePdf(
  bucket: ReturnType<typeof pdfBucket>["bucket"],
  createDigestStream: () => ReturnType<typeof digestStream> = () => digestStream(PDF_DIGEST),
) {
  return storeExactInputArtifact({
    bucket,
    source: bytes(1, 2, 3),
    key: INPUT_KEY,
    byteLength: 3,
    mime: "application/pdf",
    uploadVersion: 1,
    deadlineAt: Date.now() + 10_000,
    expectedSha256: PDF_DIGEST,
    createFixedLengthStream: passthroughFixedLengthStream,
    createDigestStream,
    randomUuid: vi
      .fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222"),
  });
}

function digestStream(digest: string) {
  const sink = new WritableStream<ArrayBuffer | ArrayBufferView>();
  return Object.assign(sink, {
    digest: Promise.resolve(
      Uint8Array.from(atob(digest.slice(8)), (value) => value.charCodeAt(0)).buffer,
    ),
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
        expectedSha256: PDF_DIGEST,
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

  it("recovers a verified PDF after its canonical put stores then loses the response", async () => {
    const state = pdfBucket({ throwAfterCanonicalStore: true });
    await expect(storePdf(state.bucket)).resolves.toMatchObject({
      kind: "existing-authoritative",
      artifact: { etag: `etag-${INPUT_KEY}` },
    });
    expect(state.objects.get(INPUT_KEY)?.customMetadata).toEqual({
      kind: "input",
      uploadVersion: "1",
      verifiedSha256: PDF_DIGEST,
    });
    expect(state.deleted).toEqual([
      `pending-inputs/${INPUT_ID}/11111111-1111-4111-8111-111111111111`,
    ]);
  });

  it("rejects a conditional loser against an unverified PDF winner without deleting it", async () => {
    const unverified = pdfObject(INPUT_KEY, Uint8Array.of(1, 2, 3), {
      kind: "input",
      uploadVersion: "1",
      sha256: PDF_DIGEST,
    });
    const state = pdfBucket({ canonical: unverified });
    await expect(storePdf(state.bucket)).rejects.toMatchObject({ code: "UPLOAD_MISMATCH" });
    expect(state.objects.get(INPUT_KEY)).toBe(unverified);
    expect(state.deleted).not.toContain(INPUT_KEY);
  });

  it("does not delete a pending object owned by a conditional winner", async () => {
    const pendingKey = `pending-inputs/${INPUT_ID}/11111111-1111-4111-8111-111111111111`;
    const pendingWinner = pdfObject(pendingKey, Uint8Array.of(9, 9, 9), {
      kind: "pending-input",
      uploadVersion: "1",
    });
    const state = pdfBucket();
    state.objects.set(pendingKey, pendingWinner);
    await expect(storePdf(state.bucket)).rejects.toMatchObject({ code: "UPLOAD_MISMATCH" });
    expect(state.objects.get(pendingKey)).toBe(pendingWinner);
    expect(state.deleted).not.toContain(pendingKey);
  });

  it("deletes a store-then-throw pending object only when its ownership marker matches", async () => {
    const pendingKey = `pending-inputs/${INPUT_ID}/11111111-1111-4111-8111-111111111111`;
    const state = pdfBucket({ throwAfterPendingStore: true });
    await expect(storePdf(state.bucket)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(state.deleted).toEqual([pendingKey]);
    expect(state.objects.has(pendingKey)).toBe(false);
  });

  it("does not delete when a rejected pending put stored no object", async () => {
    const state = pdfBucket({ rejectPendingWithoutStore: true });
    await expect(storePdf(state.bucket)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(state.deleted).toEqual([]);
  });

  it("never deletes a nonmatching replacement at the same pending key", async () => {
    const pendingKey = `pending-inputs/${INPUT_ID}/11111111-1111-4111-8111-111111111111`;
    const replacement = pdfObject(pendingKey, Uint8Array.of(7, 7, 7), {
      kind: "pending-input",
      uploadVersion: "1",
      ownershipMarker: "33333333-3333-4333-8333-333333333333",
    });
    const state = pdfBucket({
      throwAfterPendingStore: true,
      replacePendingBeforeHead: replacement,
    });
    await expect(storePdf(state.bucket)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(state.deleted).toEqual([]);
    expect(state.objects.get(pendingKey)).toBe(replacement);
  });

  it("returns safely without deletion when pending ownership HEAD fails", async () => {
    const pendingKey = `pending-inputs/${INPUT_ID}/11111111-1111-4111-8111-111111111111`;
    const state = pdfBucket({ throwAfterPendingStore: true, failPendingHead: true });
    await expect(storePdf(state.bucket)).rejects.toEqual(
      new ArtifactUploadError("STORAGE_FAILURE"),
    );
    expect(state.deleted).toEqual([]);
    expect(state.objects.has(pendingKey)).toBe(true);
  });

  it("bounds an unresponsive pending ownership HEAD", async () => {
    vi.useFakeTimers();
    try {
      const state = pdfBucket({ throwAfterPendingStore: true, hangPendingHead: true });
      const result = storePdf(state.bucket);
      const assertion = expect(result).rejects.toEqual(new ArtifactUploadError("STORAGE_FAILURE"));
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
      expect(state.deleted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes only its pending PDF when digest computation rejects after storage", async () => {
    const state = pdfBucket();
    const failingDigest = () =>
      Object.assign(new WritableStream<ArrayBuffer | ArrayBufferView>(), {
        digest: Promise.reject(new Error("private digest failure")),
      });
    await expect(storePdf(state.bucket, failingDigest)).rejects.toMatchObject({
      code: "UPLOAD_MISMATCH",
    });
    expect(state.deleted).toEqual([
      `pending-inputs/${INPUT_ID}/11111111-1111-4111-8111-111111111111`,
    ]);
    expect(state.objects.has(INPUT_KEY)).toBe(false);
  });

  it("cannot delete a different verified winner during mismatch cleanup", async () => {
    const winner = pdfObject(INPUT_KEY, Uint8Array.of(9, 9, 9), {
      kind: "input",
      uploadVersion: "1",
      verifiedSha256: OTHER_PDF_DIGEST,
    });
    const state = pdfBucket({ canonical: winner });
    await expect(
      storePdf(state.bucket, () => digestStream(OTHER_PDF_DIGEST)),
    ).rejects.toMatchObject({
      code: "UPLOAD_MISMATCH",
    });
    expect(state.deleted).not.toContain(INPUT_KEY);
    expect(state.objects.get(INPUT_KEY)).toBe(winner);
  });

  it("accepts an idempotent replay only when the existing PDF winner is verified and matching", async () => {
    const winner = pdfObject(INPUT_KEY, Uint8Array.of(1, 2, 3), {
      kind: "input",
      uploadVersion: "1",
      verifiedSha256: PDF_DIGEST,
    });
    const state = pdfBucket({ canonical: winner });
    await expect(storePdf(state.bucket)).resolves.toMatchObject({
      kind: "existing-authoritative",
      artifact: { etag: `etag-${INPUT_KEY}` },
    });
    expect(state.objects.get(INPUT_KEY)).toBe(winner);
    expect(state.deleted).not.toContain(INPUT_KEY);
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
  it("creates the default PDF digest through crypto.DigestStream", async () => {
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined;
    const digest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve;
    });
    class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
      readonly digest = digest;

      constructor(_algorithm: string) {
        super({
          close() {
            resolveDigest?.(
              Uint8Array.from(atob(PDF_DIGEST.slice(8)), (value) => value.charCodeAt(0)).buffer,
            );
          },
        });
      }
    }
    vi.stubGlobal("crypto", { DigestStream: TestDigestStream });
    try {
      const state = pdfBucket();
      await expect(
        storeExactInputArtifact({
          bucket: state.bucket,
          source: bytes(1, 2, 3),
          key: INPUT_KEY,
          byteLength: 3,
          mime: "application/pdf",
          uploadVersion: 1,
          deadlineAt: Date.now() + 10_000,
          expectedSha256: PDF_DIGEST,
          createFixedLengthStream: passthroughFixedLengthStream,
          randomUuid: vi
            .fn()
            .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
            .mockReturnValueOnce("22222222-2222-4222-8222-222222222222"),
        }),
      ).resolves.toMatchObject({ kind: "stored" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
