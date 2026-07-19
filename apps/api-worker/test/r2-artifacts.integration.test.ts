import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactUploadError,
  createOpaqueObjectKey,
  storeExactInputArtifact,
} from "../src/r2-artifacts";

const keys = new Set<string>();

function objectKey() {
  const key = createOpaqueObjectKey("inputs", crypto.randomUUID());
  keys.add(key);
  return key;
}

function stream(chunks: readonly Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function gatedStream(chunk: Uint8Array, gate: Promise<void>) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await gate;
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function captureUnhandledRejections(operation: () => Promise<void>) {
  // The local R2 service prints its documented IncompleteBody/client-disconnect diagnostics for
  // intentionally broken fixed-length streams. Those service-isolate diagnostics are not a
  // JavaScript unhandled rejection in this module isolate; this trap proves that narrower claim.
  // The test intentionally does not claim stderr-clean termination.
  const reasons: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) => {
    reasons.push(event.reason);
    event.preventDefault();
  };
  self.addEventListener("unhandledrejection", listener);
  try {
    await operation();
    await scheduler.wait(0);
    await scheduler.wait(0);
  } finally {
    self.removeEventListener("unhandledrejection", listener);
  }
  return reasons;
}

afterEach(async () => {
  await Promise.all([...keys].map((key) => env.JOB_OBJECTS.delete(key)));
  keys.clear();
});

describe("real Workerd FixedLengthStream and R2 semantics", () => {
  it("stores and heads an exact create-only input", async () => {
    const key = objectKey();
    const result = await storeExactInputArtifact({
      bucket: env.JOB_OBJECTS,
      source: stream([Uint8Array.of(1), Uint8Array.of(2, 3)]),
      key,
      byteLength: 3,
      mime: "image/png",
      uploadVersion: 1,
      deadlineAt: Date.now() + 5_000,
    });

    expect(result).toMatchObject({
      kind: "stored",
      artifact: { key, byteLength: 3, mime: "image/png", uploadVersion: 1 },
    });
    const head = await env.JOB_OBJECTS.head(key);
    expect(result.artifact.etag).toBe(head?.etag);
    expect(result.artifact.etag).not.toBe(head?.httpEtag);
  });

  it.each([
    ["short", [Uint8Array.of(1, 2)], 3],
    ["extra", [Uint8Array.of(1, 2, 3, 4)], 3],
  ])("rejects a %s body without retaining an object", async (_label, chunks, byteLength) => {
    const key = objectKey();

    await expect(
      storeExactInputArtifact({
        bucket: env.JOB_OBJECTS,
        source: stream(chunks),
        key,
        byteLength,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 5_000,
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadError);
    await expect(env.JOB_OBJECTS.head(key)).resolves.toBeNull();
  });

  it("settles a short-body failure without a JavaScript unhandled rejection", async () => {
    const key = objectKey();
    const reasons = await captureUnhandledRejections(async () => {
      await expect(
        storeExactInputArtifact({
          bucket: env.JOB_OBJECTS,
          source: stream([Uint8Array.of(1, 2)]),
          key,
          byteLength: 3,
          mime: "image/png",
          uploadVersion: 1,
          deadlineAt: Date.now() + 5_000,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadError);
    });

    expect(reasons).toEqual([]);
    await expect(env.JOB_OBJECTS.head(key)).resolves.toBeNull();
  });

  it("rejects a source error without retaining an object", async () => {
    const key = objectKey();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        controller.error(new Error("source failed"));
      },
    });

    await expect(
      storeExactInputArtifact({
        bucket: env.JOB_OBJECTS,
        source,
        key,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 5_000,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_MISMATCH" });
    await expect(env.JOB_OBJECTS.head(key)).resolves.toBeNull();
  });

  it("aborts a slow upload at the absolute deadline", async () => {
    const key = objectKey();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      storeExactInputArtifact({
        bucket: env.JOB_OBJECTS,
        source,
        key,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 25,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(cancelled).toBe(true);
    await expect(env.JOB_OBJECTS.head(key)).resolves.toBeNull();
  });

  it("preserves the authoritative first writer without asserting retry-body equality", async () => {
    const key = objectKey();
    await env.JOB_OBJECTS.put(key, Uint8Array.of(1, 2, 3), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { kind: "input", uploadVersion: "1" },
    });
    const before = await env.JOB_OBJECTS.head(key);

    const result = await storeExactInputArtifact({
      bucket: env.JOB_OBJECTS,
      source: stream([Uint8Array.of(9, 9, 9)]),
      key,
      byteLength: 3,
      mime: "image/png",
      uploadVersion: 1,
      deadlineAt: Date.now() + 5_000,
    });

    expect(result).toMatchObject({
      kind: "existing-authoritative",
      artifact: { etag: before?.etag },
    });
    const stored = await env.JOB_OBJECTS.get(key);
    await expect(stored?.bytes()).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(env.JOB_OBJECTS.head(key)).resolves.toMatchObject({ etag: before?.etag });
  });

  it("settles two simultaneous create-only uploads with one authoritative first writer", async () => {
    const key = objectKey();
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const firstBody = Uint8Array.of(1, 2, 3);
    const secondBody = Uint8Array.of(9, 8, 7);

    const attempts = [
      storeExactInputArtifact({
        bucket: env.JOB_OBJECTS,
        source: gatedStream(firstBody, gate),
        key,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 5_000,
      }),
      storeExactInputArtifact({
        bucket: env.JOB_OBJECTS,
        source: gatedStream(secondBody, gate),
        key,
        byteLength: 3,
        mime: "image/png",
        uploadVersion: 1,
        deadlineAt: Date.now() + 5_000,
      }),
    ];
    await scheduler.wait(0);
    releaseGate?.();

    const settled = await Promise.allSettled(attempts);
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
    expect(results.map((result) => result.kind).sort()).toEqual([
      "existing-authoritative",
      "stored",
    ]);
    expect(new Set(results.map((result) => result.artifact.etag)).size).toBe(1);

    const authoritative = await env.JOB_OBJECTS.get(key);
    expect(authoritative).not.toBeNull();
    const authoritativeBytes = await authoritative?.bytes();
    expect(
      [firstBody, secondBody].some((candidate) =>
        candidate.every((byte, index) => byte === authoritativeBytes?.[index]),
      ),
    ).toBe(true);
    const authoritativeEtag = authoritative?.etag;
    await scheduler.wait(0);
    await expect(env.JOB_OBJECTS.head(key)).resolves.toMatchObject({
      etag: authoritativeEtag,
      size: 3,
    });
  });
});
