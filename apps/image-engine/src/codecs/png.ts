import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflate } from "node:zlib";
import sharp from "sharp";
import type { ImageInspection } from "../pipeline/inspect";
import { RecoverableCandidateError } from "../pipeline/optimize";
import type { OptimizationCandidatePlan } from "../pipeline/plan";
import { type CommandResult, runBoundedCommand } from "./command";
import type { CodecCandidate } from "./jpeg";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngChunkInspection {
  readonly colorType: number;
  readonly paletteEntries: number | null;
  readonly ancillary: readonly string[];
  readonly transparentEntries: number;
}

export type PngCodecFailureReason = "codec-failed" | "invalid-output" | "alpha-mismatch";

export class PngCodecError extends Error {
  constructor(readonly reason: PngCodecFailureReason) {
    super(`PNG candidate failed: ${reason}`);
    this.name = "PngCodecError";
  }
}

type CommandRunner = (input: Parameters<typeof runBoundedCommand>[0]) => Promise<CommandResult>;

export function buildOxiPngArgs(outputPath: string, normalizedPngPath: string): string[] {
  return ["-o", "3", "--strip", "safe", "--out", outputPath, normalizedPngPath];
}

export function isSmartPngEligible(inspection: ImageInspection): boolean {
  return (
    inspection.format === "png" &&
    inspection.bitDepth === 8 &&
    !inspection.animated &&
    !inspection.wideGamut &&
    (inspection.iccProfileKind === "none" || inspection.iccProfileKind === "srgb-compatible")
  );
}

export function inspectPngChunks(bytes: Uint8Array): PngChunkInspection {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.byteLength < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngCodecError("invalid-output");
  }
  let offset = 8;
  let colorType = -1;
  let paletteEntries: number | null = null;
  let transparentEntries = 0;
  const chunks: string[] = [];
  let ended = false;
  while (offset <= data.byteLength - 12) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.byteLength) throw new PngCodecError("invalid-output");
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const body = data.subarray(offset + 8, offset + 8 + length);
    chunks.push(type);
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new PngCodecError("invalid-output");
      colorType = body[9] as number;
    } else if (type === "PLTE") {
      if (length < 3 || length > 768 || length % 3 !== 0 || paletteEntries !== null) {
        throw new PngCodecError("invalid-output");
      }
      paletteEntries = length / 3;
    } else if (type === "tRNS") {
      if (
        paletteEntries === null ||
        length < 1 ||
        length > paletteEntries ||
        body[length - 1] === 255
      ) {
        throw new PngCodecError("invalid-output");
      }
      transparentEntries = length;
    } else if (type === "IEND") {
      if (length !== 0 || end !== data.byteLength) throw new PngCodecError("invalid-output");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || colorType < 0) throw new PngCodecError("invalid-output");
  return { colorType, paletteEntries, ancillary: chunks, transparentEntries };
}

class RgbToRgbaTransform extends Transform {
  private carry = Buffer.alloc(0);
  private written = 0;

  constructor(private readonly expectedBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    try {
      const combined = this.carry.byteLength === 0 ? chunk : Buffer.concat([this.carry, chunk]);
      const complete = combined.byteLength - (combined.byteLength % 3);
      const pixels = complete / 3;
      const output = Buffer.allocUnsafe(pixels * 4);
      for (let source = 0, target = 0; source < complete; source += 3, target += 4) {
        output[target] = combined[source] as number;
        output[target + 1] = combined[source + 1] as number;
        output[target + 2] = combined[source + 2] as number;
        output[target + 3] = 255;
      }
      this.carry = Buffer.from(combined.subarray(complete));
      this.written += output.byteLength;
      if (output.byteLength > 0) this.push(output);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error) => void) {
    if (this.carry.byteLength !== 0 || this.written !== this.expectedBytes) {
      callback(new PngCodecError("invalid-output"));
      return;
    }
    callback();
  }
}

