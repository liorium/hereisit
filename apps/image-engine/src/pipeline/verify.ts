import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { ImageContentClass } from "@hereisit/server-contracts";
import sharp from "sharp";
import type { CodecCandidate } from "../codecs/jpeg";
import { inspectPngChunks } from "../codecs/png";
import { inspectWebp } from "../codecs/webp";
import type { ImageInspection } from "./inspect";
import type { NormalizedImage } from "./normalize";

export interface CandidateVerification {
  readonly accepted: boolean;
  readonly reason:
    | "accepted"
    | "not-smaller"
    | "insufficient-savings"
    | "signature"
    | "decode"
    | "dimensions"
    | "orientation"
    | "color"
    | "alpha"
    | "pixel-hash"
    | "coefficient-transform"
    | "quality";
  readonly liveQuality: LiveQuality | null;
}

export interface LiveQuality {
  readonly metricVersion: "hereisit-live-quality-v1";
  readonly worstSsim: number;
  readonly worstMeanChannelDelta: number;
  readonly worstEdgeLoss: number;
}

export type VerifiedOptimizationResult =
  | {
      readonly kind: "download";
      readonly selected: CodecCandidate;
      readonly testedCandidates: number;
      readonly width: number;
      readonly height: number;
      readonly mime: "image/jpeg" | "image/png" | "image/webp";
    }
  | {
      readonly kind: "original-retained";
      readonly testedCandidates: number;
      readonly width: number;
      readonly height: number;
      readonly mime: "image/jpeg" | "image/png" | "image/webp";
    };

export const liveQualityFloor = {
  balanced: {
    defaultSsim: 0.97,
    screenshotTextSsim: 0.985,
    maxMeanChannelDelta: 5 / 255,
    screenshotTextMaxMeanChannelDelta: 2 / 255,
    maxEdgeLoss: 0.03,
    screenshotTextMaxEdgeLoss: 0.02,
  },
  smallest: {
    defaultSsim: 0.94,
    screenshotTextSsim: 0.97,
    maxMeanChannelDelta: 10 / 255,
    screenshotTextMaxMeanChannelDelta: 3 / 255,
    maxEdgeLoss: 0.055,
    screenshotTextMaxEdgeLoss: 0.04,
  },
} as const;

function reflected(index: number, length: number): number {
  if (length <= 1) return 0;
  let value = index;
  while (value < 0 || value >= length) {
    if (value < 0) value = -value - 1;
    if (value >= length) value = 2 * length - value - 1;
  }
  return value;
}

const gaussian = (() => {
  const values = Array.from({ length: 11 }, (_, index) => Math.exp(-((index - 5) ** 2) / 4.5));
  const sum = values.reduce((total, value) => total + value, 0);
  return values.map((value) => value / sum);
})();

function blur(values: Float64Array, width: number, height: number): Float64Array {
  const horizontal = new Float64Array(values.length);
  const output = new Float64Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let tap = -5; tap <= 5; tap += 1) {
        value +=
          (values[y * width + reflected(x + tap, width)] as number) * (gaussian[tap + 5] as number);
      }
      horizontal[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let tap = -5; tap <= 5; tap += 1) {
        value +=
          (horizontal[reflected(y + tap, height) * width + x] as number) *
          (gaussian[tap + 5] as number);
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function ssim(
  source: Float64Array,
  candidate: Float64Array,
  width: number,
  height: number,
): number {
  const sourceSquared = new Float64Array(source.length);
  const candidateSquared = new Float64Array(source.length);
  const product = new Float64Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    sourceSquared[index] = (source[index] as number) ** 2;
    candidateSquared[index] = (candidate[index] as number) ** 2;
    product[index] = (source[index] as number) * (candidate[index] as number);
  }
  const sourceMean = blur(source, width, height);
  const candidateMean = blur(candidate, width, height);
  const sourceSecond = blur(sourceSquared, width, height);
  const candidateSecond = blur(candidateSquared, width, height);
  const cross = blur(product, width, height);
  const c1 = 0.01 ** 2;
  const c2 = 0.03 ** 2;
  let total = 0;
  for (let index = 0; index < source.length; index += 1) {
    const meanSource = sourceMean[index] as number;
    const meanCandidate = candidateMean[index] as number;
    const varianceSource = Math.max(0, (sourceSecond[index] as number) - meanSource ** 2);
    const varianceCandidate = Math.max(0, (candidateSecond[index] as number) - meanCandidate ** 2);
    const covariance = (cross[index] as number) - meanSource * meanCandidate;
    total +=
      ((2 * meanSource * meanCandidate + c1) * (2 * covariance + c2)) /
      ((meanSource ** 2 + meanCandidate ** 2 + c1) * (varianceSource + varianceCandidate + c2));
  }
  return Math.max(-1, Math.min(1, total / source.length));
}

