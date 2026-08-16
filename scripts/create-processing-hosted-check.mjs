import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePdfVisualBrowserEvidence } from "./create-pdf-visual-browser-evidence.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalize,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const gitShaPattern = /^[a-f0-9]{40}$/;

export const hostedReviewSchemas = Object.freeze({
  fullCorpusBenchmark: "hereisit-full-corpus-benchmark-review@1",
  competitorComparison: "hereisit-competitor-comparison-review@1",
  blindedHumanReview: "hereisit-automated-visual-review@1",
  commercialReview: "hereisit-commercial-license-review@1",
  privacyReview: "hereisit-privacy-review@1",
  deviceMatrix: "hereisit-device-matrix-review@1",
});

const detailKeys = Object.freeze({
  fullCorpusBenchmark: [
    "profilesMeasured",
    "corpusSha256",
    "benchmarkSha256",
    "releaseGateSha256",
    "engineImageDigest",
  ],
  competitorComparison: ["casesCompared", "baselineSha256"],
  blindedHumanReview: ["visualProfilesMeasured", "pdfVisualEvidenceSha256"],
  commercialReview: ["licenseGateSha256"],
  privacyReview: ["testsRun", "pdfVisualEvidenceSha256"],
  deviceMatrix: [
    "projects",
    "productAnalytics",
    "pdfVisualEvidenceSha256",
    "pdfVisualProfilesMeasured",
  ],
});

const browserProjects = Object.freeze([
  "chromium",
  "firefox",
  "mobile-chromium",
  "mobile-firefox",
  "webkit",
  "mobile-webkit",
]);

export function validateHostedReviewDocument(value, { name, gitSha, sourceSha256, checkRunId }) {
  const document = assertObject(value, `${name} hosted review document`);
  const commonKeys = [
    "schema",
    "version",
    "passed",
    "gitSha",
    "sourceSha256",
    "checkRunId",
    "execution",
  ];
  assertExactKeys(document, [...commonKeys, ...detailKeys[name]], `${name} hosted review document`);
  if (
    document.schema !== hostedReviewSchemas[name] ||
    document.version !== 1 ||
    document.passed !== true ||
    document.gitSha !== gitSha ||
    document.sourceSha256 !== sourceSha256 ||
    document.checkRunId !== checkRunId ||
    document.execution !== "exact-main-hosted-check"
  ) {
    throw new TypeError(`${name} hosted review document does not bind the exact source identity`);
  }
  if (name === "fullCorpusBenchmark") {
    if (!Number.isSafeInteger(document.profilesMeasured) || document.profilesMeasured < 1)
      throw new TypeError("full corpus benchmark did not measure profiles");
    assertSha256(document.corpusSha256, "full corpus benchmark corpus hash");
    assertSha256(document.benchmarkSha256, "full corpus benchmark hash");
    assertSha256(document.releaseGateSha256, "full corpus release gate hash");
    if (!/^sha256:[a-f0-9]{64}$/u.test(document.engineImageDigest))
      throw new TypeError("full corpus benchmark engine digest is invalid");
  } else if (name === "competitorComparison") {
    if (!Number.isSafeInteger(document.casesCompared) || document.casesCompared < 1)
      throw new TypeError("competitor comparison did not compare cases");
    assertSha256(document.baselineSha256, "competitor comparison baseline hash");
  } else if (name === "blindedHumanReview") {
    if (
      !Number.isSafeInteger(document.visualProfilesMeasured) ||
      document.visualProfilesMeasured < 1
    )
      throw new TypeError("automated visual review did not measure profiles");
    assertSha256(document.pdfVisualEvidenceSha256, "automated visual review evidence hash");
  } else if (name === "commercialReview") {
    assertSha256(document.licenseGateSha256, "commercial review license gate hash");
  } else if (name === "privacyReview") {
    if (!Number.isSafeInteger(document.testsRun) || document.testsRun < 1)
      throw new TypeError("privacy review did not run tests");
    assertSha256(document.pdfVisualEvidenceSha256, "privacy review evidence hash");
  } else if (name === "deviceMatrix") {
    if (
      document.productAnalytics !== true ||
      !Array.isArray(document.projects) ||
      document.projects.length !== browserProjects.length ||
      document.projects.some((project, index) => project !== browserProjects[index])
    )
      throw new TypeError("device matrix is incomplete");
    assertSha256(document.pdfVisualEvidenceSha256, "device matrix PDF visual evidence hash");
    if (document.pdfVisualProfilesMeasured !== 9)
      throw new TypeError("device matrix PDF visual coverage is incomplete");
  } else {
    throw new TypeError("hosted review name is invalid");
  }
  return document;
}

