import { z } from "zod";

const MAXIMUM_LINE_BYTES = 4_096;
const MAXIMUM_RECORDS = 1_000_000;
const MAXIMUM_HOURS = 256;
const MAXIMUM_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLER_EVENT_TYPES = new Set(["fetch", "queue", "scheduled"]);

const traceEventSchema = z
  .object({
    CPUTimeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    Entrypoint: z.string().max(128),
    EventTimestampMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    EventType: z.enum(["fetch", "scheduled", "alarm", "queue", "worker_rpc"]),
    Outcome: z.enum(["ok", "canceled", "exception", "unknown"]),
    ScriptName: z.string().min(1).max(128),
    ScriptVersion: z
      .object({
        ID: z.string().regex(UUID_PATTERN),
        Message: z.string().max(2_048).nullable(),
        Tag: z.string().max(256).nullable(),
      })
      .strict(),
  })
  .strict();

export interface StreamingDigest {
  readonly update: (chunk: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<string>;
}

export interface TraceEventParserOptions {
  readonly scriptName: string;
  readonly allowedEntrypoints: ReadonlySet<string>;
  readonly allowedVersionIds: ReadonlySet<string>;
  readonly createDigest: () => StreamingDigest;
  readonly maximumDecompressedBytes?: number;
}

export interface TraceEventHourAggregate {
  readonly hourKey: number;
  readonly invocationCount: number;
  readonly workerCpuMs: number;
  readonly handlerInvocationCount: number;
  readonly payloadSha256: string;
}

export interface ParsedTraceEvents {
  readonly invocationCount: number;
  readonly decompressedBytes: number;
  readonly payloadSha256: string;
  readonly hours: readonly TraceEventHourAggregate[];
}

export function createCloudflareSha256Digest(): StreamingDigest {
  const DigestStreamConstructor = (
    crypto as unknown as {
      DigestStream: new (
        algorithm: string,
      ) => WritableStream<ArrayBuffer | ArrayBufferView> & {
        readonly digest: Promise<ArrayBuffer>;
      };
    }
  ).DigestStream;
  const stream = new DigestStreamConstructor("SHA-256");
  const writer = stream.getWriter();
  let finished = false;
  return {
    update: async (chunk) => {
      if (finished) throw new TypeError("Trace payload digest is already finalized.");
      await writer.write(chunk);
    },
    finish: async () => {
      if (finished) throw new TypeError("Trace payload digest is already finalized.");
      finished = true;
      await writer.close();
      const bytes = new Uint8Array(await stream.digest);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} exceeded the safe integer range.`);
  }
  return value;
}

function joinLine(parts: readonly Uint8Array[], length: number): Uint8Array {
  const line = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    line.set(part, offset);
    offset += part.byteLength;
  }
  return line;
}

export async function parseTraceEventNdjson(
  stream: ReadableStream<Uint8Array>,
  options: TraceEventParserOptions,
): Promise<ParsedTraceEvents> {
  if (options.scriptName.length < 1 || options.scriptName.length > 128) {
    throw new TypeError("Trace script name must be bounded.");
  }
  if (options.allowedEntrypoints.size < 1 || options.allowedVersionIds.size < 1) {
    throw new TypeError("Trace parser allowlists must not be empty.");
  }
  const maximumDecompressedBytes = options.maximumDecompressedBytes ?? MAXIMUM_DECOMPRESSED_BYTES;
  if (
    !Number.isSafeInteger(maximumDecompressedBytes) ||
    maximumDecompressedBytes < 1 ||
    maximumDecompressedBytes > MAXIMUM_DECOMPRESSED_BYTES
  ) {
    throw new RangeError("Trace decompression bound must be between 1 byte and 256 MiB.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const digest = options.createDigest();
  const pending: Uint8Array[] = [];
  const hours = new Map<
    number,
    Omit<TraceEventHourAggregate, "payloadSha256"> & { readonly digest: StreamingDigest }
  >();
  let pendingBytes = 0;
  let decompressedBytes = 0;
  let invocationCount = 0;

  const parseLine = async (parts: readonly Uint8Array[], byteLength: number) => {
    if (byteLength < 1) throw new TypeError("Trace log contains an empty line.");
    const line = joinLine(parts, byteLength);
    const parsedJson = JSON.parse(decoder.decode(line)) as unknown;
    const event = traceEventSchema.parse(parsedJson);
    if (event.ScriptName !== options.scriptName) {
      throw new TypeError("Trace log belongs to an unexpected Worker script.");
    }
    if (!options.allowedVersionIds.has(event.ScriptVersion.ID)) {
      throw new TypeError("Trace log contains an unattested Worker version.");
    }
    if (!options.allowedEntrypoints.has(event.Entrypoint)) {
      throw new TypeError("Trace log contains an unexpected Worker entrypoint.");
    }

    invocationCount = checkedAdd(invocationCount, 1, "Trace invocation count");
    if (invocationCount > MAXIMUM_RECORDS) {
      throw new RangeError("Trace log record count exceeds the parser bound.");
    }
    const hourKey = Math.floor(event.EventTimestampMs / 3_600_000);
    const prior = hours.get(hourKey);
    const hourDigest = prior?.digest ?? options.createDigest();
    await hourDigest.update(line);
    await hourDigest.update(Uint8Array.of(0x0a));
    const next = {
      hourKey,
      invocationCount: checkedAdd(prior?.invocationCount ?? 0, 1, "Hourly invocation count"),
      workerCpuMs: checkedAdd(prior?.workerCpuMs ?? 0, event.CPUTimeMs, "Hourly Worker CPU"),
      handlerInvocationCount: checkedAdd(
        prior?.handlerInvocationCount ?? 0,
        HANDLER_EVENT_TYPES.has(event.EventType) && event.Entrypoint === "" ? 1 : 0,
        "Hourly handler invocation count",
      ),
      digest: hourDigest,
    };
    hours.set(hourKey, next);
    if (hours.size > MAXIMUM_HOURS) {
      throw new RangeError("Trace log spans too many UTC hours.");
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      decompressedBytes = checkedAdd(
        decompressedBytes,
        value.byteLength,
        "Decompressed trace bytes",
      );
      if (decompressedBytes > maximumDecompressedBytes) {
        throw new RangeError("Decompressed trace payload exceeds its configured bound.");
      }
      await digest.update(value);
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        const part = value.slice(start, index);
        const lineBytes = checkedAdd(pendingBytes, part.byteLength, "Trace line bytes");
        if (lineBytes > MAXIMUM_LINE_BYTES) throw new RangeError("Trace line exceeds 4 KiB.");
        await parseLine([...pending, part], lineBytes);
        pending.length = 0;
        pendingBytes = 0;
        start = index + 1;
      }
      if (start < value.byteLength) {
        const tail = value.slice(start);
        pendingBytes = checkedAdd(pendingBytes, tail.byteLength, "Trace line bytes");
        if (pendingBytes > MAXIMUM_LINE_BYTES) throw new RangeError("Trace line exceeds 4 KiB.");
        pending.push(tail);
      }
    }
    if (pendingBytes > 0) await parseLine(pending, pendingBytes);
    const payloadSha256 = await digest.finish();
    if (!/^[0-9a-f]{64}$/.test(payloadSha256)) {
      throw new TypeError("Trace payload digest is not canonical SHA-256.");
    }
    const finalizedHours = await Promise.all(
      [...hours.values()]
        .sort((left, right) => left.hourKey - right.hourKey)
        .map(async ({ digest: hourDigest, ...hour }) => {
          const hourPayloadSha256 = await hourDigest.finish();
          if (!/^[0-9a-f]{64}$/.test(hourPayloadSha256)) {
            throw new TypeError("Hourly trace payload digest is not canonical SHA-256.");
          }
          return { ...hour, payloadSha256: hourPayloadSha256 };
        }),
    );
    return {
      invocationCount,
      decompressedBytes,
      payloadSha256,
      hours: finalizedHours,
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function parseGzipTraceEvents(
  stream: ReadableStream<Uint8Array>,
  options: TraceEventParserOptions,
): Promise<ParsedTraceEvents> {
  const decompressor = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return parseTraceEventNdjson(stream.pipeThrough(decompressor), options);
}
