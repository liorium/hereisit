import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { verifyBenchmarkOutput } from "./benchmark-verify";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-verify-"));
  roots.push(directory);
  const sourcePath = join(directory, "source.png");
  const outputPath = join(directory, "output.png");
  await sharp({ create: { width: 32, height: 16, channels: 4, background: "#ff000080" } })
    .png({ compressionLevel: 0 })
    .toFile(sourcePath);
  await sharp(sourcePath).png().toFile(outputPath);
  return {
    sourcePath,
    outputPath,
    mime: "image/png" as const,
    mode: "lossless" as const,
    preset: "balanced" as const,
  };
}

it("proves lossless pixels and alpha from decoded output", async () => {
  expect(await verifyBenchmarkOutput(await fixture())).toMatchObject({
    qualityChecksPassed: true,
    alphaChecksPassed: true,
    normalizedPixelMatch: true,
    losslessVerification: "pixel-exact",
  });
});

it("classifies decoded text-like pixels before choosing the stricter quality floor", async () => {
  const input = await fixture();
  const source = Buffer.alloc(64 * 64 * 3);
  const candidate = Buffer.alloc(source.length);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const offset = (y * 64 + x) * 3;
      source.fill(x % 16 < 8 ? 0 : 255, offset, offset + 3);
      candidate.fill(x % 16 < 8 ? 0 : 253, offset, offset + 3);
    }
  }
  const raw = { width: 64, height: 64, channels: 3 as const };
  await sharp(source, { raw }).png({ compressionLevel: 0 }).toFile(input.sourcePath);
  await sharp(candidate, { raw }).png().toFile(input.outputPath);
  expect(await verifyBenchmarkOutput({ ...input, mode: "smart" })).toMatchObject({
    qualityChecksPassed: false,
    verificationReason: "quality",
  });
});

it("rejects changed alpha even when the engine reports success", async () => {
  const input = await fixture();
  await sharp(input.sourcePath).flatten().png().toFile(input.outputPath);
  expect(await verifyBenchmarkOutput(input)).toMatchObject({
    qualityChecksPassed: false,
    alphaChecksPassed: false,
    normalizedPixelMatch: false,
    losslessVerification: null,
  });
});

it("rejects wrong dimensions", async () => {
  const input = await fixture();
  await sharp(input.sourcePath).resize(8, 8).png().toFile(input.outputPath);
  expect(await verifyBenchmarkOutput(input)).toMatchObject({
    qualityChecksPassed: false,
    verificationReason: "dimensions",
  });
});

it("replays the existing visual floor against changed colors", async () => {
  const input = await fixture();
  await sharp({ create: { width: 32, height: 16, channels: 4, background: "#0000ff80" } })
    .png()
    .toFile(input.outputPath);
  expect(await verifyBenchmarkOutput({ ...input, mode: "smart" })).toMatchObject({
    qualityChecksPassed: false,
    alphaChecksPassed: true,
    verificationReason: "quality",
    normalizedPixelMatch: null,
    liveQuality: { metricVersion: "hereisit-live-quality-v1" },
  });
});

it("never substitutes pixel equality for JPEG coefficient verification", async () => {
  const input = await fixture();
  const sourcePath = join(roots.at(-1) as string, "source.jpg");
  const outputPath = join(roots.at(-1) as string, "output.jpg");
  await sharp(input.sourcePath)
    .jpeg()
    .withExif({ IFD0: { Copyright: "x".repeat(1000) } })
    .toFile(sourcePath);
  await sharp(sourcePath).jpeg().toFile(outputPath);
  const jpeg = { ...input, sourcePath, outputPath, mime: "image/jpeg" as const };
  expect(await verifyBenchmarkOutput(jpeg)).toMatchObject({
    qualityChecksPassed: false,
    normalizedPixelMatch: null,
    losslessVerification: null,
    verificationReason: "coefficient-transform",
  });
  expect(
    await verifyBenchmarkOutput({ ...jpeg, verifyCoefficients: async () => true }),
  ).toMatchObject({
    qualityChecksPassed: true,
    normalizedPixelMatch: null,
    losslessVerification: "jpeg-coefficient-exact",
  });
});
