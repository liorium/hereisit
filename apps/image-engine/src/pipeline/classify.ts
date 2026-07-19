import type { ImageContentClass } from "@hereisit/server-contracts";

export interface ImageFeaturesV1 {
  readonly alphaCoverage: number;
  readonly uniqueColorRatio: number;
  readonly edgeDensity: number;
  readonly highContrastEdgeRatio: number;
  readonly flatRegionRatio: number;
  readonly lumaEntropyBits: number;
  readonly noiseResidual: number;
  readonly encodedToRawRatio: number;
}

export interface FeatureSampleInput {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly sampleDepth: 8 | 16;
  readonly encodedBytes: number;
  readonly decodedBytes: number;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function extractImageFeatures(input: FeatureSampleInput): ImageFeaturesV1 {
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > 256 ||
    input.height > 256
  ) {
    throw new RangeError("sample dimensions must be between 1 and 256");
  }
  if (!Number.isSafeInteger(input.encodedBytes) || input.encodedBytes < 1) {
    throw new RangeError("encoded byte length is invalid");
  }
  if (!Number.isSafeInteger(input.decodedBytes) || input.decodedBytes < 1) {
    throw new RangeError("decoded byte length is invalid");
  }
  const bytesPerSample = input.sampleDepth / 8;
  const expected = input.width * input.height * input.channels * bytesPerSample;
  if (input.pixels.byteLength !== expected) throw new RangeError("sample byte length is invalid");

  const count = input.width * input.height;
  const luma = new Float64Array(count);
  const unique = new Set<number>();
  const histogram = new Uint32Array(64);
  let nonOpaque = 0;
  const max = input.sampleDepth === 8 ? 255 : 65_535;
  const view = new DataView(input.pixels.buffer, input.pixels.byteOffset, input.pixels.byteLength);
  const read = (offset: number) =>
    input.sampleDepth === 8 ? view.getUint8(offset) : view.getUint16(offset, true);
  for (let index = 0; index < count; index += 1) {
    const offset = index * input.channels * bytesPerSample;
    const red = srgbToLinear(read(offset) / max);
    const green = srgbToLinear(read(offset + bytesPerSample) / max);
    const blue = srgbToLinear(read(offset + bytesPerSample * 2) / max);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luma[index] = luminance;
    const bin = Math.min(63, Math.floor(luminance * 64));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
    const quantized =
      (Math.min(31, Math.floor(red * 32)) << 10) |
      (Math.min(31, Math.floor(green * 32)) << 5) |
      Math.min(31, Math.floor(blue * 32));
    unique.add(quantized);
    if (input.channels === 4 && read(offset + bytesPerSample * 3) < max) nonOpaque += 1;
  }

  let entropy = 0;
  for (const frequency of histogram) {
    if (frequency === 0) continue;
    const probability = frequency / count;
    entropy -= probability * Math.log2(probability);
  }

  const at = (x: number, y: number) =>
    luma[clamp(y, 0, input.height - 1) * input.width + clamp(x, 0, input.width - 1)] ?? 0;
  let edges = 0;
  let highContrastEdges = 0;
  let flat = 0;
  let residual = 0;
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const gx =
        -at(x - 1, y - 1) +
        at(x + 1, y - 1) -
        2 * at(x - 1, y) +
        2 * at(x + 1, y) -
        at(x - 1, y + 1) +
        at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1) +
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1);
      const magnitude = Math.hypot(gx, gy) / 4;
      if (magnitude >= 0.12) edges += 1;
      if (magnitude >= 0.25) highContrastEdges += 1;
      if (magnitude < 0.01) flat += 1;
      let blurred = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        const wy = ky === 0 ? 2 : 1;
        for (let kx = -1; kx <= 1; kx += 1) {
          const wx = kx === 0 ? 2 : 1;
          blurred += at(x + kx, y + ky) * wx * wy;
        }
      }
      residual += Math.abs(at(x, y) - blurred / 16);
    }
  }

  return {
    alphaCoverage: nonOpaque / count,
    uniqueColorRatio: unique.size / count,
    edgeDensity: edges / count,
    highContrastEdgeRatio: highContrastEdges / count,
    flatRegionRatio: flat / count,
    lumaEntropyBits: entropy,
    noiseResidual: residual / count,
    encodedToRawRatio: input.encodedBytes / input.decodedBytes,
  };
}

export function classifyImage(features: ImageFeaturesV1): ImageContentClass {
  if (features.alphaCoverage > 0) return "transparent-graphic";
  if (features.encodedToRawRatio <= 0.08 && features.flatRegionRatio < 0.2) {
    return "already-optimized";
  }
  if (
    features.edgeDensity >= 0.12 &&
    features.highContrastEdgeRatio >= 0.06 &&
    features.uniqueColorRatio <= 0.2 &&
    features.flatRegionRatio >= 0.35
  ) {
    return "screenshot-text";
  }
  if (features.uniqueColorRatio <= 0.08 && features.flatRegionRatio >= 0.6) {
    return "flat-graphic";
  }
  if (
    features.lumaEntropyBits >= 5.8 &&
    features.flatRegionRatio < 0.08 &&
    features.noiseResidual >= 0.08
  ) {
    return "noisy";
  }
  return "photo";
}