export async function expandRgbToRgbaFile(input: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly highWaterMark?: number;
}): Promise<void> {
  const expectedRgb = input.width * input.height * 3;
  const information = await stat(input.inputPath);
  if (!information.isFile() || information.size !== expectedRgb) {
    throw new PngCodecError("invalid-output");
  }
  await pipeline(
    createReadStream(input.inputPath, {
      ...(input.highWaterMark === undefined ? {} : { highWaterMark: input.highWaterMark }),
    }),
    new RgbToRgbaTransform(input.width * input.height * 4),
    createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 }),
  );
  if ((await stat(input.outputPath)).size !== input.width * input.height * 4) {
    throw new PngCodecError("invalid-output");
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function hashAlpha(path: string, channels: 4, sampleBytes: 1 | 2): Promise<string> {
  const pixelBytes = channels * sampleBytes;
  const hash = createHash("sha256");
  let carry = Buffer.alloc(0);
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.from(raw as Buffer);
    const combined = carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
    const complete = combined.byteLength - (combined.byteLength % pixelBytes);
    const alpha = Buffer.allocUnsafe((complete / pixelBytes) * sampleBytes);
    for (let source = (channels - 1) * sampleBytes, target = 0; source < complete; ) {
      combined.copy(alpha, target, source, source + sampleBytes);
      source += pixelBytes;
      target += sampleBytes;
    }
    hash.update(alpha);
    carry = Buffer.from(combined.subarray(complete));
  }
  if (carry.byteLength !== 0) throw new PngCodecError("invalid-output");
  return hash.digest("hex");
}

async function encodeNormalizedPng(input: {
  readonly normalizedPath: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly sampleDepth: 8 | 16;
}): Promise<void> {
  const sampleBytes = input.sampleDepth / 8;
  const information = await stat(input.normalizedPath);
  if (
    !information.isFile() ||
    information.size !== input.width * input.height * input.channels * sampleBytes
  ) {
    throw new PngCodecError("invalid-output");
  }
  if (input.sampleDepth === 16) {
    await encode16BitPng(input);
    return;
  }
  const rawInput = {
    raw: {
      width: input.width,
      height: input.height,
      channels: input.channels,
      depth: "uchar",
    },
  };
  const encoder = sharp(rawInput);
  encoder.png({ compressionLevel: 6, adaptiveFiltering: true, palette: false });
  await pipeline(
    createReadStream(input.normalizedPath),
    encoder,
    createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 }),
  );
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.allocUnsafe(12 + body.byteLength);
  result.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(result, 4);
  Buffer.from(body).copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(body)])), 8 + body.byteLength);
  return result;
}

class PngScanlineTransform extends Transform {
  private carry = Buffer.alloc(0);
  private rows = 0;

  constructor(
    private readonly rowBytes: number,
    private readonly expectedRows: number,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    try {
      const combined = this.carry.byteLength === 0 ? chunk : Buffer.concat([this.carry, chunk]);
      const complete = combined.byteLength - (combined.byteLength % this.rowBytes);
      for (let offset = 0; offset < complete; offset += this.rowBytes) {
        const scanline = Buffer.allocUnsafe(this.rowBytes + 1);
        scanline[0] = 0;
        combined.copy(scanline, 1, offset, offset + this.rowBytes);
        scanline.subarray(1).swap16();
        this.push(scanline);
        this.rows += 1;
      }
      this.carry = Buffer.from(combined.subarray(complete));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error) => void) {
    if (this.carry.byteLength !== 0 || this.rows !== this.expectedRows) {
      callback(new PngCodecError("invalid-output"));
      return;
    }
    callback();
  }
}

async function encode16BitPng(input: {
  readonly normalizedPath: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
}): Promise<void> {
  const handle = await open(input.outputPath, "wx", 0o600);
  try {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(input.width, 0);
    ihdr.writeUInt32BE(input.height, 4);
    ihdr[8] = 16;
    ihdr[9] = input.channels === 4 ? 6 : 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    await handle.write(Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr)]));
    const idatWriter = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        handle.write(pngChunk("IDAT", chunk)).then(
          () => callback(),
          (error) => callback(error),
        );
      },
    });
    await pipeline(
      createReadStream(input.normalizedPath),
      new PngScanlineTransform(input.width * input.channels * 2, input.height),
      createDeflate({ level: 6 }),
      idatWriter,
    );
    await handle.write(pngChunk("IEND", Buffer.alloc(0)));
  } finally {
    await handle.close();
  }
}