function edgeMagnitude(values: Float64Array, width: number, height: number): Float64Array {
  const output = new Float64Array(values.length);
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let horizontal = 0;
      let vertical = 0;
      let kernel = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const value = values[
            reflected(y + dy, height) * width + reflected(x + dx, width)
          ] as number;
          horizontal += value * (gx[kernel] as number);
          vertical += value * (gy[kernel] as number);
          kernel += 1;
        }
      }
      output[y * width + x] = Math.min(1, Math.hypot(horizontal, vertical));
    }
  }
  return output;
}

const linear = Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

function composite(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
  background: (x: number, y: number) => number,
): { rgb: Float64Array; luminance: Float64Array } {
  const rgb = new Float64Array(width * height * 3);
  const luminance = new Float64Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const alpha = channels === 4 ? (pixels[source + 3] as number) / 255 : 1;
    const x = index % width;
    const y = Math.floor(index / width);
    const bg = linear[background(x, y)] as number;
    const target = index * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      rgb[target + channel] =
        (linear[pixels[source + channel] as number] as number) * alpha + bg * (1 - alpha);
    }
    luminance[index] =
      0.2126 * (rgb[target] as number) +
      0.7152 * (rgb[target + 1] as number) +
      0.0722 * (rgb[target + 2] as number);
  }
  return { rgb, luminance };
}

export function computeLiveQuality(input: {
  readonly source: Uint8Array;
  readonly candidate: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
}): LiveQuality {
  if (
    input.source.byteLength !== input.width * input.height * input.channels ||
    input.candidate.byteLength !== input.source.byteLength
  ) {
    throw new RangeError("live metric input dimensions are invalid");
  }
  if (Buffer.from(input.source).equals(Buffer.from(input.candidate))) {
    return {
      metricVersion: "hereisit-live-quality-v1",
      worstSsim: 1,
      worstMeanChannelDelta: 0,
      worstEdgeLoss: 0,
    };
  }
  const backgrounds =
    input.channels === 4
      ? [
          () => 0,
          () => 255,
          (x: number, y: number) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 208 : 48),
        ]
      : [() => 0];
  let worstSsim = 1;
  let worstMeanChannelDelta = 0;
  let worstEdgeLoss = 0;
  for (const background of backgrounds) {
    const source = composite(input.source, input.width, input.height, input.channels, background);
    const candidate = composite(
      input.candidate,
      input.width,
      input.height,
      input.channels,
      background,
    );
    const score = ssim(source.luminance, candidate.luminance, input.width, input.height);
    let delta = 0;
    for (let index = 0; index < source.rgb.length; index += 1) {
      delta += Math.abs((source.rgb[index] as number) - (candidate.rgb[index] as number));
    }
    const sourceEdge = edgeMagnitude(source.luminance, input.width, input.height);
    const candidateEdge = edgeMagnitude(candidate.luminance, input.width, input.height);
    let lost = 0;
    let total = 0;
    for (let index = 0; index < sourceEdge.length; index += 1) {
      const sourceValue = sourceEdge[index] as number;
      lost += Math.max(0, sourceValue - (candidateEdge[index] as number));
      total += sourceValue;
    }
    worstSsim = Math.min(worstSsim, score);
    worstMeanChannelDelta = Math.max(worstMeanChannelDelta, delta / source.rgb.length);
    worstEdgeLoss = Math.max(worstEdgeLoss, lost / Math.max(total, 1e-12));
  }
  return {
    metricVersion: "hereisit-live-quality-v1",
    worstSsim,
    worstMeanChannelDelta,
    worstEdgeLoss,
  };
}

