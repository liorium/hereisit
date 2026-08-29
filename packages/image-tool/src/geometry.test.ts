import { describe, expect, it } from "vitest";
import {
  clampImageDimension,
  computeDrawGeometry,
  focalPointForCropPosition,
  focalPointFromNormalizedPosition,
  normalizedSourceRectFromPoints,
} from "./geometry";

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

  it("maps a free-form source rectangle to exact source pixels", () => {
    const result = computeDrawGeometry(2000, 1000, {
      kind: "cover",
      width: 1200,
      height: 720,
      sourceRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
    });

    expect(result).toMatchObject({
      sourceX: 200,
      sourceY: 200,
      sourceWidth: 1000,
      sourceHeight: 600,
      destinationWidth: 1200,
      destinationHeight: 720,
    });
  });

  it.each([
    ["top-left", 0, 0],
    ["top-center", 0.5, 0],
    ["top-right", 1, 0],
    ["center-left", 0, 0.5],
    ["center", 0.5, 0.5],
    ["center-right", 1, 0.5],
    ["bottom-left", 0, 1],
    ["bottom-center", 0.5, 1],
    ["bottom-right", 1, 1],
  ] as const)("maps %s to a bounded crop focal point", (position, x, y) => {
    expect(focalPointForCropPosition(position)).toEqual({ x, y });
  });

  it.each([
    [1200, 64, 1200],
    [0, 1200, 1200],
    [Number.NaN, 1200, 1200],
    [-10, 1200, 1200],
    [20_000, 1200, 16_384],
    [640.4, 1200, 640],
  ] as const)("normalizes crop dimensions safely", (value, fallback, expected) => {
    expect(clampImageDimension(value, fallback)).toBe(expected);
  });

  it.each([
    [-1, 0.5, 0, 0.5],
    [0.25, 0.75, 0.25, 0.75],
    [2, 3, 1, 1],
    [Number.NaN, Number.POSITIVE_INFINITY, 0.5, 0.5],
  ] as const)("clamps a dragged crop position to the image bounds", (x, y, expectedX, expectedY) => {
    expect(focalPointFromNormalizedPosition(x, y)).toEqual({ x: expectedX, y: expectedY });
  });

  it.each([
    [0.1, 0.2, 0.6, 0.8, 0.01, 0.01, { x: 0.1, y: 0.2, width: 0.5, height: 0.6 }],
    [0.8, 0.9, 0.2, 0.1, 0.01, 0.01, { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }],
    [-1, -1, -1, -1, 0.25, 0.5, { x: 0, y: 0, width: 0.25, height: 0.5 }],
    [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.01,
      0.01,
      { x: 0.5, y: 0.5, width: 0.01, height: 0.01 },
    ],
    [
      0.999999,
      0.1,
      1,
      0.2,
      0.000001,
      0.000001,
      { x: 0.999999, y: 0.1, width: 0.000001, height: 0.1 },
    ],
  ] as const)("normalizes a free crop drag into a bounded source rectangle", (...args) => {
    const [startX, startY, endX, endY, minimumWidth, minimumHeight, expected] = args;
    expect(
      normalizedSourceRectFromPoints(startX, startY, endX, endY, minimumWidth, minimumHeight),
    ).toEqual(expected);
  });

  it.each([90, 270] as const)("swaps output dimensions for a %d degree turn", (rotation) => {
    const result = computeDrawGeometry(1600, 900, { kind: "none" }, rotation);

    expect(result).toMatchObject({
      canvasWidth: 900,
      canvasHeight: 1600,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 1600,
      sourceHeight: 900,
      destinationWidth: 900,
      destinationHeight: 1600,
    });
  });

  it("keeps dimensions for a half turn", () => {
    expect(computeDrawGeometry(1600, 900, { kind: "none" }, 180)).toMatchObject({
      canvasWidth: 1600,
      canvasHeight: 900,
    });
  });
});
