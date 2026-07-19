import { describe, expect, it, vi } from "vitest";
import { runEngineSelfTest } from "./self-test";

describe("image engine runtime self-test", () => {
  it("checks every required runtime artifact and the global libvips build", async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    await expect(
      runEngineSelfTest({
        access,
        loadSharpVersions: async () => ({ sharp: "0.35.3", vips: "8.18.4" }),
      }),
    ).resolves.toEqual({ sharp: "0.35.3", vips: "8.18.4", artifacts: 10 });
    expect(access.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/usr/local/bin/cjpeg",
        "/usr/local/bin/jpeg-coeff-verify",
        "/usr/local/bin/oxipng",
        "/usr/local/bin/png-smart",
        "/usr/local/bin/cwebp",
        "/usr/local/lib/libvips.so",
        "/app/dist/job/job-runner.mjs",
      ]),
    );
  });

  it("rejects a prebuilt or mismatched libvips", async () => {
    await expect(
      runEngineSelfTest({
        access: vi.fn().mockResolvedValue(undefined),
        loadSharpVersions: async () => ({ sharp: "0.35.3", vips: "8.17.0" }),
      }),
    ).rejects.toThrow("libvips");
  });
});
