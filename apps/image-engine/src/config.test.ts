import { describe, expect, it } from "vitest";
import { readEngineConfig } from "./config";

const valid = {
  ENGINE_BUILD_ID: "engine-test",
  JPEG_CODEC_BUILD_ID: "jpeg-test",
  PNG_CODEC_BUILD_ID: "png-test",
  WEBP_CODEC_BUILD_ID: "webp-test",
  TRANSFORM_BUILD_ID: "transform-test",
};

describe("engine config", () => {
  it("uses a bounded default rollout grace", () => {
    expect(readEngineConfig(valid).shutdownGraceMs).toBe(30_000);
  });

  it.each(["-1", "1.5", "120001", "invalid"])("rejects invalid rollout grace %s", (value) => {
    expect(() => readEngineConfig({ ...valid, ROLLOUT_GRACE_MS: value })).toThrow();
  });
});
