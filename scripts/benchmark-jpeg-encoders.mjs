import { pathToFileURL } from "node:url";

export const productionJpegEncoder = "mozjpeg";
export const runtimeInventory = Object.freeze([
  "mozjpeg",
  "libwebp",
  "oxipng",
  "png-smart",
  "libvips",
]);

export const promotionReport = Object.freeze({
  schemaVersion: 1,
  candidate: "jpegli",
  production: "mozjpeg",
  patentReview: "not-approved",
  corpusComplete: false,
  thresholds: Object.freeze({
    qualityPassed: false,
    sizePassed: false,
    latencyPassed: false,
    memoryPassed: false,
  }),
});

/**
 * A benchmark result is evidence only. Promotion remains a separately reviewed configuration change.
 * @param {unknown} report
 */
export function evaluateJpegliPromotion(report) {
  if (typeof report !== "object" || report === null || Array.isArray(report)) return false;
  const value = /** @type {Record<string, unknown>} */ (report);
  const thresholds = value.thresholds;
  if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds))
    return false;
  const gates = /** @type {Record<string, unknown>} */ (thresholds);
  return (
    value.schemaVersion === 1 &&
    value.candidate === "jpegli" &&
    value.production === "mozjpeg" &&
    value.patentReview === "approved" &&
    value.corpusComplete === true &&
    gates.qualityPassed === true &&
    gates.sizePassed === true &&
    gates.latencyPassed === true &&
    gates.memoryPassed === true
  );
}

/**
 * Runs both encoders over the identical, explicitly authorized corpus. Returned evidence contains
 * hashes and measurements only; local corpus paths never enter the report.
 * @param {{
 *   corpus: {authorization: string, items: Array<{inputPath: string, sha256: string}>},
 *   run: (input: {encoder: "mozjpeg" | "jpegli", inputPath: string, quality: number}) =>
 *     Promise<{byteLength: number, encodeMs: number, outputSha256: string}>
 * }} input
 */
export async function benchmarkJpegEncoders(input) {
  if (
    input.corpus.authorization !== "hereisit-benchmark-v1" ||
    !Array.isArray(input.corpus.items) ||
    input.corpus.items.length < 1 ||
    input.corpus.items.length > 10_000
  ) {
    throw new TypeError("authorized JPEG benchmark corpus is required");
  }
  const results = [];
  for (const item of input.corpus.items) {
    if (
      typeof item.inputPath !== "string" ||
      item.inputPath.length === 0 ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    ) {
      throw new TypeError("JPEG benchmark corpus item is invalid");
    }
    const measurements = {};
    for (const encoder of ["mozjpeg", "jpegli"]) {
      const measured = await input.run({ encoder, inputPath: item.inputPath, quality: 82 });
      if (
        !Number.isSafeInteger(measured.byteLength) ||
        measured.byteLength < 1 ||
        !Number.isFinite(measured.encodeMs) ||
        measured.encodeMs < 0 ||
        !/^[a-f0-9]{64}$/.test(measured.outputSha256)
      ) {
        throw new TypeError("JPEG benchmark measurement is invalid");
      }
      measurements[encoder] = {
        byteLength: measured.byteLength,
        encodeMs: measured.encodeMs,
        outputSha256: measured.outputSha256,
      };
    }
    results.push({
      sourceSha256: item.sha256,
      mozjpeg: measurements.mozjpeg,
      jpegli: measurements.jpegli,
    });
  }
  return canonical({
    schemaVersion: 1,
    candidate: "jpegli",
    production: "mozjpeg",
    patentReview: "not-approved",
    corpusComplete: results.length === input.corpus.items.length,
    thresholds: {
      qualityPassed: false,
      sizePassed: false,
      latencyPassed: false,
      memoryPassed: false,
    },
    results,
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(canonical(promotionReport))}\n`);
}
