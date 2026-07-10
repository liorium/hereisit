import { describe, expect, it } from "vitest";
import { computeDrawGeometry } from "./geometry";

describe("computeDrawGeometry", () => {
  it("keeps the original dimensions when resize is disabled", () => {
    const result = computeDrawGeometry(1600, 900, { kind: "none" });
    expect(result.canvasWidth).toBe(1600);
    expect(result.canvasHeight).toBe(900);
  });

  it("fits an image inside a bounding box without changing its ratio", () => {
    const result = computeDrawGeometry(4000, 3000, {
      kind: "inside",
      maxWidth: 1200,
      maxHeight: 1200,
    });
    expect(result.canvasWidth).toBe(1200);
    expect(result.canvasHeight).toBe(900);
  });

  it("does not upscale by default", () => {
    const result = computeDrawGeometry(400, 300, { kind: "inside", maxWidth: 1200 });
    expect(result.canvasWidth).toBe(400);
    expect(result.upscalingSkipped).toBe(true);
  });

  it("computes a centered landscape crop for a square output", () => {
    const result = computeDrawGeometry(2000, 1000, {
      kind: "cover",
      width: 1000,
      height: 1000,
    });
    expect(result.sourceX).toBe(500);
    expect(result.sourceWidth).toBe(1000);
    expect(result.sourceHeight).toBe(1000);
  });
});
