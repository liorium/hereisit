import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  processingEvidenceReportNames,
  validateProcessingEvidenceBundle,
} from "./create-processing-evidence-bundle.mjs";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  canonicalize,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import {
  assertVerifiedProcessingCandidateManifest,
  verifyProcessingCandidate,
} from "./verify-processing-candidate.mjs";
import { verifyProcessingEvidenceBundle } from "./verify-processing-evidence-bundle.mjs";

const maximumReportBytes = 1024 * 1024;
const releaseIdPattern = /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/;
const gitShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const reportNames = Object.freeze([
  "fullCorpusBenchmark",
  "competitorComparison",
  "blindedHumanReview",
  "commercialReview",
  "privacyReview",
  "deviceMatrix",
]);
const securityScopes = Object.freeze([
  ["engine", "engine"],
  ["webStaging", "web-staging"],
  ["webProduction", "web-production"],
  ["worker", "worker"],
  ["lockfile", "lockfile"],
]);

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be canonical`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be canonical`);
  }
}

function validateDescriptor(value, expectedPath, maximumBytes, label) {
  const descriptor = assertObject(value, label);
  assertExactKeys(descriptor, ["path", "sizeBytes", "sha256"], label);
  if (descriptor.path !== expectedPath) throw new TypeError(`${label} path does not match`);
  assertNonNegativeSafeInteger(descriptor.sizeBytes, `${label} size`);
  if (descriptor.sizeBytes < 1) throw new TypeError(`${label} size must be positive`);
  if (descriptor.sizeBytes > maximumBytes) throw new RangeError(`${label} size exceeds the limit`);
  assertSha256(descriptor.sha256, `${label} hash`);
}

function validateEvidence(value) {
  const evidence = assertObject(value, "release report evidence");
  assertExactKeys(
    evidence,
    ["bundleSha256", "signatureSha256", "reports"],
    "release report evidence",
  );
  assertSha256(evidence.bundleSha256, "release report evidence bundle hash");
  assertSha256(evidence.signatureSha256, "release report evidence signature hash");
  const reports = assertObject(evidence.reports, "release report evidence reports");
  assertExactKeys(reports, reportNames, "release report evidence reports");
  for (const name of reportNames) {
    const report = assertObject(reports[name], `${name} release report evidence`);
    assertExactKeys(report, ["sourceSha256", "summarySha256"], `${name} release report evidence`);
    assertSha256(report.sourceSha256, `${name} source hash`);
    assertSha256(report.summarySha256, `${name} summary hash`);
  }
}

function validateSecurity(value) {
  const security = assertObject(value, "release report security");
  assertExactKeys(
    security,
    ["trivyDbDigest", "gates", "sboms", "vulnerabilityReports"],
    "release report security",
  );
  assertPattern(security.trivyDbDigest, digestPattern, "release report Trivy database digest");
  const gates = assertObject(security.gates, "release report security gates");
  assertExactKeys(
    gates,
    ["imageEngine", "applicationSupplyChain", "vulnerability"],
    "release report security gates",
  );
  validateDescriptor(
    gates.imageEngine,
    "security-image-engine-license-gate.json",
    1024 * 1024,
    "image-engine gate descriptor",
  );
  validateDescriptor(
    gates.applicationSupplyChain,
    "security-application-supply-chain-gate.json",
    1024 * 1024,
    "application gate descriptor",
  );
  validateDescriptor(
    gates.vulnerability,
    "security-vulnerability-gate.json",
    1024 * 1024,
    "vulnerability gate descriptor",
  );
  for (const [groupName, prefix, suffix] of [
    ["sboms", "security-sbom-", ".cdx.json"],
    ["vulnerabilityReports", "security-trivy-", ".json"],
  ]) {
    const group = assertObject(security[groupName], `release report security ${groupName}`);
    assertExactKeys(
      group,
      securityScopes.map(([key]) => key),
      `release report security ${groupName}`,
    );
    for (const [key, scope] of securityScopes) {
      validateDescriptor(
        group[key],
        `${prefix}${scope}${suffix}`,
        8 * 1024 * 1024,
        `${scope} ${groupName} descriptor`,
      );
    }
  }
}

