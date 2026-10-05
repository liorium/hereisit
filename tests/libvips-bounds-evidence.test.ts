import { expect, it } from "vitest";
import { validateBoundsRuntime } from "../scripts/collect-libvips-bounds-evidence.mjs";

function fixture() {
  const patchSha256 = "a".repeat(64);
  const librarySha256 = "b".repeat(64);
  const revision = "24ad4d042940e6bf99a68871ba886ca8847c9c82";
  return {
    source: { name: "libvips", version: "8.18.7", revision, patchSha256 },
    metadata: {
      name: "libvips",
      revision,
      patchSha256,
      artifacts: [
        { path: "/opt/hereisit-native/libvips/lib/libvips.so.42.20.7", sha256: librarySha256 },
      ],
    },
    libraryPath: "/usr/local/lib/libvips.so.42.20.7",
    librarySha256,
    patchSha256,
    results: {
      runtimeVersion: "8.18.7",
      smallSourceMapped: true,
      oversizedSourceRejectedBeforeRead: true,
      smallSourceSniffed: true,
      oversizedSniffRejectedBeforeRead: true,
    },
  };
}
it("requires exact runtime/source/patch hashes and both probe paths with positive controls", () => {
  const valid = fixture();
  expect(() => validateBoundsRuntime(valid)).not.toThrow();
  for (const field of [
    "smallSourceMapped",
    "oversizedSourceRejectedBeforeRead",
    "smallSourceSniffed",
    "oversizedSniffRejectedBeforeRead",
  ]) {
    expect(() =>
      validateBoundsRuntime({ ...valid, results: { ...valid.results, [field]: false } }),
    ).toThrow(/both paths/);
  }
  for (const field of ["revision", "patchSha256", "version"]) {
    expect(() =>
      validateBoundsRuntime({ ...valid, source: { ...valid.source, [field]: "wrong" } }),
    ).toThrow(/provenance/);
  }
  expect(() => validateBoundsRuntime({ ...valid, librarySha256: "c".repeat(64) })).toThrow(
    /provenance/,
  );
  expect(() =>
    validateBoundsRuntime({
      ...valid,
      metadata: { ...valid.metadata, patchSha256: "c".repeat(64) },
    }),
  ).toThrow(/provenance/);
  expect(() =>
    validateBoundsRuntime({
      ...valid,
      results: {
        runtimeVersion: "8.18.7",
        smallSourceMapped: true,
        oversizedSourceRejectedBeforeRead: true,
      },
    }),
  ).toThrow(/both paths/);
});
