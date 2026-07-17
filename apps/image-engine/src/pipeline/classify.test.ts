import { describe, expect, it } from "vitest";
import { classifyImage, extractImageFeatures } from "./classify";

describe("classifyImage", () => {
  it("applies the calibrated v1 rules in order", () => {
    const base = {
      alphaCoverage: 0,
      uniqueColorRatio: 0.5,
      edgeDensity: 0.05,
      highContrastEdgeRatio: 0.01,
      flatRegionRatio: 0.3,
      lumaEntropyBits: 4,
      noiseResidual: 0.02,
      encodedToRawRatio: 0.2,
    };
    expect(classifyImage({ ...base, alphaCoverage: 0.01 })).toBe("transparent-graphic");
    expect(classifyImage({ ...base, encodedToRawRatio: 0.08, flatRegionRatio: 0.19 })).toBe(
      "already-optimized",
    );
    expect(
      classifyImage({
        ...base,
        uniqueColorRatio: 0.2,
        edgeDensity: 0.12,
        highContrastEdgeRatio: 0.06,
        flatRegionRatio: 0.35,
      }),
    ).toBe("screenshot-text");
    expect(classifyImage({ ...base, uniqueColorRatio: 0.08, flatRegionRatio: 0.6 })).toBe(
      "flat-graphic",
    );
    expect(
      classifyImage({
        ...base,
        lumaEntropyBits: 5.8,
        flatRegionRatio: 0.07,
        noiseResidual: 0.08,
      }),
    ).toBe("noisy");
    expect(classifyImage(base)).toBe("photo");
  });

  it("extracts deterministic bounded features from an RGBA grid", () => {
    const sample = new Uint8Array([
      0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 128, 255, 255, 255, 255,
    ]);
    const first = extractImageFeatures({
      pixels: sample,
      width: 2,
      height: 2,
      channels: 4,
      sampleDepth: 8,
      encodedBytes: 4,
      decodedBytes: 16,
    });
    const second = extractImageFeatures({
      pixels: sample,
      width: 2,
      height: 2,
      channels: 4,
      sampleDepth: 8,
      encodedBytes: 4,
      decodedBytes: 16,
    });
    expect(first).toEqual(second);
    expect(first.alphaCoverage).toBe(0.25);
    expect(first.uniqueColorRatio).toBe(0.5);
    expect(first.encodedToRawRatio).toBe(0.25);
  });

  it("rejects samples above the fixed 256 by 256 bound", () => {
    expect(() =>
      extractImageFeatures({
        pixels: new Uint8Array(257 * 3),
        width: 257,
        height: 1,
        channels: 3,
        sampleDepth: 8,
        encodedBytes: 1,
        decodedBytes: 257 * 3,
      }),
    ).toThrow(/sample dimensions/i);
  });
});