function validateArtifacts(value) {
  const artifacts = assertObject(value, "release report artifacts");
  assertExactKeys(
    artifacts,
    [
      "engineDockerConfigDigest",
      "webStagingArchiveSha256",
      "webProductionArchiveSha256",
      "workerSha256",
      "lockfileSha256",
    ],
    "release report artifacts",
  );
  assertPattern(
    artifacts.engineDockerConfigDigest,
    digestPattern,
    "release report engine Docker digest",
  );
  for (const field of [
    "webStagingArchiveSha256",
    "webProductionArchiveSha256",
    "workerSha256",
    "lockfileSha256",
  ]) {
    assertSha256(artifacts[field], `release report ${field}`);
  }
}

export function validateProcessingReleaseReport(value) {
  const report = assertObject(value, "processing release report");
  assertExactKeys(
    report,
    [
      "schema",
      "version",
      "passed",
      "releaseId",
      "gitSha",
      "candidateVerificationSha256",
      "verifiedAt",
      "expiresAt",
      "evidence",
      "security",
      "artifacts",
      "verificationSha256",
    ],
    "processing release report",
  );
  if (
    report.schema !== "hereisit-processing-release-report@1" ||
    report.version !== 1 ||
    report.passed !== true
  ) {
    throw new TypeError("processing release report identity is invalid");
  }
  assertPattern(report.releaseId, releaseIdPattern, "processing release report release ID");
  assertPattern(report.gitSha, gitShaPattern, "processing release report git SHA");
  assertSha256(report.candidateVerificationSha256, "processing candidate verification hash");
  assertCanonicalTimestamp(report.verifiedAt, "processing release report verification time");
  assertCanonicalTimestamp(report.expiresAt, "processing release report expiry time");
  if (new Date(report.verifiedAt).valueOf() >= new Date(report.expiresAt).valueOf()) {
    throw new TypeError("processing release report verification time must precede expiry");
  }
  validateEvidence(report.evidence);
  validateSecurity(report.security);
  validateArtifacts(report.artifacts);
  assertSha256(report.verificationSha256, "processing release report verification hash");
  const { verificationSha256: _verificationSha256, ...payload } = report;
  if (sha256Canonical(payload) !== report.verificationSha256) {
    throw new TypeError("processing release report verification hash does not match");
  }
  if (Buffer.byteLength(canonicalJson(report)) > maximumReportBytes) {
    throw new RangeError("processing release report exceeds the size limit");
  }
  return report;
}

function createProcessingReleaseReport(inputs) {
  const payload = canonicalize({
    schema: "hereisit-processing-release-report@1",
    version: 1,
    passed: true,
    ...inputs,
  });
  return canonicalize(
    validateProcessingReleaseReport({
      ...payload,
      verificationSha256: sha256Canonical(payload),
    }),
  );
}

async function writeProcessingReleaseReport({ output, report }) {
  validateProcessingReleaseReport(report);
  await writeCanonicalJsonAtomic(output, report, { refuseOverwrite: true, mode: 0o600 });
  return report.verificationSha256;
}

async function readCanonicalJson(path, maximumBytes, label, validator) {
  const bytes = await readBoundedRegularFile(resolve(path), maximumBytes, label);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new TypeError(`${label} is not canonical JSON`);
  }
  validator(value);
  return { bytes, value };
}

function cloneSecurity(security, trivyDbDigest) {
  return canonicalize({ trivyDbDigest, ...security });
}

