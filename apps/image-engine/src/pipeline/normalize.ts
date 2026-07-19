import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { endianness } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { type ImageInspection, ImagePipelineError } from "./inspect";

export interface NormalizedImage {
  readonly rawPath: string;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly sampleDepth: 8 | 16;
  readonly rawEndian: "little";
  readonly rawSha256: string;
  readonly alphaSha256: string | null;
  readonly normalizedColorSpace: "srgb";
}

export interface NormalizedSample {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface NormalizedImageWithSample extends NormalizedImage {
  readonly sample: NormalizedSample;
}

function gridPositions(size: number): readonly number[] {
  const count = Math.min(256, size);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.floor((index * (size - 1)) / (count - 1)),
  );
}

interface SampleTarget {
  readonly offset: number;
  readonly destination: number;
}

function samplingPlan(width: number, height: number, pixelBytes: number) {
  const xs = gridPositions(width);
  const ys = gridPositions(height);
  const targets: SampleTarget[] = [];
  let destination = 0;
  for (const y of ys) {
    for (const x of xs) {
      targets.push({ offset: (y * width + x) * pixelBytes, destination });
      destination += pixelBytes;
    }
  }
  return {
    width: xs.length,
    height: ys.length,
    targets,
    pixels: new Uint8Array(destination),
  };
}

function canonicalizeLittleEndian(chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBuffer> {
  const result = Buffer.from(chunk);
  result.swap16();
  return result;
}

export async function normalizeImage(input: {
  readonly sourcePath: string;
  readonly rawPath: string;
  readonly inspection: ImageInspection;
  readonly hostEndian?: "little" | "big";
}): Promise<NormalizedImageWithSample> {
  const width = input.inspection.displayedWidth;
  const height = input.inspection.displayedHeight;
  const channels: 3 | 4 = input.inspection.hasAlpha ? 4 : 3;
  const sampleDepth = input.inspection.bitDepth;
  const bytesPerSample = sampleDepth / 8;
  const pixelBytes = channels * bytesPerSample;
  const sample = samplingPlan(width, height, pixelBytes);
  const rawHash = createHash("sha256");
  const alphaHash = input.inspection.hasAlpha ? createHash("sha256") : null;
  let streamOffset = 0;
  let targetIndex = 0;
  let endianCarry = Buffer.alloc(0);
  let alphaCarry = Buffer.alloc(0);

  const processCanonical = (canonical: Buffer) => {
    if (canonical.byteLength === 0) return;
    rawHash.update(canonical);
    const chunkStart = streamOffset;
    const chunkEnd = chunkStart + canonical.byteLength;
    while (targetIndex < sample.targets.length) {
      const target = sample.targets[targetIndex] as SampleTarget;
      const targetEnd = target.offset + pixelBytes;
      if (targetEnd <= chunkStart) {
        targetIndex += 1;
        continue;
      }
      if (target.offset >= chunkEnd) break;
      const overlapStart = Math.max(target.offset, chunkStart);
      const overlapEnd = Math.min(targetEnd, chunkEnd);
      sample.pixels.set(
        canonical.subarray(overlapStart - chunkStart, overlapEnd - chunkStart),
        target.destination + overlapStart - target.offset,
      );
      if (targetEnd <= chunkEnd) targetIndex += 1;
      else break;
    }

    if (alphaHash !== null) {
      const combined =
        alphaCarry.byteLength === 0 ? canonical : Buffer.concat([alphaCarry, canonical]);
      const completeBytes = combined.byteLength - (combined.byteLength % pixelBytes);
      const pixelCount = completeBytes / pixelBytes;
      const alpha = Buffer.allocUnsafe(pixelCount * bytesPerSample);
      const alphaOffset = (channels - 1) * bytesPerSample;
      for (let index = 0; index < pixelCount; index += 1) {
        combined.copy(
          alpha,
          index * bytesPerSample,
          index * pixelBytes + alphaOffset,
          index * pixelBytes + alphaOffset + bytesPerSample,
        );
      }
      alphaHash.update(alpha);
      alphaCarry = Buffer.from(combined.subarray(completeBytes));
    }
    streamOffset = chunkEnd;
  };

  const canonicalizer = new Transform({
    transform(raw: Buffer, _encoding, callback) {
      try {
        let chunk: Buffer<ArrayBufferLike> = Buffer.from(raw);
        if (
          sampleDepth === 16 &&
          (input.hostEndian ?? (endianness() === "LE" ? "little" : "big")) === "big"
        ) {
          chunk = endianCarry.byteLength === 0 ? chunk : Buffer.concat([endianCarry, chunk]);
          if (chunk.byteLength % 2 !== 0) {
            endianCarry = Buffer.from(chunk.subarray(chunk.byteLength - 1));
            chunk = chunk.subarray(0, chunk.byteLength - 1);
          } else {
            endianCarry = Buffer.alloc(0);
          }
          chunk = canonicalizeLittleEndian(chunk);
        }
        processCanonical(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      if (endianCarry.byteLength !== 0 || alphaCarry.byteLength !== 0) {
        callback(new Error("normalized raw stream ended on a partial sample"));
        return;
      }
      callback();
    },
  });

  let transformer = sharp(input.sourcePath, {
    failOn: "error",
    sequentialRead: true,
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .toColourspace(sampleDepth === 16 ? "rgb16" : "srgb");
  if (!input.inspection.hasAlpha) transformer = transformer.removeAlpha();
  const raw = transformer.raw({ depth: sampleDepth === 16 ? "ushort" : "uchar" });
  let outputInfo: { width: number; height: number; channels: number } | null = null;
  let decodeFailed = false;
  raw.once("info", (value) => {
    outputInfo = value;
  });
  raw.once("error", () => {
    decodeFailed = true;
  });
  try {
    await pipeline(
      raw,
      canonicalizer,
      createWriteStream(input.rawPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (decodeFailed) throw new ImagePipelineError("UNSUPPORTED_INPUT", false, input.inspection);
    throw error;
  }
  const actual = outputInfo as { width: number; height: number; channels: number } | null;
  if (
    actual === null ||
    actual.width !== width ||
    actual.height !== height ||
    actual.channels !== channels ||
    streamOffset !== width * height * pixelBytes ||
    targetIndex !== sample.targets.length
  ) {
    throw new Error("normalized raw output did not match the inspected image");
  }
  return {
    rawPath: input.rawPath,
    width,
    height,
    channels,
    sampleDepth,
    rawEndian: "little",
    rawSha256: rawHash.digest("hex"),
    alphaSha256: alphaHash?.digest("hex") ?? null,
    normalizedColorSpace: "srgb",
    sample: { pixels: sample.pixels, width: sample.width, height: sample.height },
  };
}
