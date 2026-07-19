import { describe, expect, it } from "vitest";
import { suggestOutputName, suggestSameFormatOptimizedName } from "./naming";

describe("suggestOutputName", () => {
  it("replaces the source extension", () => {
    expect(suggestOutputName("holiday.photo.PNG", "webp")).toBe("holiday.photo-hereisit.webp");
  });

  it.each([
    ["portrait.jpeg", "jpeg", "portrait-hereisit.jpeg"],
    ["holiday.photo.PNG", "png", "holiday.photo-hereisit.PNG"],
    ["already.WEBP", "webp", "already-hereisit.WEBP"],
    ["misleading.png", "jpeg", "misleading-hereisit.jpg"],
  ] as const)("preserves a matching source extension for %s", (name, format, expected) => {
    expect(suggestOutputName(name, format, { preserveMatchingExtension: true })).toBe(expected);
  });

  it("removes paths, control characters, and reserved filename characters", () => {
    expect(suggestOutputName("../private\\bad:<name>\u0000.jpg", "jpeg")).toBe(
      "bad--name--hereisit.jpg",
    );
  });

  it("removes C1 and bidirectional format controls without exposing edge whitespace", () => {
    expect(
      suggestOutputName(
        "\u202e report\u0085\u009f\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069.png",
        "png",
      ),
    ).toBe("report-hereisit.png");
  });

  it("uses a safe fallback for a dot-only name", () => {
    expect(suggestOutputName("...", "png")).toBe("image-hereisit.png");
  });
});

describe("suggestSameFormatOptimizedName", () => {
  it("normalizes the extension while preserving the safe source stem", () => {
    expect(suggestSameFormatOptimizedName("휴가.JPG", "image/jpeg")).toBe("휴가-hereisit.jpg");
    expect(suggestSameFormatOptimizedName("../private.png", "image/png")).toBe(
      "private-hereisit.png",
    );
    expect(suggestSameFormatOptimizedName("photo.jpeg", "image/webp")).toBe("photo-hereisit.webp");
  });
});
