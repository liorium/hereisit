import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalize,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const gitShaPattern = /^[a-f0-9]{40}$/;

export const hostedReviewSchemas = Object.freeze({
  fullCorpusBenchmark: "hereisit-full-corpus-benchmark-review@2",
  competitorComparison: "hereisit-competitor-comparison-review@2",
  blindedHumanReview: "hereisit-automated-visual-review@2",
  commercialReview: "hereisit-commercial-license-review@2",
  privacyReview: "hereisit-privacy-review@2",
  deviceMatrix: "hereisit-device-matrix-review@2",
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
  blindedHumanReview: ["visualProfilesMeasured", "evidenceSha256"],
  commercialReview: ["licenseGateSha256"],
  privacyReview: ["testsRun", "evidenceSha256"],
  deviceMatrix: ["projects", "productAnalytics", "evidenceSha256", "visualProfilesMeasured"],
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
    document.version !== 2 ||
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
    assertSha256(document.evidenceSha256, "automated visual review evidence hash");
  } else if (name === "commercialReview") {
    assertSha256(document.licenseGateSha256, "commercial review license gate hash");
  } else if (name === "privacyReview") {
    if (!Number.isSafeInteger(document.testsRun) || document.testsRun < 1)
      throw new TypeError("privacy review did not run tests");
    assertSha256(document.evidenceSha256, "privacy review evidence hash");
  } else if (name === "deviceMatrix") {
    if (
      document.productAnalytics !== true ||
      !Array.isArray(document.projects) ||
      document.projects.length !== browserProjects.length ||
      document.projects.some((project, index) => project !== browserProjects[index])
    )
      throw new TypeError("device matrix is incomplete");
    assertSha256(document.evidenceSha256, "device matrix visual evidence hash");
    if (
      !Number.isSafeInteger(document.visualProfilesMeasured) ||
      document.visualProfilesMeasured < 1
    )
      throw new TypeError("device matrix visual coverage is incomplete");
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