async function deriveProcessingReleaseReport({
  candidateRoot,
  candidateManifestPath,
  evidenceBundlePath,
  evidenceSignaturePath,
  publicKeyPath,
  now,
}) {
  const candidateVerification = await verifyProcessingCandidate({
    manifestPath: candidateManifestPath,
    root: candidateRoot,
    requiredState: "built",
  });
  const { bytes: candidateBytes, value: candidate } = await readCanonicalJson(
    candidateManifestPath,
    maximumReportBytes,
    "processing candidate manifest",
    validateProcessingCandidate,
  );
  if (candidate.state !== "built") throw new TypeError("processing candidate must be built");
  assertVerifiedProcessingCandidateManifest({
    verification: candidateVerification,
    manifestBytes: candidateBytes,
    candidate,
  });
  const evidenceIdentity = await verifyProcessingEvidenceBundle({
    bundlePath: evidenceBundlePath,
    signaturePath: evidenceSignaturePath,
    publicKeyPath,
    expectedReleaseId: candidate.releaseId,
    expectedGitSha: candidate.gitSha,
    expectedCandidateVerificationSha256: candidate.verificationSha256,
    now,
  });
  const { bytes: evidenceBytes, value: evidence } = await readCanonicalJson(
    evidenceBundlePath,
    8 * 1024 * 1024,
    "processing evidence bundle",
    validateProcessingEvidenceBundle,
  );
  if (sha256Bytes(evidenceBytes) !== evidenceIdentity.bundleSha256) {
    throw new TypeError("processing evidence bundle changed after verification");
  }
  const applicationAsset = candidate.releaseAssets.security.gates.applicationSupplyChain;
  const { bytes: applicationBytes, value: applicationGate } = await readCanonicalJson(
    resolve(candidateRoot, applicationAsset.path),
    maximumReportBytes,
    "application supply-chain gate",
    (value) => {
      const gate = assertObject(value, "application supply-chain gate");
      assertSha256(gate.lockfileSha256, "application supply-chain lockfile hash");
    },
  );
  if (
    applicationBytes.byteLength !== applicationAsset.sizeBytes ||
    sha256Bytes(applicationBytes) !== applicationAsset.sha256
  ) {
    throw new TypeError("application supply-chain gate changed after candidate verification");
  }
  const candidateAfterRead = await readBoundedRegularFile(
    resolve(candidateManifestPath),
    maximumReportBytes,
    "processing candidate manifest",
  );
  if (!candidateAfterRead.equals(candidateBytes)) {
    throw new TypeError("processing candidate changed during report creation");
  }
  return createProcessingReleaseReport({
    releaseId: candidate.releaseId,
    gitSha: candidate.gitSha,
    candidateVerificationSha256: candidate.verificationSha256,
    verifiedAt: now,
    expiresAt: evidence.expiresAt,
    evidence: {
      bundleSha256: evidenceIdentity.bundleSha256,
      signatureSha256: evidenceIdentity.signatureSha256,
      reports: Object.fromEntries(
        processingEvidenceReportNames.map((name) => [
          name,
          {
            sourceSha256: evidence.reports[name].sourceSha256,
            summarySha256: evidence.reports[name].summarySha256,
          },
        ]),
      ),
    },
    security: cloneSecurity(candidate.releaseAssets.security, candidate.security.trivyDbDigest),
    artifacts: {
      engineDockerConfigDigest: candidate.engine.docker.configDigest,
      webStagingArchiveSha256: candidate.web.staging.archiveSha256,
      webProductionArchiveSha256: candidate.web.production.archiveSha256,
      workerSha256: candidate.releaseAssets.worker.sha256,
      lockfileSha256: applicationGate.lockfileSha256,
    },
  });
}

export async function createAndWriteProcessingReleaseReport({ reportPath, ...inputs }) {
  const report = await deriveProcessingReleaseReport(inputs);
  await writeProcessingReleaseReport({ output: reportPath, report });
  return report;
}

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

const creatorCliKeys = [
  "candidate-root",
  "candidate-manifest",
  "evidence-bundle",
  "evidence-signature",
  "public-key",
  "now",
  "output",
];

export async function runProcessingReleaseReportCreatorCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(args, creatorCliKeys, "processing release report creator arguments");
  const report = await createAndWriteProcessingReleaseReport({
    candidateRoot: args["candidate-root"],
    candidateManifestPath: args["candidate-manifest"],
    evidenceBundlePath: args["evidence-bundle"],
    evidenceSignaturePath: args["evidence-signature"],
    publicKeyPath: args["public-key"],
    now: args.now,
    reportPath: args.output,
  });
  stdout.write(
    canonicalJson({
      schema: "hereisit-processing-release-report-creation@1",
      version: 1,
      passed: true,
      releaseId: report.releaseId,
      gitSha: report.gitSha,
      reportSha256: sha256Bytes(canonicalJson(report)),
    }),
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingReleaseReportCreatorCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "processing release report creation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
