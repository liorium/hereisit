import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { RecoverableCandidateError } from "../pipeline/optimize";
import type { OptimizationCandidatePlan } from "../pipeline/plan";
import { type CommandResult, runBoundedCommand } from "./command";
import type { CodecCandidate } from "./jpeg";

export interface WebpInspection {
  readonly animated: boolean;
  readonly hasIcc: boolean;
  readonly hasExif: boolean;
  readonly hasXmp: boolean;
  readonly chunks: readonly string[];
}

export class WebpCodecError extends Error {
  constructor(readonly reason: "codec-failed" | "invalid-output" | "alpha-mismatch") {
    super(`WebP candidate failed: ${reason}`);
    this.name = "WebpCodecError";
  }
}

type CommandRunner = (input: Parameters<typeof runBoundedCommand>[0]) => Promise<CommandResult>;

export function buildWebpArgs(
  candidate: OptimizationCandidatePlan,
  normalizedPngPath: string,
  outputPath: string,
): string[] {
  if (candidate.codec !== "libwebp") throw new WebpCodecError("codec-failed");
  let mode: string[];
  if (candidate.mode === "lossless") mode = ["-lossless", "-m", String(candidate.effort)];
  else if (candidate.mode === "lossy" && candidate.quality !== undefined) {
    mode = ["-q", String(candidate.quality), "-m", String(candidate.effort)];
  } else if (candidate.mode === "near-lossless" && candidate.quality !== undefined) {
    mode = ["-near_lossless", String(candidate.quality), "-m", String(candidate.effort)];
  } else {
    throw new WebpCodecError("codec-failed");
  }
  return [...mode, "-exact", "-metadata", "none", normalizedPngPath, "-o", outputPath];
}

export function inspectWebp(bytes: Uint8Array): WebpInspection {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.byteLength < 20 ||
    data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.readUInt32LE(4) !== data.byteLength - 8 ||
    data.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new WebpCodecError("invalid-output");
  }
  const chunks: string[] = [];
  let animated = false;
  let offset = 12;
  while (offset <= data.byteLength - 8) {
    const type = data.subarray(offset, offset + 4).toString("ascii");
    const length = data.readUInt32LE(offset + 4);
    const padded = length + (length & 1);
    if (offset + 8 + padded > data.byteLength) throw new WebpCodecError("invalid-output");
    chunks.push(type);
    if (type === "ANIM" || type === "ANMF") animated = true;
    if (type === "VP8X") {
      if (length !== 10) throw new WebpCodecError("invalid-output");
      animated ||= ((data[offset + 8] as number) & 0x02) !== 0;
    }
    offset += 8 + padded;
  }
  if (
    offset !== data.byteLength ||
    !chunks.some((type) => ["VP8 ", "VP8L", "VP8X"].includes(type))
  ) {
    throw new WebpCodecError("invalid-output");
  }
  return {
    animated,
    hasIcc: chunks.includes("ICCP"),
    hasExif: chunks.includes("EXIF"),
    hasXmp: chunks.includes("XMP "),
    chunks,
  };
}

async function hashRaw(
  path: string,
  channels: 3 | 4,
): Promise<{ raw: string; alpha: string | null }> {
  let decoder = sharp(path, { failOn: "error", sequentialRead: true });
  decoder = channels === 4 ? decoder.ensureAlpha() : decoder.removeAlpha();
  const raw = decoder.raw();
  const rawHash = createHash("sha256");
  const alphaHash = channels === 4 ? createHash("sha256") : null;
  let carry = Buffer.alloc(0);
  for await (const value of raw) {
    const chunk = Buffer.from(value as Buffer);
    rawHash.update(chunk);
    if (alphaHash !== null) {
      const combined = carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
      const complete = combined.byteLength - (combined.byteLength % 4);
      const alpha = Buffer.allocUnsafe(complete / 4);
      for (let source = 3, target = 0; source < complete; source += 4, target += 1) {
        alpha[target] = combined[source] as number;
      }
      alphaHash.update(alpha);
      carry = Buffer.from(combined.subarray(complete));
    }
  }
  if (carry.byteLength !== 0) throw new WebpCodecError("invalid-output");
  return { raw: rawHash.digest("hex"), alpha: alphaHash?.digest("hex") ?? null };
}

