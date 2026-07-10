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

  it("uses a safe fallback for a dot-only name", () => {
    expect(suggestOutputName("...", "png")).toBe("image-hereisit.png");
  });
});
