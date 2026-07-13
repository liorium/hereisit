import { describe, expect, it } from "vitest";
import { safeImageBaseName } from "./naming";
import {
  dedupeArchiveNames,
  resolveImageWatermarkOutput,
  suggestWatermarkedImageName,
} from "./watermark-output";

describe("resolveImageWatermarkOutput", () => {
  it.each([
    [
      "jpeg",
      {
        format: "jpeg",
        mime: "image/jpeg",
        quality: 90,
        matte: "#ffffff",
        sourceFormatConverted: false,
      },
    ],
    [
      "png",
      {
        format: "png",
        mime: "image/png",
        sourceFormatConverted: false,
      },
    ],
    [
      "webp",
      {
        format: "webp",
        mime: "image/webp",
        quality: 90,
        sourceFormatConverted: false,
      },
    ],
    [
      "heic",
      {
        format: "jpeg",
        mime: "image/jpeg",
        quality: 90,
        matte: "#ffffff",
        sourceFormatConverted: true,
      },
    ],
  ] as const)("resolves source-mode %s output", (sourceFormat, expected) => {
    expect(resolveImageWatermarkOutput(sourceFormat, { format: "source", quality: 90 })).toEqual(
      expected,
    );
  });

  it("resolves explicit JPEG with lossy quality and a white matte", () => {
    expect(
      resolveImageWatermarkOutput("png", {
        format: "jpeg",
        quality: 82,
        matte: "#ffffff",
      }),
    ).toEqual({
      format: "jpeg",
      mime: "image/jpeg",
      quality: 82,
      matte: "#ffffff",
      sourceFormatConverted: false,
    });
  });

  it("resolves explicit WebP with lossy quality and no matte", () => {
    expect(resolveImageWatermarkOutput("jpeg", { format: "webp", quality: 75 })).toEqual({
      format: "webp",
      mime: "image/webp",
      quality: 75,
      sourceFormatConverted: false,
    });
  });

  it("resolves explicit PNG without carrying lossy settings", () => {
    expect(resolveImageWatermarkOutput("jpeg", { format: "png" })).toEqual({
      format: "png",
      mime: "image/png",
      sourceFormatConverted: false,
    });
  });
});

describe("suggestWatermarkedImageName", () => {
  it("replaces the source extension with the resolved output extension", () => {
    expect(suggestWatermarkedImageName("holiday.photo.PNG", "webp")).toBe(
      "holiday.photo-watermarked-hereisit.webp",
    );
  });

  it("removes paths, controls, and reserved filename characters", () => {
    expect(suggestWatermarkedImageName("../private\\bad:<name>\u0000.jpg", "jpeg")).toBe(
      "bad--name--watermarked-hereisit.jpg",
    );
  });

  it("removes C1 and bidirectional format controls from generated result names", () => {
    expect(
      suggestWatermarkedImageName(
        "\u202e report\u0085\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069.png",
        "png",
      ),
    ).toBe("report-watermarked-hereisit.png");
  });

  it("uses a safe fallback for a dot-only name", () => {
    expect(suggestWatermarkedImageName("...", "png")).toBe("image-watermarked-hereisit.png");
  });

  it("truncates the safe stem to 120 Unicode code points", () => {
    const stem = "🙂".repeat(121);

    expect(safeImageBaseName(`${stem}.png`)).toBe("🙂".repeat(120));
    expect(suggestWatermarkedImageName(`${stem}.png`, "png")).toBe(
      `${"🙂".repeat(120)}-watermarked-hereisit.png`,
    );
  });

  it("keeps a source name that has no extension", () => {
    expect(suggestWatermarkedImageName("receipt", "jpeg")).toBe("receipt-watermarked-hereisit.jpg");
  });
});

describe("dedupeArchiveNames", () => {
  it("reserves names generated for earlier collisions", () => {
    expect(dedupeArchiveNames(["a.png", "a.png", "a-2.png", "a.png"])).toEqual([
      "a.png",
      "a-2.png",
      "a-2-2.png",
      "a-3.png",
    ]);
  });

  it("detects collisions case-insensitively while preserving original casing", () => {
    expect(dedupeArchiveNames(["Photo.PNG", "photo.png", "PHOTO-2.PNG", "photo.png"])).toEqual([
      "Photo.PNG",
      "photo-2.png",
      "PHOTO-2-2.PNG",
      "photo-3.png",
    ]);
  });

  it("inserts suffixes before the final extension and handles extensionless names", () => {
    expect(
      dedupeArchiveNames(["archive", "archive", "report.final.png", "REPORT.FINAL.PNG"]),
    ).toEqual(["archive", "archive-2", "report.final.png", "REPORT.FINAL-2.PNG"]);
  });
});
