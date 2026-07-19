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

function check(failures, passed, code) {
  if (!passed) failures.push(code);
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
  check(failures, aggregate.warmJpegWebpP95Ms <= 3000, "WARM_JPEG_WEBP_P95");
  check(failures, aggregate.standardPngP95Ms <= 8000, "STANDARD_PNG_P95");
  check(failures, aggregate.ordinaryPeakMemoryBytes <= 512 * 1024 * 1024, "PEAK_MEMORY");
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

  const human = assertObject(aggregate.humanReview, "human review aggregate");
  check(failures, human.count >= 20, "HUMAN_REVIEW_COUNT");
  check(failures, human.severeDefects === 0, "HUMAN_REVIEW_SEVERE_DEFECT");
  check(failures, human.hereisitOrTieRate >= 0.8, "HUMAN_REVIEW_ACCEPTANCE");
  check(failures, human.hereisit >= human.baseline, "HUMAN_REVIEW_PREFERENCE");

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
      if (group.humanReviewedSamples < 1) failures.push(`STRATEGIC_HUMAN_REVIEW:${tag}`);
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
  return { passed: failures.length === 0, failures };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (
    !args.report ||
    !args.scope ||
    Object.keys(args).length !== 2 ||
    !["pr", "release"].includes(args.scope)
  ) {
    throw new TypeError("usage: verify-image-quality --report <json> --scope <pr|release>");
  }
  const report = JSON.parse(await readFile(args.report, "utf8"));
  const result =
    args.scope === "pr" ? evaluatePrImageQualityReport(report) : evaluateImageQualityReport(report);
  process.stdout.write(`${JSON.stringify({ ...result, reportSha256: sha256Canonical(report) })}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
