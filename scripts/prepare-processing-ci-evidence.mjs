import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePdfBenchmarkReport } from "./benchmark-pdf-engine.mjs";
import { validatePdfVisualBrowserEvidence } from "./create-pdf-visual-browser-evidence.mjs";
import { writeProcessingEvidenceBundle } from "./create-processing-evidence-bundle.mjs";
import { validateHostedReviewDocument } from "./create-processing-hosted-check.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";

const reportNames = [
  "fullCorpusBenchmark",
  "competitorComparison",
  "blindedHumanReview",
  "commercialReview",
  "privacyReview",
  "deviceMatrix",
];

export function validateHostedReviewReceipt(value, { name, gitSha, sourceSha256 }) {
  const receipt = assertObject(value, `${name} hosted review receipt`);
  assertExactKeys(
    receipt,
    [
      "schema",
      "version",
      "reportName",
      "passed",
      "gitSha",
      "sourceSha256",
      "checkRunId",
      "document",
    ],
    `${name} hosted review receipt`,
  );
  assertSha256(receipt.sourceSha256, `${name} hosted source hash`);
  if (
    receipt.schema !== "hereisit-processing-hosted-review@1" ||
    receipt.version !== 1 ||
    receipt.reportName !== name ||
    receipt.passed !== true ||
    receipt.gitSha !== gitSha ||
    receipt.sourceSha256 !== sourceSha256 ||
    !Number.isSafeInteger(receipt.checkRunId) ||
    receipt.checkRunId < 1
  )
    throw new TypeError(`${name} hosted review is not an exact passed source receipt`);
  return validateHostedReviewDocument(receipt.document, {
    name,
    gitSha,
    sourceSha256,
    checkRunId: receipt.checkRunId,
  });
}

export function validateHostedPdfCandidateBinding(
  reports,
  candidate,
  rawVisual,
  benchmark,
  pdfLicenseGateSha256,
) {
  const corpus = reports.fullCorpusBenchmark;
  const device = reports.deviceMatrix;
  const visualReview = reports.blindedHumanReview;
  const privacy = reports.privacyReview;
  const visual = validatePdfVisualBrowserEvidence(rawVisual);
  const visualSha256 = sha256Bytes(canonicalJson(visual));
  if (
    corpus.benchmarkSha256 !== candidate.pdfQuality.benchmarkSha256 ||
    corpus.releaseGateSha256 !== candidate.pdfQuality.releaseGateSha256 ||
    corpus.profilesMeasured !== candidate.pdfQuality.visualProfilesMeasured ||
    corpus.engineImageDigest !== candidate.pdfEngine.oci.configDigest ||
    device.pdfVisualProfilesMeasured !== corpus.profilesMeasured * 3 ||
    device.pdfVisualEvidenceSha256 !== visualSha256 ||
    visualReview.visualProfilesMeasured !== device.pdfVisualProfilesMeasured ||
    visualReview.pdfVisualEvidenceSha256 !== visualSha256 ||
    privacy.testsRun !== 6 ||
    privacy.pdfVisualEvidenceSha256 !== visualSha256 ||
    reports.competitorComparison.casesCompared !== benchmark.records.length ||
    reports.competitorComparison.baselineSha256 !== corpus.benchmarkSha256 ||
    reports.commercialReview.licenseGateSha256 !== pdfLicenseGateSha256 ||
    visual.gitSha !== candidate.gitSha ||
    visual.gitSha !== corpus.gitSha ||
    visual.sourceSha256 !== corpus.sourceSha256 ||
    visual.checkRunId !== corpus.checkRunId ||
    visual.engineImageDigest !== corpus.engineImageDigest ||
    visual.corpusManifestSha256 !== corpus.corpusSha256 ||
    visual.visualProfilesMeasured !== device.pdfVisualProfilesMeasured ||
    sha256Bytes(canonicalJson(benchmark)) !== candidate.pdfQuality.benchmarkSha256 ||
    benchmark.identity.engineImageDigest !== corpus.engineImageDigest ||
    benchmark.identity.corpusManifestSha256 !== corpus.corpusSha256
  )
    throw new TypeError("hosted PDF quality evidence does not match the exact candidate");
  return reports;
}

