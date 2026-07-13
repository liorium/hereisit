import { describe, expect, it } from "vitest";
import { suggestOutputName } from "./naming";

describe("suggestOutputName", () => {
  it("replaces the source extension", () => {
    expect(suggestOutputName("holiday.photo.PNG", "webp")).toBe("holiday.photo-hereisit.webp");
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
