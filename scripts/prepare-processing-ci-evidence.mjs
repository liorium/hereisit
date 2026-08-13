import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeProcessingEvidenceBundle } from "./create-processing-evidence-bundle.mjs";
import { validateHostedReviewDocument } from "./create-processing-hosted-check.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  parseCliArguments,
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
