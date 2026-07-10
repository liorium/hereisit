import { describe, expect, it } from "vitest";
import { imagePipelineSpecSchema } from "./index";

describe("imagePipelineSpecSchema", () => {
  it("rejects an inverted target-size quality range", () => {
    const result = imagePipelineSpecSchema.safeParse({
      version: 1,
      resize: { kind: "none" },
      output: {
        format: "webp",
        compression: {
          mode: "maxBytes",
          maxBytes: 100_000,
          minQuality: 92,
          maxQuality: 35,
          maxAttempts: 6,
        },
      },
      autoOrient: true,
      metadata: "strip",
    });
    expect(result.success).toBe(false);
  });

  it("defaults legacy specs to allow output growth", () => {
    const result = imagePipelineSpecSchema.parse({
      version: 1,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      autoOrient: true,
      metadata: "strip",
    });

    expect(result.sizeGoal).toEqual({ mode: "allow-growth" });
  });

  it("fills bounded defaults for the smaller-only goal", () => {
    const result = imagePipelineSpecSchema.parse({
      version: 1,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      sizeGoal: { mode: "smaller-only" },
      autoOrient: true,
      metadata: "strip",
    });

    expect(result.sizeGoal).toEqual({
      mode: "smaller-only",
      minSavingsPercent: 1,
      minQuality: 35,
      maxAttempts: 6,
    });
  });
});
