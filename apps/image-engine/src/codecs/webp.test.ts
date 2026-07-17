import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OptimizationCandidatePlan } from "../pipeline/plan";
import type { CommandResult } from "./command";
import { buildWebpArgs, encodeWebpCandidate, inspectWebp } from "./webp";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-webp-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const plans = {
  lossless: {
    id: "webp-lossless-m4",
    codec: "libwebp",
    mode: "lossless",
    effort: 4,
  },
  lossy: {
    id: "webp-q82-m4",
    codec: "libwebp",
    mode: "lossy",
    quality: 82,
    effort: 4,
  },
  near: {
    id: "webp-near80-m4",
    codec: "libwebp",
    mode: "near-lossless",
    quality: 80,
    effort: 4,
  },
} as const satisfies Record<string, OptimizationCandidatePlan>;

describe("libwebp command policy", () => {
  it.each([
    [plans.lossless, ["-lossless", "-m", "4"]],
    [plans.lossy, ["-q", "82", "-m", "4"]],
    [plans.near, ["-near_lossless", "80", "-m", "4"]],
  ] as const)("builds an exact %s candidate command", (candidate, prefix) => {
    expect(buildWebpArgs(candidate, "/work/base.png", "/work/out.webp")).toEqual([
      ...prefix,
      "-exact",
      "-metadata",
      "none",
      "/work/base.png",
      "-o",
      "/work/out.webp",
    ]);
    if (candidate.mode === "near-lossless") {
      expect(buildWebpArgs(candidate, "/work/base.png", "/work/out.webp")).not.toContain("-q");
    }
  });
});

describe("encodeWebpCandidate", () => {
  it.each([
    plans.lossless,
    plans.lossy,
    plans.near,
  ])("validates a static $mode output and preserves alpha", async (candidate) => {
    const directory = await root();
    const normalizedPath = join(directory, "normalized.raw");
    const outputPath = join(directory, "result.webp");
    const pixels = Buffer.from([0, 0, 0, 0, 0, 255, 0, 80, 0, 0, 255, 180, 255, 255, 255, 255]);
    await writeFile(normalizedPath, pixels);
    const run = vi.fn(async (): Promise<CommandResult> => {
      await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
        .webp({
          lossless: candidate.mode !== "lossy",
          nearLossless: candidate.mode === "near-lossless",
          quality: "quality" in candidate ? candidate.quality : undefined,
          effort: candidate.effort,
        })
        .toFile(outputPath);
      return { exitCode: 0, elapsedMs: 6, stderrTail: "" };
    });
    const encoded = await encodeWebpCandidate({
      normalizedPath,
      width: 2,
      height: 2,
      channels: 4,
      candidate,
      outputPath,
      signal: new AbortController().signal,
      run,
    });
    expect(encoded).toMatchObject({
      mime: "image/webp",
      mode: candidate.mode,
      codecBuildId: "libwebp-1.6.0+4fa2191",
    });
    expect(inspectWebp(await readFile(outputPath))).toMatchObject({ animated: false });
    const decoded = await sharp(outputPath).raw().toBuffer();
    expect([...decoded.filter((_value, index) => index % 4 === 3)]).toEqual([0, 80, 180, 255]);
  });
});
