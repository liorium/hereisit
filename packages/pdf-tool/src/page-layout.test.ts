import { describe, expect, it } from "vitest";
import {
  calculateOrientedPdfImageLayout,
  calculatePdfImageDrawMatrix,
  calculatePdfImageLayout,
  type PdfImageOrientation,
} from "./page-layout";

describe("calculatePdfImageLayout", () => {
  it("uses landscape A4 and preserves the image ratio", () => {
    const layout = calculatePdfImageLayout(1600, 900, { size: "a4", margin: 24 });
    expect(layout.pageWidth).toBeGreaterThan(layout.pageHeight);
    expect(layout.width / layout.height).toBeCloseTo(1600 / 900);
    expect(layout.x).toBeGreaterThanOrEqual(24);
    expect(layout.y).toBeGreaterThanOrEqual(24);
  });

  it("creates an image-sized page at 96dpi", () => {
    expect(calculatePdfImageLayout(800, 400, { size: "image", margin: 0 })).toEqual({
      pageWidth: 600,
      pageHeight: 300,
      x: 0,
      y: 0,
      width: 600,
      height: 300,
    });
  });
});

describe("EXIF-oriented PDF image placement", () => {
  it("swaps page dimensions for quarter-turn orientations", () => {
    const normal = calculateOrientedPdfImageLayout(800, 400, { size: "image", margin: 0 }, 1);
    const rotated = calculateOrientedPdfImageLayout(800, 400, { size: "image", margin: 0 }, 6);
    expect([normal.pageWidth, normal.pageHeight]).toEqual([600, 300]);
    expect([rotated.pageWidth, rotated.pageHeight]).toEqual([300, 600]);
  });

  it.each([
    [1, [100, 0, 0, 200, 10, 20]],
    [2, [-100, 0, 0, 200, 110, 20]],
    [3, [-100, 0, 0, -200, 110, 220]],
    [4, [100, 0, 0, -200, 10, 220]],
    [5, [0, -200, -100, 0, 110, 220]],
    [6, [0, -200, 100, 0, 10, 220]],
    [7, [0, 200, 100, 0, 10, 20]],
    [8, [0, 200, -100, 0, 110, 20]],
  ] as const)("maps orientation %i without discarding mirrors", (orientation, expected) => {
    expect(
      calculatePdfImageDrawMatrix(
        { pageWidth: 200, pageHeight: 300, x: 10, y: 20, width: 100, height: 200 },
        orientation as PdfImageOrientation,
      ),
    ).toEqual(expected);
  });
});
