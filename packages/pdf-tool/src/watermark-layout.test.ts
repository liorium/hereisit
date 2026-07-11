import { describe, expect, it } from "vitest";
import {
  calculateWatermarkPlacements,
  MAX_WATERMARK_TILES_PER_PAGE,
  type WatermarkDrawPlacement,
  type WatermarkRotation,
} from "./watermark-layout";

function rotatedCorners(placement: WatermarkDrawPlacement): readonly [number, number][] {
  const radians = (placement.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const transform = (localX: number, localY: number): [number, number] => [
    placement.x + localX * cosine - localY * sine,
    placement.y + localX * sine + localY * cosine,
  ];
  return [
    transform(0, 0),
    transform(placement.width, 0),
    transform(0, placement.height),
    transform(placement.width, placement.height),
  ];
}

function expectInsidePage(
  placements: readonly WatermarkDrawPlacement[],
  pageWidth: number,
  pageHeight: number,
): void {
  for (const placement of placements) {
    expect(Object.values(placement).every(Number.isFinite)).toBe(true);
    for (const [x, y] of rotatedCorners(placement)) {
      expect(x).toBeGreaterThanOrEqual(-1e-8);
      expect(x).toBeLessThanOrEqual(pageWidth + 1e-8);
      expect(y).toBeGreaterThanOrEqual(-1e-8);
      expect(y).toBeLessThanOrEqual(pageHeight + 1e-8);
    }
  }
}

describe("calculateWatermarkPlacements", () => {
  it("centers an unrotated watermark at its requested font size", () => {
    expect(
      calculateWatermarkPlacements({
        pageWidth: 600,
        pageHeight: 800,
        imageAspectRatio: 4,
        fontSize: 50,
        rotation: 0,
        placement: "center",
      }),
    ).toEqual([{ x: 200, y: 375, width: 200, height: 50, rotation: 0 }]);
  });

  it.each([
    -45, 0, 45,
  ] as const)("keeps a centered %i-degree watermark inside a small page", (rotation) => {
    const placements = calculateWatermarkPlacements({
      pageWidth: 100,
      pageHeight: 80,
      imageAspectRatio: 10,
      fontSize: 96,
      rotation,
      placement: "center",
    });
    expect(placements).toHaveLength(1);
    expectInsidePage(placements, 100, 80);
  });

  it.each([
    -45, 0, 45,
  ] as const)("bounds repeated %i-degree draws to twelve placements", (rotation: WatermarkRotation) => {
    const placements = calculateWatermarkPlacements({
      pageWidth: 600,
      pageHeight: 800,
      imageAspectRatio: 4,
      fontSize: 24,
      rotation,
      placement: "tile",
    });
    expect(placements.length).toBeGreaterThan(1);
    expect(placements.length).toBeLessThanOrEqual(MAX_WATERMARK_TILES_PER_PAGE);
    expectInsidePage(placements, 600, 800);
  });

  it("uses at most a four-by-three grid on a landscape page", () => {
    const placements = calculateWatermarkPlacements({
      pageWidth: 842,
      pageHeight: 595,
      imageAspectRatio: 2,
      fontSize: 12,
      rotation: 0,
      placement: "tile",
    });
    expect(placements).toHaveLength(MAX_WATERMARK_TILES_PER_PAGE);
    expectInsidePage(placements, 842, 595);
  });

  it.each([
    { pageWidth: 0 },
    { pageWidth: Number.NaN },
    { pageHeight: Number.POSITIVE_INFINITY },
    { pageHeight: 14_401 },
    { imageAspectRatio: 0 },
    { imageAspectRatio: Number.POSITIVE_INFINITY },
    { fontSize: -1 },
    { fontSize: Number.NaN },
    { rotation: 181 },
    { rotation: 12.5 },
  ])("rejects invalid geometry: $pageWidth $pageHeight", (override) => {
    expect(() =>
      calculateWatermarkPlacements({
        pageWidth: 600,
        pageHeight: 800,
        imageAspectRatio: 4,
        fontSize: 36,
        rotation: -45,
        placement: "center",
        ...override,
      }),
    ).toThrow(RangeError);
  });

  it("rejects an overflowing derived image width", () => {
    expect(() =>
      calculateWatermarkPlacements({
        pageWidth: 600,
        pageHeight: 800,
        imageAspectRatio: Number.MAX_VALUE,
        fontSize: 96,
        rotation: 0,
        placement: "center",
      }),
    ).toThrow(RangeError);
  });
});
