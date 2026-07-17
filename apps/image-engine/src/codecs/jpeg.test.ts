import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OptimizationCandidatePlan } from "../pipeline/plan";
import type { CommandResult } from "./command";
import {
  buildJpegtranArgs,
  buildMozJpegArgs,
  encodeJpegCandidate,
  JpegCodecError,
  orientationTransform,
} from "./jpeg";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-jpeg-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const smartCandidate: OptimizationCandidatePlan = {
  id: "jpeg-q82-444",
  codec: "mozjpeg",
  mode: "lossy",
  quality: 82,
  chroma: "444",
  effort: 3,
};

const losslessCandidate: OptimizationCandidatePlan = {
  id: "jpeg-lossless",
  codec: "mozjpeg",
  mode: "lossless-structural",
  effort: 3,
};

describe("MozJPEG command policy", () => {
  it("builds the exact smart screenshot command", () => {
    expect(
      buildMozJpegArgs({
        quality: 82,
        chroma: "444",
        outputPath: "/work/out.jpg",
        ppmPath: "/work/input.ppm",
      }),
    ).toEqual([
      "-quality",
      "82",
      "-sample",
      "1x1",
      "-progressive",
      "-optimize",
      "-outfile",
      "/work/out.jpg",
      "/work/input.ppm",
    ]);
  });

  it.each([
    [1, "identity", []],
    [2, "flip-h", ["-perfect", "-flip", "horizontal"]],
    [3, "rotate-180", ["-perfect", "-rotate", "180"]],
    [4, "flip-v", ["-perfect", "-flip", "vertical"]],
    [5, "transpose", ["-perfect", "-transpose"]],
    [6, "rotate-90", ["-perfect", "-rotate", "90"]],
    [7, "transverse", ["-perfect", "-transverse"]],
    [8, "rotate-270", ["-perfect", "-rotate", "270"]],
  ] as const)("maps EXIF orientation %i without trimming", (orientation, transform, extra) => {
    expect(orientationTransform(orientation)).toBe(transform);
    expect(buildJpegtranArgs(orientation, "/work/out.jpg", "/work/source.jpg")).toEqual([
      "-copy",
      "none",
      "-optimize",
      "-progressive",
      ...extra,
      "-outfile",
      "/work/out.jpg",
      "/work/source.jpg",
    ]);
  });
});

describe("encodeJpegCandidate", () => {
  it("streams normalized RGB through PPM and validates the JPEG result", async () => {
    const directory = await root();
    const normalizedRgbPath = join(directory, "normalized.raw");
    const outputPath = join(directory, "result.jpg");
    const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    await writeFile(normalizedRgbPath, pixels);
    const run = vi.fn(async (input: { args: readonly string[] }): Promise<CommandResult> => {
      const ppmPath = input.args.at(-1);
      expect(ppmPath).toBeDefined();
      expect((await readFile(ppmPath as string)).subarray(0, 11).toString("ascii")).toBe(
        "P6\n2 2\n255\n",
      );
      await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } })
        .jpeg({ progressive: true })
        .toFile(outputPath);
      return { exitCode: 0, elapsedMs: 7, stderrTail: "" };
    });

    await expect(
      encodeJpegCandidate({
        sourcePath: join(directory, "unused-source"),
        normalizedRgbPath,
        width: 2,
        height: 2,
        orientation: 1,
        candidate: smartCandidate,
        outputPath,
        signal: new AbortController().signal,
        run,
      }),
    ).resolves.toMatchObject({
      id: smartCandidate.id,
      mime: "image/jpeg",
      encodeMs: 7,
      codecBuildId: "mozjpeg-4.1.1+a2d2907",
      mode: "lossy",
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed when jpegtran cannot perform a perfect MCU transform", async () => {
    const directory = await root();
    const sourcePath = join(directory, "source.jpg");
    const outputPath = join(directory, "result.jpg");
    await writeFile(sourcePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const run = vi.fn(
      async (): Promise<CommandResult> => ({
        exitCode: 1,
        elapsedMs: 2,
        stderrTail: "transformation is not perfect",
      }),
    );

    await expect(
      encodeJpegCandidate({
        sourcePath,
        normalizedRgbPath: join(directory, "unused.raw"),
        width: 9,
        height: 17,
        orientation: 6,
        candidate: losslessCandidate,
        outputPath,
        signal: new AbortController().signal,
        run,
      }),
    ).rejects.toEqual(new JpegCodecError("unsafe-lossless-transform"));
  });
});
