import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  parseCliArguments,
  sha256Canonical,
} from "./image-lab-common.mjs";

const require = createRequire(import.meta.url);
const sharp = require("../apps/image-engine/node_modules/sharp");

const strategicTags = Object.freeze(["korean-text", "ui", "code", "logo", "flat-graphic"]);
const warmJpegWebpP95LimitMs = 3000;
const standardPngP95LimitMs = 8000;
const ordinaryPeakMemoryLimitBytes = 512 * 1024 * 1024;

function check(failures, passed, code) {
  if (!passed) failures.push(code);
}

function percentile95(values) {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

export function evaluateImageQualityReport(rawReport) {
  const report = assertObject(rawReport, "quality report");
  const aggregate = assertObject(report.aggregate, "quality report aggregate");
  const thresholds = assertObject(report.thresholds, "quality report thresholds");
  const failures = [];
  check(failures, aggregate.supportedSuccessRate >= 0.99, "SUPPORTED_SUCCESS_RATE");
  check(failures, aggregate.severeRegressions === 0, "SEVERE_REGRESSION");
  check(failures, aggregate.maxSsimulacra2Deficit <= 1, "SSIMULACRA2_DEFICIT");
  check(failures, aggregate.maxButteraugliRegression <= 0.1, "BUTTERAUGLI_REGRESSION");
  check(failures, aggregate.largerSelectedOutputs === 0, "LARGER_SELECTED_OUTPUT");
  check(failures, aggregate.losslessVerificationMismatches === 0, "LOSSLESS_VERIFICATION_MISMATCH");
  check(failures, aggregate.alphaCompositeMismatches === 0, "ALPHA_COMPOSITE_MISMATCH");
  check(failures, aggregate.mixedMetricBuilds === 0, "MIXED_METRIC_BUILDS");
  check(
    failures,
    aggregate.missingAuthorizedCompetitorMeasurements === 0,
    "MISSING_AUTHORIZED_COMPETITOR",
  );
  check(failures, aggregate.falseNoSizeReductionPassRate >= 0.9, "FALSE_NO_SIZE_REDUCTION");
  check(failures, aggregate.comparableMedianBaselineRatio <= 1.05, "COMPETITOR_MEDIAN_SIZE");
  check(failures, aggregate.warmJpegWebpP95Ms <= warmJpegWebpP95LimitMs, "WARM_JPEG_WEBP_P95");
  check(failures, aggregate.standardPngP95Ms <= standardPngP95LimitMs, "STANDARD_PNG_P95");
  check(failures, aggregate.ordinaryPeakMemoryBytes <= ordinaryPeakMemoryLimitBytes, "PEAK_MEMORY");
  check(failures, aggregate.cancellationP95Ms <= 1000, "CANCELLATION_P95");
  check(failures, aggregate.policyP95Ms <= 500, "POLICY_P95");
  check(failures, aggregate.localFeedbackP95Ms <= 100, "LOCAL_FEEDBACK_P95");
  check(failures, aggregate.streamingUpload === true, "STREAMING_UPLOAD");
  check(failures, aggregate.uploadWorkerCpuP95Ms <= 100, "UPLOAD_WORKER_CPU_P95");
  check(failures, aggregate.cold12MpP95Ms <= 20_000, "COLD_12MP_P95");
  check(failures, aggregate.firstNativePhaseP95Ms <= 8000, "FIRST_NATIVE_PHASE_P95");
  check(failures, aggregate.inputDeletionP99Ms <= 60_000, "INPUT_DELETION_P99");
  check(failures, aggregate.acknowledgedResultDeletionP99Ms <= 10_000, "ACK_RESULT_DELETION_P99");
  check(
    failures,
    aggregate.sweeperResultDeletionP99Ms <= 35 * 60_000,
    "SWEEPER_RESULT_DELETION_P99",
  );
  check(
    failures,
    Number.isSafeInteger(thresholds.maxCostPer1000JobsMicrousd) &&
      aggregate.costPer1000JobsMicrousd <= thresholds.maxCostPer1000JobsMicrousd,
    "COST_PER_1000",
  );

  if (!Array.isArray(report.strata) || report.strata.length === 0) {
    failures.push("MISSING_STRATA");
  } else {
    for (const stratum of report.strata) {
      if (!stratum || stratum.successfulSamples < 3 || stratum.passed !== true) {
        failures.push(`STRATUM:${stratum?.id ?? "unknown"}`);
      }
    }
  }

  const strategic = Array.isArray(report.strategic) ? report.strategic : [];
  for (const tag of strategicTags) {
    const group = strategic.find((entry) => entry?.tag === tag);
    if (!group) failures.push(`STRATEGIC_MISSING:${tag}`);
    else {
      if (group.authorizedSamples < 3) failures.push(`STRATEGIC_SAMPLE_COUNT:${tag}`);
      if (group.medianBaselineRatio > 0.95) failures.push(`STRATEGIC_ADVANTAGE:${tag}`);
      if (group.medianBaselineRatio > 1.05) failures.push(`STRATEGIC_REGRESSION:${tag}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

const allowedLicenses = new Set(["HereIsIt-Owned-1.0", "CC0-1.0"]);
const formats = new Set(["jpeg", "png", "webp"]);
const contentClasses = new Set([
  "photo",
  "portrait",
  "night-noisy",
  "screenshot-text",
  "ui",
  "code",
  "logo",
  "illustration",
  "gradient",
  "flat-graphic",
  "malformed",
  "truncated",
  "bomb-regression",
]);

export function validateCorpusManifest(rawManifest) {
  const manifest = assertObject(rawManifest, "corpus manifest");
  assertExactKeys(manifest, ["version", "entries", "requiredStrata"], "corpus manifest");
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length < 24) {
    throw new TypeError("corpus manifest must contain at least 24 entries");
  }
  const ids = new Set();
  const paths = new Set();
  const tagCounts = Object.fromEntries(strategicTags.map((tag) => [tag, 0]));
  for (const entry of manifest.entries) {
    const value = assertObject(entry, "corpus entry");
    assertExactKeys(
      value,
      ["id", "relativePath", "sha256", "provenance", "expected", "strategicTags", "assertions"],
      `corpus entry ${value.id ?? "unknown"}`,
    );
    if (
      typeof value.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value.id) ||
      ids.has(value.id)
    )
      throw new TypeError("corpus entry IDs must be unique and canonical");
    ids.add(value.id);
    if (
      typeof value.relativePath !== "string" ||
      !/^public\/[a-z0-9][a-z0-9./-]+$/.test(value.relativePath) ||
      value.relativePath.includes("..") ||
      paths.has(value.relativePath)
    )
      throw new TypeError("corpus paths must be unique public relative paths");
    paths.add(value.relativePath);
    assertSha256(value.sha256, `${value.id}.sha256`);
    const provenance = assertObject(value.provenance, `${value.id}.provenance`);
    assertExactKeys(provenance, ["owner", "license", "sourceUrl"], `${value.id}.provenance`);
    if (
      provenance.owner !== "HereIsIt" ||
      !allowedLicenses.has(provenance.license) ||
      provenance.sourceUrl !== null
    )
      throw new TypeError(`${value.id} must be an owned permitted fixture`);
    const expected = assertObject(value.expected, `${value.id}.expected`);
    assertExactKeys(
      expected,
      [
        "format",
        "width",
        "height",
        "bitDepth",
        "alpha",
        "orientation",
        "profile",
        "animated",
        "class",
      ],
      `${value.id}.expected`,
    );
    if (!formats.has(expected.format) || !contentClasses.has(expected.class))
      throw new TypeError(`${value.id} expected format or class is invalid`);
    if (
      ![8, 16].includes(expected.bitDepth) ||
      ![1, 2, 3, 4, 5, 6, 7, 8].includes(expected.orientation)
    )
      throw new TypeError(`${value.id} expected metadata is invalid`);
    if (
      !Array.isArray(value.strategicTags) ||
      !Array.isArray(value.assertions) ||
      value.assertions.length === 0
    )
      throw new TypeError(`${value.id} assertions are required`);
    for (const tag of value.strategicTags) {
      if (!Object.hasOwn(tagCounts, tag))
        throw new TypeError(`${value.id} has an unknown strategic tag`);
      tagCounts[tag] += 1;
    }
  }
  for (const [tag, count] of Object.entries(tagCounts))
    if (count < 3) throw new TypeError(`strategic tag ${tag} requires at least three fixtures`);
  if (!Array.isArray(manifest.requiredStrata) || manifest.requiredStrata.length === 0)
    throw new TypeError("requiredStrata are required");
  return manifest;
}

export async function verifyCorpusFiles(manifest, corpusRoot) {
  validateCorpusManifest(manifest);
  const adversarial = new Set(["malformed", "truncated", "bomb-regression"]);
  for (const entry of manifest.entries) {
    const bytes = await readFile(resolve(corpusRoot, entry.relativePath));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) throw new TypeError(`corpus hash mismatch for ${entry.id}`);
    if (bytes.byteLength > 30 * 1024 * 1024)
      throw new TypeError(`corpus file exceeds 30 MiB for ${entry.id}`);
    if (adversarial.has(entry.expected.class)) continue;
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    }).metadata();
    const animated = (metadata.pages ?? 1) > 1;
    if (
      metadata.format !== entry.expected.format ||
      metadata.width !== entry.expected.width ||
      metadata.height !== entry.expected.height ||
      (metadata.orientation ?? 1) !== entry.expected.orientation ||
      Boolean(metadata.hasAlpha) !== entry.expected.alpha ||
      animated !== entry.expected.animated
    ) {
      throw new TypeError(`corpus decoded metadata mismatch for ${entry.id}`);
    }
    const bitDepth = metadata.bitsPerSample ?? (metadata.depth === "ushort" ? 16 : 8);
    if (bitDepth !== entry.expected.bitDepth)
      throw new TypeError(`corpus bit depth mismatch for ${entry.id}`);
    if (entry.expected.profile === "wide-gamut" && metadata.hasProfile !== true)
      throw new TypeError(`wide-gamut profile missing for ${entry.id}`);
  }
  return manifest;
}

export function verifyBenchmarkRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("benchmark records must be an array");
  for (const record of records) {
    const effective =
      record.outcome === "download"
        ? record.outputBytes
        : record.outcome === "original-retained"
          ? record.inputBytes
          : null;
    if (record.effectiveDeliveredBytes !== effective)
      throw new TypeError(`invalid effectiveDeliveredBytes for ${record.corpusId ?? "unknown"}`);
    if (record.outcome === "download" && record.outputBytes >= record.inputBytes)
      throw new TypeError(`larger output selected for ${record.corpusId ?? "unknown"}`);
  }
  return records;
}

export function evaluatePrImageQualityReport(rawReport) {
  const report = assertObject(rawReport, "PR benchmark report");
  if (report.scope !== "pr") throw new TypeError("PR report scope is required");
  return evaluateMeasuredImageQualityReport(report);
}

function evaluateMeasuredImageQualityReport(report) {
  const identity = assertObject(report.identity, "PR benchmark identity");
  if (
    typeof identity.engineImageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.engineImageDigest)
  )
    throw new TypeError("immutable engine image digest is required");
  assertSha256(identity.sourceLockSha256, "sourceLockSha256");
  assertSha256(identity.corpusManifestSha256, "corpusManifestSha256");
  assertSha256(identity.liveCostModelSha256, "liveCostModelSha256");
  const records = verifyBenchmarkRecords(report.records);
  const formats = new Set(records.map((record) => record.inputMime));
  const failures = [];
  if (records.length < 12) failures.push("PR_SAMPLE_COUNT");
  for (const mime of ["image/jpeg", "image/png", "image/webp"])
    if (!formats.has(mime)) failures.push(`PR_FORMAT:${mime}`);
  if (records.filter((record) => record.outcome !== "rejected").length / records.length < 0.9)
    failures.push("PR_SUCCESS_RATE");
  if (records.some((record) => !record.alphaChecksPassed && record.outcome !== "rejected"))
    failures.push("PR_ALPHA_CHECK");
  const successful = records.filter((record) => record.outcome !== "rejected");
  const validMeasurements = successful.every(
    (record) =>
      Number.isFinite(record.processingMs) &&
      record.processingMs >= 0 &&
      Number.isFinite(record.peakMemoryBytes) &&
      record.peakMemoryBytes > 0,
  );
  if (!validMeasurements) failures.push("PR_INVALID_MEASUREMENT");
  else {
    const jpegWebp = successful.filter(
      (record) => record.inputMime === "image/jpeg" || record.inputMime === "image/webp",
    );
    const png = successful.filter((record) => record.inputMime === "image/png");
    if (percentile95(jpegWebp.map((record) => record.processingMs)) > warmJpegWebpP95LimitMs) {
      failures.push("PR_WARM_JPEG_WEBP_P95");
    }
    if (percentile95(png.map((record) => record.processingMs)) > standardPngP95LimitMs) {
      failures.push("PR_STANDARD_PNG_P95");
    }
    if (
      Math.max(...successful.map((record) => record.peakMemoryBytes)) > ordinaryPeakMemoryLimitBytes
    )
      failures.push("PR_PEAK_MEMORY");
  }
  return { passed: failures.length === 0, failures };
}

// Native CI quality is distinct from the optional competitor comparison and the later
// live admission checks. Never turn local timing/cost estimates into provider receipts.
export function evaluateNativeImageReleaseReport(rawReport, manifest, manifestSha256) {
  const report = assertObject(rawReport, "native release benchmark");
  if (report.version !== 1 || report.scope !== "release")
    throw new TypeError("full native release benchmark is required");
  validateCorpusManifest(manifest);
  assertSha256(manifestSha256, "manifest hash");
  if (report.identity?.corpusManifestSha256 !== manifestSha256)
    throw new TypeError("native benchmark does not bind the corpus");
  const metricBuild = "libjxl-0.11.2-332feb17";
  if (
    report.identity.metricBuildIds?.ssimulacra2 !== metricBuild ||
    report.identity.metricBuildIds?.butteraugli !== metricBuild
  )
    throw new TypeError("native benchmark metric builds differ");
  const entries = manifest.entries.filter(
    (entry) => !["malformed", "truncated", "bomb-regression"].includes(entry.expected.class),
  );
  const variants = ["smart:balanced", "smart:smallest", "lossless:balanced"];
  const expected = new Map(
    entries.flatMap((entry) => variants.map((variant) => [`${entry.id}:${variant}`, entry])),
  );
  const seen = new Set();
  const records = verifyBenchmarkRecords(report.records);
  for (const record of records) {
    const key = `${record.corpusId}:${record.mode}:${record.preset}`;
    const entry = expected.get(key);
    if (!entry || seen.has(key) || record.inputMime !== `image/${entry.expected.format}`)
      throw new TypeError("native benchmark has duplicate or foreign profiles");
    seen.add(key);
  }
  if (seen.size !== expected.size) throw new TypeError("native benchmark profiles are missing");
  // These committed fixtures deliberately exercise unsupported JPEG color interpretations.
  // They must reject safely, not lower the supported-file success requirement.
  const unsupportedLossless = new Set([
    "photo-wide-gamut-jpeg",
    "photo-cmyk-jpeg",
    "photo-cmyk-profile-jpeg",
    "photo-ycck-jpeg",
  ]);
  const unsupported = (record) =>
    record.corpusId === "photo-conflicting-adobe-jpeg" ||
    (record.mode === "lossless" && unsupportedLossless.has(record.corpusId));
  const supported = records.filter((record) => !unsupported(record));
  const failures = evaluateMeasuredImageQualityReport({ ...report, records: supported }).failures;
  for (const record of records) {
    if (unsupported(record)) {
      if (record.outcome !== "rejected" || record.errorCode !== "UNSUPPORTED_INPUT")
        failures.push("UNSAFE_UNSUPPORTED_INPUT");
    } else if (record.outcome !== "rejected") {
      if (
        !["download", "original-retained"].includes(record.outcome) ||
        record.qualityChecksPassed !== true ||
        record.alphaChecksPassed !== true
      )
        failures.push("NATIVE_OUTPUT_VERIFICATION");
      if (record.outcome === "download") {
        if (
          !Number.isFinite(record.ssimulacra2) ||
          !Number.isFinite(record.butteraugli) ||
          record.butteraugli < 0
        )
          failures.push("UNMEASURED_VISUAL_QUALITY");
        if (
          record.mode === "lossless" &&
          (record.inputMime === "image/jpeg"
            ? record.losslessVerification !== "jpeg-coefficient-exact"
            : record.losslessVerification !== "pixel-exact" || record.normalizedPixelMatch !== true)
        )
          failures.push("LOSSLESS_VERIFICATION_MISMATCH");
      }
    }
    if (
      record.deletionVerified !== true ||
      !Number.isFinite(record.inputDeletionLagMs) ||
      record.inputDeletionLagMs < 0 ||
      record.inputDeletionLagMs > 60_000 ||
      !Number.isFinite(record.resultDeletionLagMs) ||
      record.resultDeletionLagMs < 0 ||
      record.resultDeletionLagMs > 10_000
    )
      failures.push("NATIVE_DELETION");
  }
  if (supported.filter((record) => record.outcome !== "rejected").length / supported.length < 0.99)
    failures.push("SUPPORTED_SUCCESS_RATE");
  // The ordinary JPEG is the reproduced false-original-retained regression fixture.
  // Already optimized and other legitimately incompressible files are not failures.
  const regressions = supported.filter(
    (record) => record.corpusId === "photo-ordinary-jpeg" && record.mode === "smart",
  );
  if (
    regressions.length !== 2 ||
    regressions.filter(
      (record) =>
        record.outcome === "download" &&
        record.qualityChecksPassed === true &&
        record.effectiveDeliveredBytes <= record.inputBytes * 0.95,
    ).length /
      regressions.length <
      0.9
  )
    failures.push("FALSE_NO_SIZE_REDUCTION");
  for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
    if (
      !supported.some(
        (record) =>
          record.inputMime === mime &&
          record.mode === "smart" &&
          record.preset === "balanced" &&
          record.outcome === "download",
      )
    )
      failures.push(`NO_COMPRESSED_OUTPUT:${mime}`);
  }
  return {
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    profilesMeasured: records.length,
    visualProfilesMeasured: supported.filter((record) => record.outcome === "download").length,
  };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (
    !args.report ||
    !args.scope ||
    Object.keys(args).length !== (args.scope === "native-release" ? 3 : 2) ||
    !["pr", "release", "native-release"].includes(args.scope) ||
    (args.scope === "native-release" && !args.manifest)
  ) {
    throw new TypeError(
      "usage: verify-image-quality --report <json> --scope <pr|release|native-release> [--manifest <json>]",
    );
  }
  const report = JSON.parse(await readFile(args.report, "utf8"));
  const manifestBytes = args.scope === "native-release" ? await readFile(args.manifest) : null;
  const result = manifestBytes
    ? evaluateNativeImageReleaseReport(
        report,
        JSON.parse(manifestBytes),
        createHash("sha256").update(manifestBytes).digest("hex"),
      )
    : args.scope === "pr"
      ? evaluatePrImageQualityReport(report)
      : evaluateImageQualityReport(report);
  process.stdout.write(`${JSON.stringify({ ...result, reportSha256: sha256Canonical(report) })}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
