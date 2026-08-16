import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePdfBenchmarkReport, validatePdfReleaseGate } from "./benchmark-pdf-engine.mjs";
import { validatePdfVisualBrowserEvidence } from "./create-pdf-visual-browser-evidence.mjs";
import {
  hostedReviewSchemas,
  validateHostedReviewDocument,
} from "./create-processing-hosted-check.mjs";
import {
  assertExactKeys,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const projects = Object.freeze([
  "chromium",
  "firefox",
  "mobile-chromium",
  "mobile-firefox",
  "webkit",
  "mobile-webkit",
]);

async function readJson(path, label) {
  const bytes = await readBoundedRegularFile(resolve(path), 16 * 1024 * 1024, label);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

export async function createPdfVisualHostedReports({
  benchmarkPath,
  gatePath,
  visualEvidencePath,
  licenseGatePath,
  output,
  gitSha,
  sourceSha256,
  checkRunId,
}) {
  assertSha256(sourceSha256, "hosted source hash");
  const runId = typeof checkRunId === "string" ? Number(checkRunId) : checkRunId;
  if (!/^[a-f0-9]{40}$/u.test(gitSha ?? "") || !Number.isSafeInteger(runId) || runId < 1)
    throw new TypeError("hosted execution identity is invalid");

  const benchmarkFile = await readJson(benchmarkPath, "PDF benchmark evidence");
  const gateFile = await readJson(gatePath, "PDF release gate evidence");
  const visualFile = await readJson(visualEvidencePath, "PDF browser visual evidence");
  const licenseFile = await readJson(licenseGatePath, "PDF engine license gate");
  const benchmark = validatePdfBenchmarkReport(benchmarkFile.value);
  const gate = validatePdfReleaseGate(gateFile.value, benchmark);
  const visual = validatePdfVisualBrowserEvidence(visualFile.value);
  const license = licenseFile.value;
  assertExactKeys(
    license,
    [
      "schema",
      "passed",
      "qpdfVersion",
      "sourceSha256",
      "sourceLockSha256",
      "policySha256",
      "licenseSha256",
      "noticeSha256",
    ],
    "PDF engine license gate",
  );
  if (
    license.schema !== "hereisit-pdf-engine-license-gate@1" ||
    license.passed !== true ||
    license.qpdfVersion !== "12.4.0"
  )
    throw new TypeError("PDF engine license gate did not pass");
  for (const key of [
    "sourceSha256",
    "sourceLockSha256",
    "policySha256",
    "licenseSha256",
    "noticeSha256",
  ])
    assertSha256(license[key], `PDF engine license gate ${key}`);
  const visualBytes = Buffer.from(canonicalJson(visual));
  if (
    !gate.publicAdmissionReady ||
    gate.visualProfilesMeasured !== 3 ||
    visual.gitSha !== gitSha ||
    visual.sourceSha256 !== sourceSha256 ||
    visual.checkRunId !== runId ||
    visual.engineImageDigest !== gate.engineImageDigest ||
    visual.corpusManifestSha256 !== gate.corpusManifestSha256 ||
    visual.visualProfilesMeasured !== gate.visualProfilesMeasured * 3
  )
    throw new TypeError("PDF browser evidence does not match the exact public benchmark identity");

  const common = {
    version: 1,
    passed: true,
    gitSha,
    sourceSha256,
    checkRunId: runId,
    execution: "exact-main-hosted-check",
  };
  const documents = {
    fullCorpusBenchmark: {
      schema: hostedReviewSchemas.fullCorpusBenchmark,
      ...common,
      profilesMeasured: gate.visualProfilesMeasured,
      corpusSha256: gate.corpusManifestSha256,
      benchmarkSha256: gate.benchmarkSha256,
      releaseGateSha256: sha256Bytes(canonicalJson(gate)),
      engineImageDigest: gate.engineImageDigest,
    },
    competitorComparison: {
      schema: hostedReviewSchemas.competitorComparison,
      ...common,
      casesCompared: benchmark.records.length,
      baselineSha256: gate.benchmarkSha256,
    },
    blindedHumanReview: {
      schema: hostedReviewSchemas.blindedHumanReview,
      ...common,
      visualProfilesMeasured: visual.visualProfilesMeasured,
      pdfVisualEvidenceSha256: sha256Bytes(visualBytes),
    },
    commercialReview: {
      schema: hostedReviewSchemas.commercialReview,
      ...common,
      licenseGateSha256: sha256Bytes(licenseFile.bytes),
    },
    privacyReview: {
      schema: hostedReviewSchemas.privacyReview,
      ...common,
      testsRun: projects.length,
      pdfVisualEvidenceSha256: sha256Bytes(visualBytes),
    },
    deviceMatrix: {
      schema: hostedReviewSchemas.deviceMatrix,
      ...common,
      projects,
      productAnalytics: true,
      pdfVisualEvidenceSha256: sha256Bytes(visualBytes),
      pdfVisualProfilesMeasured: visual.visualProfilesMeasured,
    },
  };
  const root = resolve(output);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [name, document] of Object.entries(documents)) {
    validateHostedReviewDocument(document, { name, gitSha, sourceSha256, checkRunId: runId });
    await writeCanonicalJsonAtomic(join(root, `${name}.json`), document, {
      refuseOverwrite: true,
      mode: 0o600,
    });
  }
  await writeCanonicalJsonAtomic(join(root, "pdfVisualBrowserEvidence.json"), visual, {
    refuseOverwrite: true,
    mode: 0o600,
  });
  return documents;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = parseCliArguments(process.argv.slice(2));
  assertExactKeys(
    args,
    [
      "benchmark",
      "gate",
      "visual-evidence",
      "license-gate",
      "output",
      "git-sha",
      "source-sha256",
      "check-run-id",
    ],
    "PDF visual hosted report CLI arguments",
  );
  const documents = await createPdfVisualHostedReports({
    benchmarkPath: args.benchmark,
    gatePath: args.gate,
    visualEvidencePath: args["visual-evidence"],
    licenseGatePath: args["license-gate"],
    output: args.output,
    gitSha: args["git-sha"],
    sourceSha256: args["source-sha256"],
    checkRunId: args["check-run-id"],
  });
  process.stdout.write(`${canonicalJson({ ok: true, reports: Object.keys(documents) })}\n`);
}
