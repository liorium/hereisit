import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { CodecCandidate } from "../codecs/jpeg";
import { encodePngCandidate } from "../codecs/png";
import { type ImageInspection, inspectImage } from "./inspect";
import { type NormalizedImage, normalizeImage } from "./normalize";
import {
  computeLiveQuality,
  liveQualityFloor,
  selectVerifiedResult,
  verifyCandidate,
} from "./verify";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-verify-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function inspection(width = 8, height = 8): ImageInspection {
  return {
    format: "webp",
    mime: "image/webp",
    width,
    height,
    displayedWidth: width,
    displayedHeight: height,
    pixels: width * height,
    bitDepth: 8,
    hasAlpha: false,
    animated: false,
    orientation: 1,
    hasIccProfile: false,
    sourceColorModel: "rgb",
    adobeTransform: null,
    iccProfileKind: "none",
    wideGamut: false,
    metadataBytes: 0,
  };
}

async function fixture(input: {
  sourceBytes?: number;
  candidatePixels?: Buffer;
  lossless?: boolean;
}) {
  const directory = await root();
  const width = 8;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set([(index * 17) & 255, (index * 31) & 255, (index * 47) & 255], index * 3);
  }
  const candidatePixels = input.candidatePixels ?? pixels;
  const rawPath = join(directory, "normalized.raw");
  const candidatePath = join(directory, "candidate.webp");
  await writeFile(rawPath, pixels);
  await sharp(candidatePixels, { raw: { width, height, channels: 3 } })
    .webp({ lossless: input.lossless ?? true, quality: 82 })
    .toFile(candidatePath);
  const candidateBytes = (await import("node:fs/promises"))
    .stat(candidatePath)
    .then((value) => value.size);
  const normalized: NormalizedImage = {
    rawPath,
    width,
    height,
    channels: 3,
    sampleDepth: 8,
    rawEndian: "little",
    rawSha256: hash(pixels),
    alphaSha256: null,
    normalizedColorSpace: "srgb",
  };
  const candidate: CodecCandidate = {
    id: "test",
    path: candidatePath,
    mime: "image/webp",
    byteLength: await candidateBytes,
    encodeMs: 1,
    codecBuildId: "test",
    mode: input.lossless === false ? "lossy" : "lossless",
  };
  return {
    candidate,
    normalized,
    inspection: inspection(width, height),
    sourceBytes: input.sourceBytes ?? candidate.byteLength + 1_000,
  };
}

describe("live quality v1", () => {
  it("returns exact golden scalars for identical opaque pixels", () => {
    const pixels = Uint8Array.of(0, 64, 255, 255, 128, 0);
    expect(
      computeLiveQuality({ source: pixels, candidate: pixels, width: 2, height: 1, channels: 3 }),
    ).toEqual({
      metricVersion: "hereisit-live-quality-v1",
      worstSsim: 1,
      worstMeanChannelDelta: 0,
      worstEdgeLoss: 0,
    });
    expect(liveQualityFloor.balanced.screenshotTextSsim).toBe(0.985);
    expect(liveQualityFloor.balanced.screenshotTextMaxMeanChannelDelta).toBe(2 / 255);
    expect(liveQualityFloor.balanced.screenshotTextMaxEdgeLoss).toBe(0.02);
  });
});

