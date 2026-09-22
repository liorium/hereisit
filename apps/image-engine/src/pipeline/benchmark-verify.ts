import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageOptimizeMime } from "@hereisit/tool-contracts";
import { type JpegTransform, orientationTransform } from "../codecs/jpeg";
import { classifyImage, extractImageFeatures } from "./classify";
import { inspectImage } from "./inspect";
import { normalizeImage } from "./normalize";
import { verifyCandidate } from "./verify";

export { verifyJpegCoefficientTransform } from "../codecs/jpeg-coeff-verify";

export async function verifyBenchmarkOutput(input: {
  sourcePath: string;
  outputPath: string;
  mime: ImageOptimizeMime;
  mode: "smart" | "lossless";
  preset: "balanced" | "smallest";
  verifyCoefficients?: (transform: JpegTransform) => Promise<boolean>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "hereisit-benchmark-verify-"));
  try {
    const inspection = await inspectImage(input.sourcePath, input.mime, {
      resourceClass: "image-large-v1",
    });
    const outputInspection = await inspectImage(input.outputPath, input.mime, {
      resourceClass: "image-large-v1",
    });
    const normalized = await normalizeImage({
      sourcePath: input.sourcePath,
      rawPath: join(directory, "source.raw"),
      inspection,
    });
    const sourceBytes = (await stat(input.sourcePath)).size;
    const contentClass = classifyImage(
      extractImageFeatures({
        ...normalized.sample,
        channels: normalized.channels,
        sampleDepth: normalized.sampleDepth,
        encodedBytes: sourceBytes,
        decodedBytes:
          normalized.width * normalized.height * normalized.channels * (normalized.sampleDepth / 8),
      }),
    );
    const output = await normalizeImage({
      sourcePath: input.outputPath,
      rawPath: join(directory, "output.raw"),
      inspection: outputInspection,
    });
    const pixelMatch =
      normalized.width === output.width &&
      normalized.height === output.height &&
      normalized.sampleDepth === output.sampleDepth &&
      normalized.rawSha256 === output.rawSha256;
    const alphaChecksPassed = normalized.alphaSha256 === output.alphaSha256;
    const coefficientJpeg = input.mode === "lossless" && inspection.mime === "image/jpeg";
    const coefficientExact =
      coefficientJpeg &&
      (await input.verifyCoefficients?.(orientationTransform(inspection.orientation))) === true;
    const verification = await verifyCandidate({
      candidate: {
        id: "benchmark-output",
        path: input.outputPath,
        mime: input.mime,
        byteLength: (await stat(input.outputPath)).size,
        encodeMs: 0,
        codecBuildId: "benchmark",
        mode: coefficientJpeg ? "lossless-structural" : pixelMatch ? "lossless" : "lossy",
      },
      sourceBytes,
      minimumSavingsPercent: 1,
      inspection,
      normalized,
      mode: input.mode,
      preset: input.preset,
      contentClass,
      coefficientExact,
    });
    const qualityChecksPassed =
      verification.accepted &&
      alphaChecksPassed &&
      inspection.mime === input.mime &&
      outputInspection.mime === input.mime;
    return {
      qualityChecksPassed,
      alphaChecksPassed,
      normalizedPixelMatch: input.mode === "lossless" && !coefficientJpeg ? pixelMatch : null,
      losslessVerification:
        input.mode === "lossless" && qualityChecksPassed
          ? coefficientJpeg
            ? "jpeg-coefficient-exact"
            : "pixel-exact"
          : null,
      liveQuality: verification.liveQuality,
      verificationReason: verification.reason,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
