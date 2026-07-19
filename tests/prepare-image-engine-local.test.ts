import { describe, expect, it } from "vitest";
import {
  BASE_ENGINE_IMAGE,
  LOCAL_ENGINE_IMAGE,
  prepareLocalImageEngine,
} from "../scripts/prepare-image-engine-local.mjs";

type Command = readonly [string, readonly string[]];

describe("local image engine preparation", () => {
  it("reuses an existing pinned native base image", async () => {
    const commands: Command[] = [];

    await prepareLocalImageEngine({
      inspect: async (image) => {
        expect(image).toBe(BASE_ENGINE_IMAGE);
      },
      run: async (command, args) => {
        commands.push([command, args]);
      },
    });

    expect(commands).toEqual([
      ["pnpm", ["--filter", "@hereisit/image-engine", "build"]],
      [
        "docker",
        [
          "build",
          "--file",
          "apps/image-engine/Dockerfile.local-reuse",
          "--tag",
          LOCAL_ENGINE_IMAGE,
          "apps/image-engine",
        ],
      ],
    ]);
  });

  it("builds the pinned native base before the source overlay on a clean runner", async () => {
    const commands: Command[] = [];

    await prepareLocalImageEngine({
      inspect: async () => {
        throw new Error("missing image");
      },
      run: async (command, args) => {
        commands.push([command, args]);
      },
    });

    expect(commands).toEqual([
      [
        "docker",
        [
          "build",
          "--file",
          "apps/image-engine/Dockerfile",
          "--target",
          "production",
          "--tag",
          BASE_ENGINE_IMAGE,
          ".",
        ],
      ],
      ["pnpm", ["--filter", "@hereisit/image-engine", "build"]],
      [
        "docker",
        [
          "build",
          "--file",
          "apps/image-engine/Dockerfile.local-reuse",
          "--tag",
          LOCAL_ENGINE_IMAGE,
          "apps/image-engine",
        ],
      ],
    ]);
  });

  it("stops before the overlay when the native base build fails", async () => {
    const commands: Command[] = [];
    const failure = new Error("native build failed");

    await expect(
      prepareLocalImageEngine({
        inspect: async () => {
          throw new Error("missing image");
        },
        run: async (command, args) => {
          commands.push([command, args]);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(commands).toHaveLength(1);
  });
});