function magicMatches(candidate: CodecCandidate, bytes: Uint8Array): boolean {
  if (candidate.mime === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (candidate.mime === "image/png") {
    try {
      inspectPngChunks(bytes);
      return true;
    } catch {
      return false;
    }
  }
  try {
    inspectWebp(bytes);
    return true;
  } catch {
    return false;
  }
}

async function decodedHash(
  path: string,
  channels: 3 | 4,
  sampleDepth: 8 | 16,
): Promise<{ raw: string; alpha: string | null }> {
  let decoder = sharp(path, { failOn: "error", sequentialRead: true });
  decoder = channels === 4 ? decoder.ensureAlpha() : decoder.removeAlpha();
  if (sampleDepth === 16) decoder = decoder.toColourspace("rgb16");
  const stream = decoder.raw({ depth: sampleDepth === 16 ? "ushort" : "uchar" });
  const rawHash = createHash("sha256");
  const alphaHash = channels === 4 ? createHash("sha256") : null;
  const sampleBytes = sampleDepth / 8;
  const pixelBytes = channels * sampleBytes;
  let carry = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = Buffer.from(value as Buffer);
    rawHash.update(chunk);
    if (alphaHash !== null) {
      const combined = carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
      const complete = combined.byteLength - (combined.byteLength % pixelBytes);
      const alpha = Buffer.allocUnsafe((complete / pixelBytes) * sampleBytes);
      for (
        let source = (channels - 1) * sampleBytes, target = 0;
        source < complete;
        source += pixelBytes, target += sampleBytes
      ) {
        combined.copy(alpha, target, source, source + sampleBytes);
      }
      alphaHash.update(alpha);
      carry = Buffer.from(combined.subarray(complete));
    }
  }
  if (carry.byteLength !== 0) throw new Error("partial pixel");
  return { raw: rawHash.digest("hex"), alpha: alphaHash?.digest("hex") ?? null };
}

