import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyProcessingReleaseReport } from "./create-processing-release-report.mjs";
import { assertExactKeys, canonicalJson, parseCliArguments } from "./image-lab-common.mjs";

export { verifyProcessingReleaseReport };

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
