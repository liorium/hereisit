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
  fullCorpusBenchmark: "hereisit-full-corpus-benchmark-review@1",
  competitorComparison: "hereisit-competitor-comparison-review@1",
  blindedHumanReview: "hereisit-blinded-human-review@1",
  commercialReview: "hereisit-commercial-review@1",
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
  blindedHumanReview: ["reviewers", "approval"],
  commercialReview: ["licenseGateSha256", "approval"],
  privacyReview: ["testsRun"],
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

function validateApproval(value, label) {
  const approval = assertObject(value, label);
  assertExactKeys(approval, ["kind", "href", "sha256"], label);
  assertSha256(approval.sha256, `${label} hash`);
  let url;
  try {
    url = new URL(approval.href);
  } catch {
    throw new TypeError(`${label} URL is invalid`);
  }
  if (
    approval.kind !== "approval-reference" ||
    url.protocol !== "https:" ||
    url.hostname !== "approvals.example.test" ||
    !/^\/reviews\/[1-9]\d*$/.test(url.pathname) ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError(`${label} is not a safe exact approval reference`);
  }
}

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
    if (!Number.isSafeInteger(document.reviewers) || document.reviewers < 2)
      throw new TypeError("blinded human review has insufficient reviewers");
    validateApproval(document.approval, "blinded human approval");
  } else if (name === "commercialReview") {
    assertSha256(document.licenseGateSha256, "commercial review license gate hash");
    validateApproval(document.approval, "commercial approval");
  } else if (name === "privacyReview") {
    if (!Number.isSafeInteger(document.testsRun) || document.testsRun < 1)
      throw new TypeError("privacy review did not run tests");
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
  const root = resolve(output);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(
    Object.entries(documents).map(([reportName, document]) =>
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
  );
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
