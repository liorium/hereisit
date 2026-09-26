import { describe, expect, it } from "vitest";
import sourceLock from "../apps/image-engine/native/sources.lock.json";
import {
  BASE_ENGINE_IMAGE,
  LOCAL_ENGINE_IMAGE,
  prepareLocalImageEngine,
} from "../scripts/prepare-image-engine-local.mjs";

type Command = readonly [string, readonly string[]];
const runtimePackages = {
  schemaVersion: 1,
  snapshot: "20260924T000000Z",
  packages: [{ name: "libglib2.0-0t64", version: "2.80.0-6ubuntu3.9" }],
  copyrightPaths: ["/usr/share/doc/libglib2.0-0t64/copyright"],
};

describe("local image engine preparation", () => {
  it("reuses an existing pinned native base image", async () => {
    const commands: Command[] = [];

    await prepareLocalImageEngine({
      inspect: async (image) => {
        expect(image).toBe(BASE_ENGINE_IMAGE);
        return { ...runtimePackages, sourceLock };
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

  it.each([
    "missing",
    "old snapshot",
    "old GLib",
  ])("rebuilds a %s native base before the source overlay", async (reason) => {
    const commands: Command[] = [];

    await prepareLocalImageEngine({
      inspect: async () => {
        if (reason === "missing") throw new Error("missing image");
        return {
          ...runtimePackages,
          sourceLock,
          ...(reason === "old snapshot"
            ? { snapshot: "20260918T000000Z" }
            : { packages: [{ name: "libglib2.0-0t64", version: "2.80.0-6ubuntu3.8" }] }),
        };
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

  it.each([
    "missing lock",
    "old revision",
    "old version",
  ])("rebuilds a base with %s even when OS packages are current", async (reason) => {
    const commands: Command[] = [];
    const staleLock = structuredClone(sourceLock);
    const libvips = staleLock.sources.find((source) => source.name === "libvips");
    if (libvips === undefined) throw new Error("missing libvips fixture");
    if (reason === "old revision") libvips.revision = "0".repeat(40);
    if (reason === "old version") libvips.version = "8.17.0";

    await prepareLocalImageEngine({
      inspect: async () => ({
        ...runtimePackages,
        sourceLock: reason === "missing lock" ? undefined : staleLock,
      }),
      run: async (command, args) => {
        commands.push([command, args]);
      },
    });

    expect(commands[0]).toEqual([
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
    ]);
    expect(commands).toHaveLength(3);
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
