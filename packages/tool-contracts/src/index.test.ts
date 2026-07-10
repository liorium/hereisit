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
});
