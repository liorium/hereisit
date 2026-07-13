import type { ImageWatermarkPosition } from "@hereisit/tool-contracts";
import { describe, expect, it } from "vitest";
import { computeWatermarkRect, fitWatermarkSize } from "./watermark-layout";

describe("computeWatermarkRect", () => {
  const anchors: ReadonlyArray<
    readonly [ImageWatermarkPosition, { readonly x: number; readonly y: number }]
  > = [
    ["top-left", { x: 40, y: 40 }],
    ["top-center", { x: 400, y: 40 }],
    ["top-right", { x: 760, y: 40 }],
    ["middle-left", { x: 40, y: 350 }],
    ["center", { x: 400, y: 350 }],
    ["middle-right", { x: 760, y: 350 }],
    ["bottom-left", { x: 40, y: 660 }],
    ["bottom-center", { x: 400, y: 660 }],
    ["bottom-right", { x: 760, y: 660 }],
  ];

  it.each(anchors)("places a watermark at the %s anchor", (position, expected) => {
    expect(
      computeWatermarkRect({
        canvasWidth: 1000,
        canvasHeight: 800,
        watermarkWidth: 200,
        watermarkHeight: 100,
        position,
        marginPercent: 5,
      }),
    ).toEqual({ ...expected, width: 200, height: 100 });
  });

  it("fits an oversized watermark into the margin-safe area", () => {
    const rectangle = computeWatermarkRect({
      canvasWidth: 10,
      canvasHeight: 8,
      watermarkWidth: 200,
      watermarkHeight: 100,
      position: "bottom-right",
      marginPercent: 10,
    });

    expect(rectangle).toEqual({ x: 1, y: 3, width: 8, height: 4 });
    expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(10);
    expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(8);
  });

  it("keeps a rounded proportional fit inside the canvas", () => {
    const rectangle = computeWatermarkRect({
      canvasWidth: 7,
      canvasHeight: 7,
      watermarkWidth: 25,
      watermarkHeight: 1,
      position: "center",
      marginPercent: 0,
    });

    expect(rectangle).toEqual({ x: 0, y: 3.36, width: 7, height: 0.28 });
  });

  it.each([
    ["non-finite canvas width", Number.POSITIVE_INFINITY, 800, 200, 100, 5],
    ["zero canvas height", 1000, 0, 200, 100, 5],
    ["negative watermark width", 1000, 800, -1, 100, 5],
    ["non-finite watermark height", 1000, 800, 200, Number.NaN, 5],
    ["negative margin", 1000, 800, 200, 100, -1],
    ["non-finite margin", 1000, 800, 200, 100, Number.NaN],
  ])("rejects a %s", (_label, canvasWidth, canvasHeight, watermarkWidth, watermarkHeight, marginPercent) => {
    expect(() =>
      computeWatermarkRect({
        canvasWidth,
        canvasHeight,
        watermarkWidth,
        watermarkHeight,
        position: "center",
        marginPercent,
      }),
    ).toThrow(RangeError);
  });

  it("rejects dimensions whose proportional fit cannot produce a positive rectangle", () => {
    expect(() =>
      computeWatermarkRect({
        canvasWidth: 1,
        canvasHeight: 1,
        watermarkWidth: Number.MAX_VALUE,
        watermarkHeight: Number.MIN_VALUE,
        position: "center",
        marginPercent: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("fitWatermarkSize", () => {
  it("fits proportionally inside both maximum dimensions", () => {
    expect(fitWatermarkSize(800, 400, 300, 300)).toEqual({ width: 300, height: 150 });
  });

  it("never upscales content that already fits", () => {
    expect(fitWatermarkSize(100, 50, 300, 300)).toEqual({ width: 100, height: 50 });
  });

  it("does not round a limiting dimension above its maximum", () => {
    expect(fitWatermarkSize(25, 1, 7, 7)).toEqual({ width: 7, height: 0.28 });
  });

  it.each([
    ["non-finite content width", Number.NaN, 400, 300, 300],
    ["non-finite content height", 800, Number.POSITIVE_INFINITY, 300, 300],
    ["zero maximum width", 800, 400, 0, 300],
    ["negative maximum height", 800, 400, 300, -1],
  ])("rejects a %s", (_label, contentWidth, contentHeight, maximumWidth, maximumHeight) => {
    expect(() =>
      fitWatermarkSize(contentWidth, contentHeight, maximumWidth, maximumHeight),
    ).toThrow(RangeError);
  });

  it("rejects a fit that underflows to an impossible zero dimension", () => {
    expect(() =>
      fitWatermarkSize(Number.MAX_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE),
    ).toThrow(RangeError);
  });
});
