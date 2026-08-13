import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createProcessingDeploymentReport,
  loadProcessingDeploymentReportInput,
  validateProcessingDeploymentReport,
} from "./create-processing-deployment-report.mjs";
import {
  assertExactKeys,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  sha256Bytes,
} from "./image-lab-common.mjs";
import { verifyCanonicalProcessingEvidenceSignature } from "./processing-evidence-signature.mjs";

export async function verifyProcessingDeploymentReport({
  report,
  signature,
  publicKey,
  expectedGitSha,
  expectedReleaseReportSha256,
  projectionInputs,
}) {
  const bytes = await readFile(resolve(report));
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024)
    throw new RangeError("deployment report is not bounded");
  const value = validateProcessingDeploymentReport(JSON.parse(bytes.toString("utf8")));
  if (value.gitSha !== expectedGitSha || value.releaseReportSha256 !== expectedReleaseReportSha256)
    throw new TypeError("deployment report authority does not match the exact release");
  if (projectionInputs !== undefined) {
    const expected = createProcessingDeploymentReport(
      await loadProcessingDeploymentReportInput(projectionInputs, value.createdAt),
    );
    if (canonicalJson(expected) !== canonicalJson(value))
      throw new TypeError("deployment report projection does not match the supplied artifacts");
  }
  assertSha256(expectedReleaseReportSha256, "expected release report hash");
  const verified = await verifyCanonicalProcessingEvidenceSignature({
    bundlePath: report,
    signaturePath: signature,
    publicKeyPath: publicKey,
  });
  return {
    schema: "hereisit-processing-deployment-report-verification@1",
    passed: true,
    gitSha: value.gitSha,
    reportSha256: sha256Bytes(bytes),
    signatureSha256: verified.signatureSha256,
    publicAdmissionReady: value.publicAdmissionReady,
  };
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = parseCliArguments(process.argv.slice(2));
  const projectionKeys = [
    "release-report",
    "worker-attestation",
    "candidate",
    "resources",
    "image-digest",
    "pdf-digest",
    "pages-deployment-id",
    "image-canary",
    "pdf-canary",
    "deletion-receipt",
    "cost-receipt",
    "rollback-receipt",
    "admission",
    "gate",
    "policy",
  ];
  assertExactKeys(
    args,
    [
      "report",
      "signature",
      "public-key",
      "expected-git-sha",
      "expected-release-report-sha256",
      ...projectionKeys,
    ],
    "deployment report verification arguments",
  );
  if (projectionKeys.some((key) => args[key] === undefined))
    throw new TypeError("deployment report projection inputs are required");
  const result = await verifyProcessingDeploymentReport({
    report: args.report,
    signature: args.signature,
    publicKey: args["public-key"],
    expectedGitSha: args["expected-git-sha"],
    expectedReleaseReportSha256: args["expected-release-report-sha256"],
    projectionInputs: Object.fromEntries(projectionKeys.map((key) => [key, args[key]])),
  });
  process.stdout.write(canonicalJson(result));
}