export async function createProcessingHostedCheck({ source, input, output, gitSha, checkRunId }) {
  if (!gitShaPattern.test(gitSha ?? "")) throw new TypeError("hosted check Git SHA is invalid");
  const parsedRunId = typeof checkRunId === "string" ? Number(checkRunId) : checkRunId;
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1)
    throw new TypeError("hosted check run ID is invalid");
  const bytes = await readBoundedRegularFile(
    resolve(source),
    256 * 1024 * 1024,
    "exact hosted source archive",
  );
  const sourceSha256 = assertSha256(sha256Bytes(bytes), "exact hosted source hash");
  const documents = {};
  for (const name of Object.keys(hostedReviewSchemas)) {
    let document;
    try {
      const reportBytes = await readBoundedRegularFile(
        join(resolve(input), `${name}.json`),
        1024 * 1024,
        `${name} hosted review`,
      );
      document = JSON.parse(reportBytes.toString("utf8"));
    } catch {
      throw new TypeError(`${name} hosted review is missing or invalid`);
    }
    documents[name] = validateHostedReviewDocument(document, {
      name,
      gitSha,
      sourceSha256,
      checkRunId: parsedRunId,
    });
  }
  let visual;
  try {
    const visualBytes = await readBoundedRegularFile(
      join(resolve(input), "pdfVisualBrowserEvidence.json"),
      1024 * 1024,
      "PDF browser visual evidence",
    );
    visual = validatePdfVisualBrowserEvidence(JSON.parse(visualBytes.toString("utf8")));
  } catch {
    throw new TypeError("PDF browser visual evidence is missing or invalid");
  }
  if (
    visual.gitSha !== gitSha ||
    visual.sourceSha256 !== sourceSha256 ||
    visual.checkRunId !== parsedRunId ||
    visual.engineImageDigest !== documents.fullCorpusBenchmark.engineImageDigest ||
    visual.corpusManifestSha256 !== documents.fullCorpusBenchmark.corpusSha256 ||
    visual.visualProfilesMeasured !== documents.deviceMatrix.pdfVisualProfilesMeasured ||
    visual.visualProfilesMeasured !== documents.blindedHumanReview.visualProfilesMeasured ||
    documents.deviceMatrix.pdfVisualEvidenceSha256 !== sha256Bytes(canonicalJson(visual)) ||
    documents.blindedHumanReview.pdfVisualEvidenceSha256 !== sha256Bytes(canonicalJson(visual)) ||
    documents.privacyReview.pdfVisualEvidenceSha256 !== sha256Bytes(canonicalJson(visual)) ||
    documents.competitorComparison.baselineSha256 !== documents.fullCorpusBenchmark.benchmarkSha256
  ) {
    throw new TypeError("PDF browser visual evidence does not bind the exact hosted reviews");
  }
  const root = resolve(output);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all([
    ...Object.entries(documents).map(([reportName, document]) =>
      writeCanonicalJsonAtomic(
        join(root, `${reportName}.json`),
        canonicalize({
          schema: "hereisit-processing-hosted-review@1",
          version: 1,
          reportName,
          passed: true,
          gitSha,
          sourceSha256,
          checkRunId: parsedRunId,
          document,
        }),
        { refuseOverwrite: true, mode: 0o600 },
      ),
    ),
    writeCanonicalJsonAtomic(join(root, "pdfVisualBrowserEvidence.json"), visual, {
      refuseOverwrite: true,
      mode: 0o600,
    }),
  ]);
  return { sourceSha256, checkRunId: parsedRunId };
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = parseCliArguments(process.argv.slice(2));
  await createProcessingHostedCheck({
    source: args.source,
    input: args.input,
    output: args.output,
    gitSha: args["git-sha"],
    checkRunId: args["check-run-id"],
  });
}