export async function prepareProcessingCiEvidence({
  candidatePath,
  releaseId,
  gitSha,
  output,
  hostedCheckRoot,
  sourceSha256,
  now = new Date(),
}) {
  if (typeof hostedCheckRoot !== "string" || hostedCheckRoot.length < 1)
    throw new TypeError("exact hosted review evidence is required");
  assertSha256(sourceSha256, "hosted review source hash");
  const candidate = validateProcessingCandidate(
    JSON.parse(await readFile(resolve(candidatePath), "utf8")),
  );
  if (
    candidate.schema !== "hereisit-processing-candidate@2" ||
    candidate.releaseId !== releaseId ||
    candidate.gitSha !== gitSha
  )
    throw new TypeError("candidate is not exact current @2 release");
  const reports = Object.fromEntries(
    await Promise.all(
      reportNames.map(async (name) => {
        let receipt;
        try {
          receipt = JSON.parse(
            await readFile(join(resolve(hostedCheckRoot), `${name}.json`), "utf8"),
          );
        } catch {
          throw new TypeError(`${name} exact hosted review evidence is missing or invalid`);
        }
        return [name, validateHostedReviewReceipt(receipt, { name, gitSha, sourceSha256 })];
      }),
    ),
  );
  let visual;
  let benchmark;
  let pdfLicenseGateSha256;
  try {
    const visualBytes = await readBoundedRegularFile(
      join(resolve(hostedCheckRoot), "pdfVisualBrowserEvidence.json"),
      1024 * 1024,
      "hosted PDF browser visual evidence",
    );
    visual = JSON.parse(visualBytes.toString("utf8"));
    const benchmarkAsset = candidate.releaseAssets.pdfQuality.benchmark;
    const benchmarkBytes = await readBoundedRegularFile(
      join(dirname(resolve(candidatePath)), benchmarkAsset.path),
      16 * 1024 * 1024,
      "candidate PDF benchmark evidence",
    );
    if (
      benchmarkBytes.byteLength !== benchmarkAsset.sizeBytes ||
      benchmarkBytes.byteLength > 16 * 1024 * 1024 ||
      sha256Bytes(benchmarkBytes) !== benchmarkAsset.sha256
    ) {
      throw new TypeError("candidate PDF benchmark asset identity is invalid");
    }
    benchmark = validatePdfBenchmarkReport(JSON.parse(benchmarkBytes.toString("utf8")));
    const licenseAsset = candidate.releaseAssets.security.gates.pdfEngine;
    const licenseBytes = await readBoundedRegularFile(
      join(dirname(resolve(candidatePath)), licenseAsset.path),
      256 * 1024,
      "candidate PDF license gate",
    );
    pdfLicenseGateSha256 = sha256Bytes(licenseBytes);
    if (
      licenseBytes.byteLength !== licenseAsset.sizeBytes ||
      pdfLicenseGateSha256 !== licenseAsset.sha256
    )
      throw new TypeError("candidate PDF license gate identity is invalid");
  } catch {
    throw new TypeError("exact PDF browser and benchmark evidence is missing or invalid");
  }
  validateHostedPdfCandidateBinding(reports, candidate, visual, benchmark, pdfLicenseGateSha256);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + 24 * 60 * 60 * 1000).toISOString();
  await writeProcessingEvidenceBundle({
    output,
    releaseId,
    gitSha,
    candidateVerificationSha256: candidate.verificationSha256,
    createdAt,
    expiresAt,
    reports,
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const a = parseCliArguments(process.argv.slice(2));
  await prepareProcessingCiEvidence({
    candidatePath: a.candidate,
    releaseId: a["release-id"],
    gitSha: a["git-sha"],
    output: a.output,
    hostedCheckRoot: a["hosted-check-root"],
    sourceSha256: a["source-sha256"],
  });
}
