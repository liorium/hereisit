import { describe, expect, it } from "vitest";
import { getAvailableToolById } from "./tool-catalog";

describe("image crop and rotate tools", () => {
  it("publishes dedicated browser tools with the shared image pipeline contract", () => {
    expect(getAvailableToolById("image.crop")).toMatchObject({
      route: "/image/crop",
      execution: "browser",
      contract: { id: "image.pipeline", version: 2 },
      launcherInput: {
        kinds: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        minFiles: 1,
        maxFiles: 100,
      },
    });
    expect(getAvailableToolById("image.rotate")).toMatchObject({
      route: "/image/rotate",
      execution: "browser",
      contract: { id: "image.pipeline", version: 2 },
      launcherInput: {
        kinds: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        minFiles: 1,
        maxFiles: 100,
      },
    });
  });
});