describe("verifyCandidate", () => {
  it("accepts a smaller exact lossless WebP", async () => {
    const value = await fixture({});
    await expect(
      verifyCandidate({
        ...value,
        minimumSavingsPercent: 1,
        mode: "lossless",
        preset: "balanced",
        contentClass: "photo",
      }),
    ).resolves.toMatchObject({ accepted: true, reason: "accepted", liveQuality: null });
  });

  it.each([
    ["not-smaller", 0, 0],
    ["insufficient-savings", 1, 50],
  ] as const)("rejects %s", async (reason, extra, minimumSavingsPercent) => {
    const value = await fixture({});
    const sourceBytes =
      reason === "not-smaller" ? value.candidate.byteLength : value.candidate.byteLength + extra;
    await expect(
      verifyCandidate({
        ...value,
        sourceBytes,
        minimumSavingsPercent,
        mode: "lossless",
        preset: "balanced",
        contentClass: "photo",
      }),
    ).resolves.toMatchObject({ accepted: false, reason });
  });

  it("rejects a changed strict-lossless pixel hash", async () => {
    const changed = Buffer.alloc(8 * 8 * 3, 200);
    const value = await fixture({ candidatePixels: changed });
    await expect(
      verifyCandidate({
        ...value,
        minimumSavingsPercent: 1,
        mode: "lossless",
        preset: "balanced",
        contentClass: "photo",
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "pixel-hash" });
  });

  it("runs the bounded live gate for a smart candidate", async () => {
    const value = await fixture({});
    await expect(
      verifyCandidate({
        ...value,
        candidate: { ...value.candidate, mode: "lossy" },
        minimumSavingsPercent: 1,
        mode: "smart",
        preset: "balanced",
        contentClass: "photo",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      reason: "accepted",
      liveQuality: { metricVersion: "hereisit-live-quality-v1", worstSsim: 1 },
    });
  });

  it("accepts a smaller 4:4:4 fallback for the false original-retained JPEG corpus", async () => {
    const directory = await root();
    const sourcePath = "tests/image-corpus/public/photo-ordinary-jpeg.jpg";
    const rawPath = join(directory, "normalized.raw");
    const candidatePath = join(directory, "candidate.jpg");
    const sourceInspection = await inspectImage(sourcePath, "image/jpeg");
    const normalized = await normalizeImage({
      sourcePath,
      rawPath,
      inspection: sourceInspection,
    });
    await sharp(await readFile(rawPath), {
      raw: {
        width: normalized.width,
        height: normalized.height,
        channels: normalized.channels,
      },
    })
      .jpeg({ quality: 80, progressive: true, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toFile(candidatePath);
    const candidateBytes = (await stat(candidatePath)).size;

    await expect(
      verifyCandidate({
        candidate: {
          id: "jpeg-q80-444",
          path: candidatePath,
          mime: "image/jpeg",
          byteLength: candidateBytes,
          encodeMs: 1,
          codecBuildId: "test",
          mode: "lossy",
        },
        sourceBytes: (await stat(sourcePath)).size,
        minimumSavingsPercent: 1,
        inspection: sourceInspection,
        normalized,
        mode: "smart",
        preset: "smallest",
        contentClass: "photo",
      }),
    ).resolves.toMatchObject({ accepted: true, reason: "accepted" });
  });

  it("compares canonical little-endian 16-bit samples exactly", async () => {
    const directory = await root();
    const rawPath = join(directory, "normalized-16.raw");
    const outputPath = join(directory, "candidate.png");
    const pixels = Buffer.alloc(2 * 2 * 3 * 2);
    [1, 65_534, 1_023, 32_769, 12_345, 54_321, 7, 60_001, 2_049, 40_003, 222, 44_444].forEach(
      (value, index) => {
        pixels.writeUInt16LE(value, index * 2);
      },
    );
    await writeFile(rawPath, pixels);
    const candidate = await encodePngCandidate({
      normalizedPath: rawPath,
      width: 2,
      height: 2,
      channels: 3,
      sampleDepth: 16,
      candidate: { id: "png-16", codec: "oxipng", mode: "lossless", effort: 3 },
      outputPath,
      signal: new AbortController().signal,
      run: async (command) => {
        await writeFile(
          command.args.at(-2) as string,
          await readFile(command.args.at(-1) as string),
        );
        return { exitCode: 0, elapsedMs: 1, stderrTail: "" };
      },
    });
    await expect(
      verifyCandidate({
        candidate,
        sourceBytes: candidate.byteLength + 1_000,
        minimumSavingsPercent: 1,
        inspection: {
          ...inspection(2, 2),
          format: "png",
          mime: "image/png",
          bitDepth: 16,
        },
        normalized: {
          rawPath,
          width: 2,
          height: 2,
          channels: 3,
          sampleDepth: 16,
          rawEndian: "little",
          rawSha256: hash(pixels),
          alphaSha256: null,
          normalizedColorSpace: "srgb",
        },
        mode: "lossless",
        preset: "balanced",
        contentClass: "flat-graphic",
      }),
    ).resolves.toMatchObject({ accepted: true, reason: "accepted" });
  });
});

describe("selectVerifiedResult", () => {
  it("retains the original when no candidate passes", async () => {
    const value = await fixture({});
    await expect(
      selectVerifiedResult({
        candidates: [value.candidate, { ...value.candidate, id: "second" }],
        verify: async () => ({ accepted: false, reason: "quality", liveQuality: null }),
        width: 8,
        height: 8,
        mime: "image/webp",
      }),
    ).resolves.toEqual({
      kind: "original-retained",
      testedCandidates: 2,
      width: 8,
      height: 8,
      mime: "image/webp",
    });
  });
});