async function hashNormalized(path: string, channels: 3 | 4) {
  const rawHash = createHash("sha256");
  const alphaHash = channels === 4 ? createHash("sha256") : null;
  let carry = Buffer.alloc(0);
  for await (const value of createReadStream(path)) {
    const chunk = Buffer.from(value as Buffer);
    rawHash.update(chunk);
    if (alphaHash !== null) {
      const combined = carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
      const complete = combined.byteLength - (combined.byteLength % 4);
      const alpha = Buffer.allocUnsafe(complete / 4);
      for (let source = 3, target = 0; source < complete; source += 4, target += 1) {
        alpha[target] = combined[source] as number;
      }
      alphaHash.update(alpha);
      carry = Buffer.from(combined.subarray(complete));
    }
  }
  if (carry.byteLength !== 0) throw new WebpCodecError("invalid-output");
  return { raw: rawHash.digest("hex"), alpha: alphaHash?.digest("hex") ?? null };
}

async function writeBasePng(input: {
  readonly normalizedPath: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
}): Promise<void> {
  const information = await stat(input.normalizedPath);
  if (!information.isFile() || information.size !== input.width * input.height * input.channels) {
    throw new WebpCodecError("invalid-output");
  }
  const encoder = sharp({
    raw: { width: input.width, height: input.height, channels: input.channels },
  }).png({ compressionLevel: 1, adaptiveFiltering: false, palette: false });
  await pipeline(
    createReadStream(input.normalizedPath),
    encoder,
    createWriteStream(input.outputPath, { flags: "wx", mode: 0o600 }),
  );
}

export async function encodeWebpCandidate(input: {
  readonly normalizedPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly candidate: OptimizationCandidatePlan;
  readonly outputPath: string;
  readonly signal: AbortSignal;
  readonly run?: CommandRunner;
  readonly onProcessGroup?: (event: { action: "add" | "remove"; pgid: number }) => void;
}): Promise<CodecCandidate> {
  if (input.width < 1 || input.height < 1 || input.candidate.codec !== "libwebp") {
    throw new WebpCodecError("codec-failed");
  }
  const normalizedPngPath = join(dirname(input.outputPath), `${input.candidate.id}.base.png`);
  const run = input.run ?? runBoundedCommand;
  try {
    await writeBasePng({ ...input, outputPath: normalizedPngPath });
    const result = await run({
      command: "/usr/local/bin/cwebp",
      args: buildWebpArgs(input.candidate, normalizedPngPath, input.outputPath),
      cwd: dirname(input.outputPath),
      timeoutMs: 15_000,
      signal: input.signal,
      ...(input.onProcessGroup === undefined ? {} : { onProcessGroup: input.onProcessGroup }),
    });
    if (result.exitCode !== 0) throw new WebpCodecError("codec-failed");
    await chmod(input.outputPath, 0o600);
    const bytes = await readFile(input.outputPath);
    const structure = inspectWebp(bytes);
    const metadata = await sharp(input.outputPath, { failOn: "error" }).metadata();
    if (
      structure.animated ||
      structure.hasIcc ||
      structure.hasExif ||
      structure.hasXmp ||
      metadata.format !== "webp" ||
      metadata.width !== input.width ||
      metadata.height !== input.height ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new WebpCodecError("invalid-output");
    }
    const normalized = await hashNormalized(input.normalizedPath, input.channels);
    const decoded = await hashRaw(input.outputPath, input.channels);
    if (input.channels === 4 && normalized.alpha !== decoded.alpha) {
      throw new WebpCodecError("alpha-mismatch");
    }
    if (input.candidate.mode === "lossless" && normalized.raw !== decoded.raw) {
      throw new WebpCodecError("invalid-output");
    }
    return {
      id: input.candidate.id,
      path: input.outputPath,
      mime: "image/webp",
      byteLength: bytes.byteLength,
      encodeMs: result.elapsedMs,
      codecBuildId: "libwebp-1.6.0+4fa2191",
      mode: input.candidate.mode,
    };
  } catch (error) {
    await unlink(input.outputPath).catch(() => undefined);
    if (error instanceof WebpCodecError && error.reason === "alpha-mismatch") {
      throw new RecoverableCandidateError("alpha-mismatch");
    }
    if (error instanceof WebpCodecError) throw error;
    throw new WebpCodecError("invalid-output");
  } finally {
    await unlink(normalizedPngPath).catch(() => undefined);
  }
}
