import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGzipTraceEvents, parseTraceEventNdjson } from "./usage-log-parser";

const versionId = "550e8400-e29b-41d4-a716-446655440000";

function record(overrides: Record<string, unknown> = {}) {
  return {
    CPUTimeMs: 7,
    Entrypoint: "",
    EventTimestampMs: 3_600_123,
    EventType: "fetch",
    Outcome: "ok",
    ScriptName: "hereisit-processing-staging",
    ScriptVersion: { ID: versionId, Message: "release", Tag: "staging" },
    ...overrides,
  };
}

function chunked(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

const options = {
  scriptName: "hereisit-processing-staging",
  allowedEntrypoints: new Set(["", "ImageEngineContainer", "PdfEngineContainer"]),
  createDigest: () => ({
    update: async () => undefined,
    finish: async () => "a".repeat(64),
  }),
};

function nodeDigest() {
  const hash = createHash("sha256");
  return {
    update: async (chunk: Uint8Array) => {
      hash.update(chunk);
    },
    finish: async () => hash.digest("hex"),
  };
}

describe("Workers Trace Events usage-log parser", () => {
  it("aggregates arbitrarily chunked records by event-start hour", async () => {
    const input = `${JSON.stringify(record())}\n${JSON.stringify(
      record({ CPUTimeMs: 5, EventTimestampMs: 3_700_000, EventType: "alarm" }),
    )}\n${JSON.stringify(
      record({
        CPUTimeMs: 2,
        Entrypoint: "ImageEngineContainer",
        EventTimestampMs: 3_800_000,
      }),
    )}\n`;

    await expect(parseTraceEventNdjson(chunked(input, 3), options)).resolves.toMatchObject({
      invocationCount: 3,
      hours: [
        {
          hourKey: 1,
          invocationCount: 3,
          workerCpuMs: 14,
          handlerInvocationCount: 1,
        },
      ],
      decompressedBytes: new TextEncoder().encode(input).byteLength,
    });
  });

  it("accepts both processing containers and rejects an unknown entrypoint", async () => {
    const input = `${JSON.stringify(record({ Entrypoint: "ImageEngineContainer" }))}\n${JSON.stringify(
      record({ Entrypoint: "PdfEngineContainer", CPUTimeMs: 3 }),
    )}\n`;

    await expect(parseTraceEventNdjson(chunked(input, 7), options)).resolves.toMatchObject({
      invocationCount: 2,
      hours: [{ invocationCount: 2, workerCpuMs: 10, handlerInvocationCount: 0 }],
    });
    await expect(
      parseTraceEventNdjson(
        chunked(`${JSON.stringify(record({ Entrypoint: "UnknownContainer" }))}\n`, 7),
        options,
      ),
    ).rejects.toThrow();
  });

  it.each([
    record({ EventType: "email" }),
    record({ Outcome: "exceededCpu" }),
    record({ ScriptName: "other-worker" }),
    { ...record(), Event: { request: { url: "https://private.example" } } },
  ])("rejects unapproved values or any extra privacy-sensitive field", async (value) => {
    await expect(
      parseTraceEventNdjson(chunked(`${JSON.stringify(value)}\n`, 64), options),
    ).rejects.toThrow();
  });

  it("accepts canonical versions emitted by failed deployments of the exact Worker", async () => {
    const value = record({
      ScriptVersion: { ID: crypto.randomUUID(), Message: "failed deployment", Tag: null },
    });

    await expect(
      parseTraceEventNdjson(chunked(`${JSON.stringify(value)}\n`, 64), options),
    ).resolves.toMatchObject({ invocationCount: 1 });
  });

  it("cancels after a line crosses the 4 KiB bound", async () => {
    await expect(
      parseTraceEventNdjson(chunked(`${"x".repeat(4_097)}\n`, 257), options),
    ).rejects.toThrow(/4 KiB/i);
  });

  it("stops a decompression bomb at the configured streaming byte bound", async () => {
    await expect(
      parseTraceEventNdjson(chunked("123456789", 9), {
        ...options,
        maximumDecompressedBytes: 8,
      }),
    ).rejects.toThrow(/configured bound/i);
  });

  it("decompresses gzip incrementally and returns the exact payload digest", async () => {
    const input = `${JSON.stringify(record())}\n`;
    const compressor = new CompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    const compressed = chunked(input, 11).pipeThrough(compressor);

    await expect(
      parseGzipTraceEvents(compressed, { ...options, createDigest: nodeDigest }),
    ).resolves.toMatchObject({
      invocationCount: 1,
      payloadSha256: createHash("sha256").update(input).digest("hex"),
    });
  });

  it("hashes each UTC hour from canonical newline-terminated source records", async () => {
    const first = JSON.stringify(record({ EventTimestampMs: 3_600_000 }));
    const second = JSON.stringify(record({ EventTimestampMs: 7_200_000, CPUTimeMs: 3 }));

    const parsed = await parseTraceEventNdjson(chunked(`${first}\n${second}`, 17), {
      ...options,
      createDigest: nodeDigest,
    });

    expect(parsed.hours).toEqual([
      expect.objectContaining({
        hourKey: 1,
        payloadSha256: createHash("sha256").update(`${first}\n`).digest("hex"),
      }),
      expect.objectContaining({
        hourKey: 2,
        payloadSha256: createHash("sha256").update(`${second}\n`).digest("hex"),
      }),
    ]);
  });
});
