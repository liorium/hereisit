import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateProcessingReleaseReport,
  verifyProcessingReleaseReport,
} from "./create-processing-release-report.mjs";
import { canonicalJson, parseCliArguments } from "./image-lab-common.mjs";

const gitShaPattern = /^[a-f0-9]{40}$/;

export async function verifyProcessingDeploymentAuthority(
  input,
  verify = verifyProcessingReleaseReport,
) {
  if (!gitShaPattern.test(input.expectedGitSha ?? ""))
    throw new TypeError("expected Git SHA is invalid");
  const bytes = await readFile(resolve(input.reportPath));
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024)
    throw new RangeError("release report is not bounded");
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("release report is not valid JSON");
  }
  validateProcessingReleaseReport(report);
  if (report.schema !== "hereisit-processing-release-report@2" || report.version !== 2) {
    throw new TypeError("current deployment requires processing release report @2");
  }
  if (report.gitSha !== input.expectedGitSha)
    throw new TypeError("release report Git SHA does not match deployment source");
  const verification = await verify(input);
  if (
    verification.gitSha !== input.expectedGitSha ||
    verification.reportSha256 !== input.expectedReportSha256
  ) {
    throw new TypeError(
      "verified release authority identity does not match exact deployment inputs",
    );
  }
  return {
    schema: "hereisit-processing-deployment-authority@1",
    passed: true,
    gitSha: verification.gitSha,
    releaseId: verification.releaseId,
    reportSha256: verification.reportSha256,
  };
}

export async function runProcessingDeploymentAuthorityCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const keys = [
    "candidate-root",
    "candidate-manifest",
    "evidence-bundle",
    "evidence-signature",
    "public-key",
    "now",
    "report",
    "expected-git-sha",
    "expected-report-sha256",
  ];
  if (Object.keys(args).sort().join(",") !== keys.sort().join(","))
    throw new TypeError("deployment authority arguments are invalid");
  const result = await verifyProcessingDeploymentAuthority({
    candidateRoot: args["candidate-root"],
    candidateManifestPath: args["candidate-manifest"],
    evidenceBundlePath: args["evidence-bundle"],
    evidenceSignaturePath: args["evidence-signature"],
    publicKeyPath: args["public-key"],
    now: args.now,
    reportPath: args.report,
    expectedGitSha: args["expected-git-sha"],
    expectedReportSha256: args["expected-report-sha256"],
  });
  stdout.write(canonicalJson(result));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runProcessingDeploymentAuthorityCli(process.argv.slice(2));
}