function targetDimensions(width: number, height: number) {
  const scale = Math.min(1, 512 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeCandidateSample(input: {
  path: string;
  width: number;
  height: number;
  channels: 3 | 4;
}): Promise<Uint8Array> {
  const target = targetDimensions(input.width, input.height);
  let decoder = sharp(input.path, { failOn: "error", sequentialRead: true });
  decoder = input.channels === 4 ? decoder.ensureAlpha() : decoder.removeAlpha();
  return decoder
    .resize(target.width, target.height, { kernel: sharp.kernel.lanczos3, fit: "fill" })
    .raw()
    .toBuffer();
}

async function decodeNormalizedSample(normalized: NormalizedImage): Promise<Uint8Array> {
  const target = targetDimensions(normalized.width, normalized.height);
  const transformer = sharp({
    raw: { width: normalized.width, height: normalized.height, channels: normalized.channels },
  })
    .resize(target.width, target.height, { kernel: sharp.kernel.lanczos3, fit: "fill" })
    .raw();
  const output = transformer.toBuffer();
  await pipeline(createReadStream(normalized.rawPath), transformer);
  return output;
}

const rejected = (reason: CandidateVerification["reason"]): CandidateVerification => ({
  accepted: false,
  reason,
  liveQuality: null,
});

export async function verifyCandidate(input: {
  readonly candidate: CodecCandidate;
  readonly sourceBytes: number;
  readonly minimumSavingsPercent: number;
  readonly inspection: ImageInspection;
  readonly normalized: NormalizedImage;
  readonly mode: "lossless" | "smart";
  readonly preset: "balanced" | "smallest";
  readonly contentClass: ImageContentClass;
  readonly coefficientExact?: boolean;
}): Promise<CandidateVerification> {
  if (input.candidate.mime !== input.inspection.mime) return rejected("signature");
  const information = await stat(input.candidate.path).catch(() => null);
  if (
    information === null ||
    !information.isFile() ||
    information.size !== input.candidate.byteLength
  ) {
    return rejected("signature");
  }
  if (input.candidate.byteLength >= input.sourceBytes) return rejected("not-smaller");
  const required = Math.floor((input.sourceBytes * input.minimumSavingsPercent) / 100);
  if (input.sourceBytes - input.candidate.byteLength < required)
    return rejected("insufficient-savings");
  const bytes = await readFile(input.candidate.path);
  if (!magicMatches(input.candidate, bytes)) return rejected("signature");
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(input.candidate.path, {
      failOn: "error",
      sequentialRead: true,
    }).metadata();
  } catch {
    return rejected("decode");
  }
  if (metadata.width !== input.normalized.width || metadata.height !== input.normalized.height) {
    return rejected("dimensions");
  }
  if (metadata.orientation !== undefined && metadata.orientation !== 1)
    return rejected("orientation");
  if (metadata.icc !== undefined || metadata.space === "cmyk") return rejected("color");
  let hashes: Awaited<ReturnType<typeof decodedHash>>;
  try {
    hashes = await decodedHash(
      input.candidate.path,
      input.normalized.channels,
      input.normalized.sampleDepth,
    );
  } catch {
    return rejected("decode");
  }
  if (input.normalized.alphaSha256 !== hashes.alpha) return rejected("alpha");
  const strictLossless = input.mode === "lossless" || input.candidate.mode === "lossless";
  if (strictLossless) {
    if (input.candidate.mime === "image/jpeg" && input.candidate.mode === "lossless-structural") {
      if (input.coefficientExact !== true) return rejected("coefficient-transform");
    } else if (hashes.raw !== input.normalized.rawSha256) {
      return rejected("pixel-hash");
    }
    return { accepted: true, reason: "accepted", liveQuality: null };
  }
  let sourceSample: Uint8Array;
  let candidateSample: Uint8Array;
  try {
    [sourceSample, candidateSample] = await Promise.all([
      decodeNormalizedSample(input.normalized),
      decodeCandidateSample({
        path: input.candidate.path,
        width: input.normalized.width,
        height: input.normalized.height,
        channels: input.normalized.channels,
      }),
    ]);
  } catch {
    return rejected("decode");
  }
  const target = targetDimensions(input.normalized.width, input.normalized.height);
  const quality = computeLiveQuality({
    source: sourceSample,
    candidate: candidateSample,
    width: target.width,
    height: target.height,
    channels: input.normalized.channels,
  });
  const floor = liveQualityFloor[input.preset];
  const screenshotText = input.contentClass === "screenshot-text";
  const minimumSsim = screenshotText ? floor.screenshotTextSsim : floor.defaultSsim;
  const maximumMeanChannelDelta = screenshotText
    ? floor.screenshotTextMaxMeanChannelDelta
    : floor.maxMeanChannelDelta;
  const maximumEdgeLoss = screenshotText ? floor.screenshotTextMaxEdgeLoss : floor.maxEdgeLoss;
  if (
    quality.worstSsim < minimumSsim ||
    quality.worstMeanChannelDelta > maximumMeanChannelDelta ||
    quality.worstEdgeLoss > maximumEdgeLoss
  ) {
    return { accepted: false, reason: "quality", liveQuality: quality };
  }
  return { accepted: true, reason: "accepted", liveQuality: quality };
}

export async function selectVerifiedResult(input: {
  readonly candidates: readonly CodecCandidate[];
  readonly verify: (candidate: CodecCandidate, index: number) => Promise<CandidateVerification>;
  readonly width: number;
  readonly height: number;
  readonly mime: "image/jpeg" | "image/png" | "image/webp";
  readonly deleteRejected?: boolean;
}): Promise<VerifiedOptimizationResult> {
  const accepted: CodecCandidate[] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index] as CodecCandidate;
    const decision = await input.verify(candidate, index);
    if (decision.accepted) accepted.push(candidate);
    else if (input.deleteRejected !== false) await rm(candidate.path, { force: true });
  }
  if (accepted.length === 0) {
    return {
      kind: "original-retained",
      testedCandidates: input.candidates.length,
      width: input.width,
      height: input.height,
      mime: input.mime,
    };
  }
  const selected = accepted.reduce((best, candidate) =>
    candidate.byteLength < best.byteLength ? candidate : best,
  );
  await Promise.all(
    accepted
      .filter((candidate) => candidate !== selected)
      .map((candidate) => rm(candidate.path, { force: true })),
  );
  return {
    kind: "download",
    selected,
    testedCandidates: input.candidates.length,
    width: input.width,
    height: input.height,
    mime: input.mime,
  };
}
