import { describe, expect, it } from "vitest";
import { findImagePreset, imagePresets } from "./index";

describe("image presets", () => {
  it("gives only the size-only preset a hard smaller-output goal", () => {
    expect(findImagePreset("balanced").spec.sizeGoal?.mode).toBe("smaller-only");
    expect(findImagePreset("balanced").spec.resize).toEqual({
      kind: "inside",
      maxWidth: 5000,
      maxHeight: 5000,
    });
    expect(
      imagePresets
        .filter((preset) => preset.id !== "balanced")
        .every((preset) => preset.spec.sizeGoal?.mode === "allow-growth"),
    ).toBe(true);
  });
  it("keeps the format-conversion preset at the original dimensions", () => {
    const preset = findImagePreset("convert-webp");
    expect(preset.id).toBe("convert-webp");
    expect(preset.spec.resize).toEqual({ kind: "none" });
    expect(preset.spec.output.format).toBe("webp");
    expect(preset.spec.sizeGoal?.mode).toBe("allow-growth");
  });
});
