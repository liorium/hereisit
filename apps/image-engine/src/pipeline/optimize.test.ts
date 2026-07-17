import { describe, expect, it, vi } from "vitest";
import { BoundedCommandError } from "../codecs/command";
import type { CodecCandidate } from "../codecs/jpeg";
import { OptimizationExecutionError, optimizeCandidates } from "./optimize";
import type { OptimizationCandidatePlan, OptimizationPlan } from "./plan";

const candidates = [82, 78, 86].map(
  (quality): OptimizationCandidatePlan => ({
    id: `jpeg-q${quality}-444`,
    codec: "mozjpeg",
    mode: "lossy",
    quality,
    chroma: "444",
    effort: 3,
  }),
);

const plan: OptimizationPlan = {
  contentClass: "screenshot-text",
  candidates: candidates as [
    OptimizationCandidatePlan,
    OptimizationCandidatePlan,
    OptimizationCandidatePlan,
  ],
  normalizeColorWithLcms: false,
  requirePixelExact: false,
  requireAlphaExact: true,
  minimumSavingsPercent: 1,
};

function encoded(candidate: OptimizationCandidatePlan, byteLength: number): CodecCandidate {
  return {
    id: candidate.id,
    path: `/work/${candidate.id}.jpg`,
    mime: "image/jpeg",
    byteLength,
    encodeMs: 1,
    codecBuildId: "test",
    mode: candidate.mode,
  };
}

describe("optimizeCandidates", () => {
  it("runs in plan order and stops when size and quality margins both pass", async () => {
    const encode = vi.fn(async (candidate: OptimizationCandidatePlan, index: number) =>
      encoded(candidate, index === 0 ? 8_000 : 7_000),
    );
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ accepted: true, sizeTargetPassed: false, qualityMarginPassed: true })
      .mockResolvedValueOnce({ accepted: true, sizeTargetPassed: true, qualityMarginPassed: true });
    await expect(
      optimizeCandidates({ plan, encode, verify, signal: new AbortController().signal }),
    ).resolves.toMatchObject({ selected: { byteLength: 7_000 }, testedCandidates: 2 });
    expect(encode.mock.calls.map(([candidate]) => candidate.id)).toEqual([
      "jpeg-q82-444",
      "jpeg-q78-444",
    ]);
  });

  it("never executes more than three candidates", async () => {
    const encode = vi.fn(async (candidate: OptimizationCandidatePlan) => encoded(candidate, 9_000));
    const verify = vi.fn(async () => ({
      accepted: false,
      sizeTargetPassed: false,
      qualityMarginPassed: false,
    }));
    await expect(
      optimizeCandidates({ plan, encode, verify, signal: new AbortController().signal }),
    ).resolves.toEqual({ selected: null, testedCandidates: 3 });
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it("returns an accepted candidate when a later codec reaches its deadline", async () => {
    const first = encoded(candidates[0] as OptimizationCandidatePlan, 8_000);
    const encode = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new BoundedCommandError("timeout"));
    const verify = vi.fn(async () => ({
      accepted: true,
      sizeTargetPassed: false,
      qualityMarginPassed: true,
    }));
    await expect(
      optimizeCandidates({ plan, encode, verify, signal: new AbortController().signal }),
    ).resolves.toEqual({ selected: first, testedCandidates: 2 });
  });

  it("fails the first deadline without asking Queue to repeat the preset", async () => {
    const encode = vi.fn(async () => {
      throw new BoundedCommandError("timeout");
    });
    let error: unknown;
    try {
      await optimizeCandidates({
        plan,
        encode,
        verify: vi.fn(),
        signal: new AbortController().signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(
      new OptimizationExecutionError("ENGINE_TIMEOUT", false, "TRY_BALANCED_PRESET"),
    );
  });
});
