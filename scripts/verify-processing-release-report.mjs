import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveProcessingReleaseReport,
  validateProcessingReleaseReport,
} from "./create-processing-release-report.mjs";
import {
  assertExactKeys,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";

const maximumReportBytes = 1024 * 1024;

export async function verifyProcessingReleaseReport({ reportPath, ...inputs }) {
  const bytes = await readBoundedRegularFile(
    resolve(reportPath),
    maximumReportBytes,
    "processing release report",
  );
  let report;
  try {
    report = JSON.parse(bytes);
  } catch {
    throw new TypeError("processing release report is not valid JSON");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(report)))) {
    throw new TypeError("processing release report is not canonical JSON");
  }
  validateProcessingReleaseReport(report);
  const expected = await deriveProcessingReleaseReport(inputs);
  if (!bytes.equals(Buffer.from(canonicalJson(expected)))) {
    throw new TypeError("processing release report does not match verified release inputs");
  }
  return {
    schema: "hereisit-processing-release-report-verification@1",
    releaseId: report.releaseId,
    gitSha: report.gitSha,
    reportSha256: sha256Bytes(bytes),
    evidenceBundleSha256: report.evidence.bundleSha256,
    evidenceSignatureSha256: report.evidence.signatureSha256,
  };
}

const verifierCliKeys = [
  "candidate-root",
  "candidate-manifest",
  "evidence-bundle",
  "evidence-signature",
  "public-key",
  "now",
  "report",
];

export async function runProcessingReleaseReportVerifierCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(args, verifierCliKeys, "processing release report verifier arguments");
  const summary = await verifyProcessingReleaseReport({
    candidateRoot: args["candidate-root"],
    candidateManifestPath: args["candidate-manifest"],
    evidenceBundlePath: args["evidence-bundle"],
    evidenceSignaturePath: args["evidence-signature"],
    publicKeyPath: args["public-key"],
    now: args.now,
    reportPath: args.report,
  });
  stdout.write(canonicalJson(summary));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingReleaseReportVerifierCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "processing release report verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
