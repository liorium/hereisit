import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OptimizationCandidatePlan } from "../pipeline/plan";
import type { CommandResult } from "./command";
import { buildOxiPngArgs, encodePngCandidate, expandRgbToRgbaFile, inspectPngChunks } from "./png";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-png-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const lossless: OptimizationCandidatePlan = {
  id: "png-lossless-o3",
  codec: "oxipng",
  mode: "lossless",
  effort: 3,
};
const smart: OptimizationCandidatePlan = {
  id: "png-quant-255-o3",
  codec: "quantizr-oxipng",
  mode: "quantized-255",
  quality: 255,
  effort: 3,
};

function successful(elapsedMs = 4): CommandResult {
  return { exitCode: 0, elapsedMs, stderrTail: "" };
}

describe("PNG command and stream policy", () => {
  it("uses the exact bounded live OxiPNG command without zopfli", () => {
    expect(buildOxiPngArgs("/work/out.png", "/work/base.png")).toEqual([
      "-o",
      "3",
      "--strip",
      "safe",
      "--out",
      "/work/out.png",
      "/work/base.png",
    ]);
    expect(buildOxiPngArgs("/work/out.png", "/work/base.png").join(" ")).not.toContain("zopfli");
  });

  it("expands RGB across split pixel chunks and writes exactly RGBA length", async () => {
    const directory = await root();
    const inputPath = join(directory, "rgb.raw");
    const outputPath = join(directory, "rgba.raw");
    await writeFile(inputPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    await expandRgbToRgbaFile({ inputPath, outputPath, width: 2, height: 2, highWaterMark: 5 });
    expect(await readFile(outputPath)).toEqual(
      Buffer.from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
    );
    expect((await stat(outputPath)).size).toBe(2 * 2 * 4);
  });
});

describe("encodePngCandidate", () => {
  it.each([
    { channels: 3 as const, pixels: Buffer.from([255, 0, 0, 0, 255, 0]) },
    { channels: 4 as const, pixels: Buffer.from([255, 0, 0, 64, 0, 255, 0, 255]) },
  ])("preserves normalized $channels-channel pixels in lossless mode", async (fixture) => {
    const directory = await root();
    const normalizedPath = join(directory, "normalized.raw");
    const outputPath = join(directory, "result.png");
    await writeFile(normalizedPath, fixture.pixels);
    const run = vi.fn(async (command: { args: readonly string[] }) => {
      const target = command.args.at(-2) as string;
      const source = command.args.at(-1) as string;
      await writeFile(target, await readFile(source));
      return successful();
    });

    const encoded = await encodePngCandidate({
      normalizedPath,
      width: 2,
      height: 1,
      channels: fixture.channels,
      sampleDepth: 8,
      candidate: lossless,
      outputPath,
      signal: new AbortController().signal,
      run,
    });
    const decoded = await sharp(encoded.path).raw().toBuffer();
    expect(decoded).toEqual(fixture.pixels);
    expect(inspectPngChunks(await readFile(encoded.path)).ancillary).not.toEqual(
      expect.arrayContaining(["eXIf", "iTXt", "tEXt", "zTXt"]),
    );
    expect(run.mock.calls[0]?.[0].args).toEqual(buildOxiPngArgs(outputPath, expect.any(String)));
  });

  it("preserves little-endian 16-bit samples in lossless mode", async () => {
    const directory = await root();
    const normalizedPath = join(directory, "normalized-16.raw");
    const outputPath = join(directory, "result-16.png");
    const pixels = Buffer.alloc(2 * 1 * 3 * 2);
    [0, 65_535, 1_024, 32_768, 12_345, 54_321].forEach((value, index) => {
      pixels.writeUInt16LE(value, index * 2);
    });
    await writeFile(normalizedPath, pixels);
    const run = vi.fn(async (command: { args: readonly string[] }) => {
      await writeFile(command.args.at(-2) as string, await readFile(command.args.at(-1) as string));
      return successful();
    });
    await expect(
      encodePngCandidate({
        normalizedPath,
        width: 2,
        height: 1,
        channels: 3,
        sampleDepth: 16,
        candidate: lossless,
        outputPath,
        signal: new AbortController().signal,
        run,
      }),
    ).resolves.toMatchObject({ mime: "image/png", mode: "lossless" });
    expect((await sharp(outputPath).metadata()).depth).toBe("ushort");
  });

  it("feeds deterministic RGBA into the smart wrapper and returns an indexed PNG", async () => {
    const directory = await root();
    const normalizedPath = join(directory, "normalized.raw");
    const outputPath = join(directory, "result.png");
    const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 0, 255]);
    await writeFile(normalizedPath, pixels);
    const run = vi.fn(async (command: { command: string; args: readonly string[] }) => {
      if (command.command.endsWith("png-smart")) {
        const rgbaPath = command.args[command.args.indexOf("--input-rgba") + 1] as string;
        const target = command.args[command.args.indexOf("--output") + 1] as string;
        expect(await readFile(rgbaPath)).toEqual(pixels);
        await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
          .png({ palette: true, colours: 255 })
          .toFile(target);
      } else {
        const target = command.args.at(-2) as string;
        const source = command.args.at(-1) as string;
        await writeFile(target, await readFile(source));
      }
      return successful();
    });

    const encoded = await encodePngCandidate({
      normalizedPath,
      width: 2,
      height: 2,
      channels: 4,
      sampleDepth: 8,
      candidate: smart,
      outputPath,
      signal: new AbortController().signal,
      run,
    });
    const chunks = inspectPngChunks(await readFile(encoded.path));
    expect(chunks.colorType).toBe(3);
    expect(chunks.paletteEntries).toBeLessThanOrEqual(255);
    expect(chunks.ancillary).toContain("PLTE");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
