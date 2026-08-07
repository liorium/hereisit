import { describe, expect, it } from "vitest";
import {
  acceptPdfThumbnailBytes,
  MAX_PDF_THUMBNAIL_TOTAL_BYTES,
  planPdfThumbnailRaster,
} from "./thumbnail-plan";

describe("PDF thumbnail planning", () => {
  it("fits the long edge to 160px without upscaling", () => {
    expect(planPdfThumbnailRaster(612, 792)).toEqual({
      scale: 160 / 792,
      width: 124,
      height: 160,
      rawByteLimit: 124 * 160 * 4,
    });
    expect(planPdfThumbnailRaster(80, 40)).toEqual({
      scale: 1,
      width: 80,
      height: 40,
      rawByteLimit: 80 * 40 * 4,
    });
  });

  it("rejects invalid dimensions and encoded or aggregate overflow", () => {
    expect(() => planPdfThumbnailRaster(0, 10)).toThrow(RangeError);
    expect(acceptPdfThumbnailBytes(0, 101, 100)).toBeUndefined();
    expect(
      acceptPdfThumbnailBytes(MAX_PDF_THUMBNAIL_TOTAL_BYTES - 10, 11, 100),
    ).toBeUndefined();
    expect(acceptPdfThumbnailBytes(10, 20, 100)).toBe(30);
  });
});
