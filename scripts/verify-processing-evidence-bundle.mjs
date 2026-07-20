import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateProcessingEvidenceBundle } from "./create-processing-evidence-bundle.mjs";
import {
  assertExactKeys,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";
import { verifyCanonicalProcessingEvidenceSignature } from "./processing-evidence-signature.mjs";

const maximumBundleBytes = 8 * 1024 * 1024;

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical timestamp`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return value;
}

export async function verifyProcessingEvidenceBundle({
  bundlePath,
  signaturePath,
  publicKeyPath,
  expectedReleaseId,
  expectedGitSha,
  expectedCandidateVerificationSha256,
  now,
}) {
  const bytes = await readBoundedRegularFile(
    resolve(bundlePath),
    maximumBundleBytes,
    "processing evidence bundle",
  );
  let bundle;
  try {
    bundle = JSON.parse(bytes);
  } catch {
    throw new TypeError("processing evidence bundle is not valid JSON");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(bundle)))) {
    throw new TypeError("processing evidence bundle is not canonical JSON");
  }
  validateProcessingEvidenceBundle(bundle);
  const signature = await verifyCanonicalProcessingEvidenceSignature({
    bundlePath,
    signaturePath,
    publicKeyPath,
  });
  if (signature.bundleSha256 !== sha256Bytes(bytes)) {
    throw new TypeError("processing evidence bundle changed during verification");
  }
  if (
    bundle.releaseId !== expectedReleaseId ||
    bundle.gitSha !== expectedGitSha ||
    bundle.candidateVerificationSha256 !== expectedCandidateVerificationSha256
  ) {
    throw new TypeError("processing evidence identities do not match expected values");
  }
  canonicalTimestamp(now, "processing evidence verification time");
  const verificationTime = new Date(now).valueOf();
  if (
    verificationTime < new Date(bundle.createdAt).valueOf() ||
    verificationTime >= new Date(bundle.expiresAt).valueOf()
  ) {
    throw new TypeError("processing evidence verification time is outside the validity window");
  }
  return {
    bundleSha256: signature.bundleSha256,
    signatureSha256: signature.signatureSha256,
    releaseId: bundle.releaseId,
    expiresAt: bundle.expiresAt,
  };
}

export async function runProcessingEvidenceBundleVerifierCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(
    args,
    [
      "bundle",
      "signature",
      "public-key",
      "expected-release-id",
      "expected-git-sha",
      "expected-candidate-verification-sha256",
      "now",
    ],
    "processing evidence verifier arguments",
  );
  const result = await verifyProcessingEvidenceBundle({
    bundlePath: args.bundle,
    signaturePath: args.signature,
    publicKeyPath: args["public-key"],
    expectedReleaseId: args["expected-release-id"],
    expectedGitSha: args["expected-git-sha"],
    expectedCandidateVerificationSha256: args["expected-candidate-verification-sha256"],
    now: args.now,
  });
  stdout.write(canonicalJson(result));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingEvidenceBundleVerifierCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "processing evidence bundle verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
