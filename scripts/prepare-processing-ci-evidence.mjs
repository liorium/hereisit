import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeProcessingEvidenceBundle } from "./create-processing-evidence-bundle.mjs";
import { parseCliArguments } from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";

export async function prepareProcessingCiEvidence({
  candidatePath,
  releaseId,
  gitSha,
  output,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: protected CI-only evidence is never cache input
  serializedReports = process.env.PROCESSING_REVIEW_EVIDENCE_JSON,
  now = new Date(),
}) {
  if (
    typeof serializedReports !== "string" ||
    serializedReports.length < 2 ||
    serializedReports.length > 6 * 1024 * 1024
  )
    throw new TypeError("protected reviewed release evidence is required");
  const candidate = validateProcessingCandidate(
    JSON.parse(await readFile(resolve(candidatePath), "utf8")),
  );
  if (
    candidate.schema !== "hereisit-processing-candidate@2" ||
    candidate.releaseId !== releaseId ||
    candidate.gitSha !== gitSha
  )
    throw new TypeError("candidate is not exact current @2 release");
  let reports;
  try {
    reports = JSON.parse(serializedReports);
  } catch {
    throw new TypeError("reviewed release evidence is invalid JSON");
  }
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
  });
}