async function decodedRawHash(input: {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly sampleDepth: 8 | 16;
}): Promise<{ raw: string; alpha: string | null }> {
  const hash = createHash("sha256");
  const alpha = input.channels === 4 ? createHash("sha256") : null;
  const sampleBytes = input.sampleDepth / 8;
  const pixelBytes = input.channels * sampleBytes;
  let carry = Buffer.alloc(0);
  let bytes = 0;
  let decoder = sharp(input.path, { failOn: "error", sequentialRead: true });
  decoder = input.channels === 4 ? decoder.ensureAlpha() : decoder.removeAlpha();
  if (input.sampleDepth === 16) decoder = decoder.toColourspace("rgb16");
  const raw = decoder.raw({ depth: input.sampleDepth === 16 ? "ushort" : "uchar" });
  let info: { width: number; height: number; channels: number } | null = null;
  raw.once("info", (value) => {
    info = value;
  });
  for await (const value of raw) {
    const chunk = Buffer.from(value as Buffer);
    hash.update(chunk);
    bytes += chunk.byteLength;
    if (alpha !== null) {
      const combined = carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
      const complete = combined.byteLength - (combined.byteLength % pixelBytes);
      const alphaBytes = Buffer.allocUnsafe((complete / pixelBytes) * sampleBytes);
      for (let source = (input.channels - 1) * sampleBytes, target = 0; source < complete; ) {
        combined.copy(alphaBytes, target, source, source + sampleBytes);
        source += pixelBytes;
        target += sampleBytes;
      }
      alpha.update(alphaBytes);
      carry = Buffer.from(combined.subarray(complete));
    }
  }
  const actual = info as { width: number; height: number; channels: number } | null;
  if (
    actual === null ||
    actual.width !== input.width ||
    actual.height !== input.height ||
    actual.channels !== input.channels ||
    bytes !== input.width * input.height * pixelBytes ||
    carry.byteLength !== 0
  ) {
    throw new PngCodecError("invalid-output");
  }
  return { raw: hash.digest("hex"), alpha: alpha?.digest("hex") ?? null };
}

async function validatePng(input: {
  readonly path: string;
  readonly normalizedPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly sampleDepth: 8 | 16;
  readonly requirePixelExact: boolean;
  readonly requireIndexed: boolean;
  readonly maximumColors: number | null;
}): Promise<number> {
  try {
    const information = await stat(input.path);
    if (!information.isFile() || information.size < 33) throw new PngCodecError("invalid-output");
    const chunks = inspectPngChunks(await readFile(input.path));
    if (
      chunks.ancillary.some((type) => ["eXIf", "iTXt", "tEXt", "zTXt"].includes(type)) ||
      (input.requireIndexed &&
        (chunks.colorType !== 3 ||
          chunks.paletteEntries === null ||
          chunks.paletteEntries > (input.maximumColors ?? 256) ||
          (input.channels === 3 && chunks.transparentEntries !== 0)))
    ) {
      throw new PngCodecError("invalid-output");
    }
    const decoded = await decodedRawHash(input);
    if (input.requirePixelExact && decoded.raw !== (await hashFile(input.normalizedPath))) {
      throw new PngCodecError("invalid-output");
    }
    if (input.channels === 4) {
      const expectedAlpha = await hashAlpha(
        input.normalizedPath,
        4,
        input.sampleDepth === 16 ? 2 : 1,
      );
      if (decoded.alpha !== expectedAlpha) throw new PngCodecError("alpha-mismatch");
    }
    return information.size;
  } catch (error) {
    if (error instanceof PngCodecError) throw error;
    throw new PngCodecError("invalid-output");
  }
}

