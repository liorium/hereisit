import { describe, expect, it } from "vitest";
import { findImagePreset, imagePresets } from "./index";

describe("image presets", () => {
  it("gives only the size-only preset a hard smaller-output goal", () => {
    expect(findImagePreset("balanced").spec.sizeGoal?.mode).toBe("smaller-only");
    expect(
      imagePresets
        .filter((preset) => preset.id !== "balanced")
        .every((preset) => preset.spec.sizeGoal?.mode === "allow-growth"),
    ).toBe(true);
  });
});
