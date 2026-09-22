import { readFile } from "node:fs/promises";
import { sha256Bytes } from "../../scripts/image-lab-common.mjs";
export const bytes = await readFile("tests/image-corpus/manifest.json");
export const manifest: { entries: { id: string; expected: { class: string; format: string } }[] } =
  JSON.parse(bytes.toString());
const variants = [
  ["smart", "balanced"],
  ["smart", "smallest"],
  ["lossless", "balanced"],
];
const unsupportedLossless = new Set([
  "photo-wide-gamut-jpeg",
  "photo-cmyk-jpeg",
  "photo-cmyk-profile-jpeg",
  "photo-ycck-jpeg",
]);
export function fixture() {
  return {
    version: 1,
    scope: "release",
    identity: {
      engineImageDigest: `sha256:${"a".repeat(64)}`,
      sourceLockSha256: "b".repeat(64),
      corpusManifestSha256: sha256Bytes(bytes),
      liveCostModelSha256: "c".repeat(64),
      metricBuildIds: {
        ssimulacra2: "libjxl-0.11.2-332feb17",
        butteraugli: "libjxl-0.11.2-332feb17",
      },
    },
    records: manifest.entries
      .filter((e) => !["malformed", "truncated", "bomb-regression"].includes(e.expected.class))
      .flatMap((e) =>
        variants.map(([mode, preset]) => {
          const unsupported =
            e.id === "photo-conflicting-adobe-jpeg" ||
            (mode === "lossless" && unsupportedLossless.has(e.id));
          return {
            corpusId: e.id,
            mode,
            preset,
            inputMime: `image/${e.expected.format}`,
            outputMime: unsupported ? null : `image/${e.expected.format}`,
            outcome: unsupported ? "rejected" : "download",
            errorCode: unsupported ? "UNSUPPORTED_INPUT" : null,
            inputBytes: 1000,
            outputBytes: unsupported ? null : 500,
            effectiveDeliveredBytes: unsupported ? null : 500,
            processingMs: 100,
            peakMemoryBytes: 1024,
            qualityChecksPassed: !unsupported,
            alphaChecksPassed: !unsupported,
            deletionVerified: true,
            inputDeletionLagMs: 1,
            resultDeletionLagMs: 1,
            ssimulacra2: unsupported ? null : 90,
            butteraugli: unsupported ? null : 0.5,
            losslessVerification:
              mode === "lossless" && !unsupported
                ? e.expected.format === "jpeg"
                  ? "jpeg-coefficient-exact"
                  : "pixel-exact"
                : null,
            normalizedPixelMatch:
              mode === "lossless" && e.expected.format !== "jpeg" && !unsupported ? true : null,
          };
        }),
      ),
  };
}