export async function encodePngCandidate(input: {
  readonly normalizedPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly sampleDepth: 8 | 16;
  readonly candidate: OptimizationCandidatePlan;
  readonly outputPath: string;
  readonly signal: AbortSignal;
  readonly run?: CommandRunner;
  readonly onProcessGroup?: (event: { action: "add" | "remove"; pgid: number }) => void;
}): Promise<CodecCandidate> {
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1
  ) {
    throw new PngCodecError("codec-failed");
  }
  const lossless = input.candidate.codec === "oxipng" && input.candidate.mode === "lossless";
  const colors = input.candidate.quality;
  const smart =
    input.candidate.codec === "quantizr-oxipng" &&
    input.candidate.mode === `quantized-${colors}` &&
    colors !== undefined &&
    Number.isSafeInteger(colors) &&
    colors >= 2 &&
    colors <= 256 &&
    input.sampleDepth === 8;
  if (!lossless && !smart) throw new PngCodecError("codec-failed");

  const basePath = join(dirname(input.outputPath), `${input.candidate.id}.base.png`);
  const rgbaPath = join(dirname(input.outputPath), `${input.candidate.id}.rgba`);
  const palettePath = join(dirname(input.outputPath), `${input.candidate.id}.palette.png`);
  const run = input.run ?? runBoundedCommand;
  let elapsedMs = 0;
  try {
    if (lossless) {
      await encodeNormalizedPng({
        normalizedPath: input.normalizedPath,
        outputPath: basePath,
        width: input.width,
        height: input.height,
        channels: input.channels,
        sampleDepth: input.sampleDepth,
      });
    } else if (input.channels === 3) {
      await expandRgbToRgbaFile({
        inputPath: input.normalizedPath,
        outputPath: rgbaPath,
        width: input.width,
        height: input.height,
      });
    } else {
      const information = await stat(input.normalizedPath);
      if (!information.isFile() || information.size !== input.width * input.height * 4) {
        throw new PngCodecError("invalid-output");
      }
    }

    if (smart) {
      const quantized = await run({
        command: "/usr/local/bin/png-smart",
        args: [
          "--input-rgba",
          input.channels === 4 ? input.normalizedPath : rgbaPath,
          "--width",
          String(input.width),
          "--height",
          String(input.height),
          "--colors",
          String(colors),
          "--output",
          palettePath,
        ],
        cwd: dirname(input.outputPath),
        timeoutMs: 15_000,
        signal: input.signal,
        ...(input.onProcessGroup === undefined ? {} : { onProcessGroup: input.onProcessGroup }),
      });
      elapsedMs += quantized.elapsedMs;
      if (quantized.exitCode !== 0) throw new RecoverableCandidateError("codec-rejected");
      await chmod(palettePath, 0o600);
      try {
        await validatePng({
          path: palettePath,
          normalizedPath: input.normalizedPath,
          width: input.width,
          height: input.height,
          channels: input.channels,
          sampleDepth: 8,
          requirePixelExact: false,
          requireIndexed: true,
          maximumColors: colors as number,
        });
      } catch (error) {
        if (error instanceof PngCodecError && error.reason === "alpha-mismatch") {
          throw new RecoverableCandidateError("alpha-mismatch");
        }
        throw error;
      }
    }
    const optimized = await run({
      command: "/usr/local/bin/oxipng",
      args: buildOxiPngArgs(input.outputPath, lossless ? basePath : palettePath),
      cwd: dirname(input.outputPath),
      timeoutMs: 15_000,
      signal: input.signal,
      ...(input.onProcessGroup === undefined ? {} : { onProcessGroup: input.onProcessGroup }),
    });
    elapsedMs += optimized.elapsedMs;
    if (optimized.exitCode !== 0) throw new PngCodecError("codec-failed");
    await chmod(input.outputPath, 0o600);
    let byteLength: number;
    try {
      byteLength = await validatePng({
        path: input.outputPath,
        normalizedPath: input.normalizedPath,
        width: input.width,
        height: input.height,
        channels: input.channels,
        sampleDepth: input.sampleDepth,
        requirePixelExact: lossless,
        requireIndexed: false,
        maximumColors: null,
      });
    } catch (error) {
      if (smart && error instanceof PngCodecError && error.reason === "alpha-mismatch") {
        throw new RecoverableCandidateError("alpha-mismatch");
      }
      throw error;
    }
    return {
      id: input.candidate.id,
      path: input.outputPath,
      mime: "image/png",
      byteLength,
      encodeMs: elapsedMs,
      codecBuildId: smart ? "quantizr-1.4.3+oxipng-10.1.1" : "oxipng-10.1.1",
      mode: input.candidate.mode,
    };
  } catch (error) {
    await unlink(input.outputPath).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all(
      [basePath, rgbaPath, palettePath].map((path) => unlink(path).catch(() => undefined)),
    );
  }
}
