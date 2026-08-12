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
  ["pdfEngine", "pdf-engine"],
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

function validateSecurity(value, dual) {
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
    dual
      ? ["imageEngine", "pdfEngine", "applicationSupplyChain", "vulnerability"]
      : ["imageEngine", "applicationSupplyChain", "vulnerability"],
    "release report security gates",
  );
  validateDescriptor(
    gates.imageEngine,
    "security-image-engine-license-gate.json",
    1024 * 1024,
    "image-engine gate descriptor",
  );
  if (dual) {
    validateDescriptor(
      gates.pdfEngine,
      "security-pdf-engine-license-gate.json",
      1024 * 1024,
      "PDF-engine gate descriptor",
    );
  }
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
      securityScopes.filter(([key]) => dual || key !== "pdfEngine").map(([key]) => key),
      `release report security ${groupName}`,
    );
    for (const [key, scope] of securityScopes.filter(([key]) => dual || key !== "pdfEngine")) {
      validateDescriptor(
        group[key],
        `${prefix}${scope}${suffix}`,
        8 * 1024 * 1024,
        `${scope} ${groupName} descriptor`,
      );
    }
  }
}

function validateArtifacts(value, dual) {
  const artifacts = assertObject(value, "release report artifacts");
  assertExactKeys(
    artifacts,
    [
      "engineDockerConfigDigest",
      ...(dual
        ? [
            "pdfEngineDockerConfigDigest",
            "pdfBenchmarkSha256",
            "pdfReleaseGateSha256",
            "pdfVisualProfilesMeasured",
            "pdfPublicAdmissionReady",
          ]
        : []),
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
  if (dual) {
    assertPattern(
      artifacts.pdfEngineDockerConfigDigest,
      digestPattern,
      "release report PDF engine Docker digest",
    );
    assertSha256(artifacts.pdfBenchmarkSha256, "release report PDF benchmark hash");
    assertSha256(artifacts.pdfReleaseGateSha256, "release report PDF gate hash");
    assertNonNegativeSafeInteger(
      artifacts.pdfVisualProfilesMeasured,
      "release report PDF visual profile count",
    );
    if (typeof artifacts.pdfPublicAdmissionReady !== "boolean") {
      throw new TypeError("release report PDF admission state is invalid");
    }
    if (artifacts.pdfPublicAdmissionReady && artifacts.pdfVisualProfilesMeasured < 1) {
      throw new TypeError("release report PDF admission requires visual evidence");
    }
  }
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
  const dual = report.schema === "hereisit-processing-release-report@2" && report.version === 2;
  const legacy = report.schema === "hereisit-processing-release-report@1" && report.version === 1;
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
  if ((!dual && !legacy) || report.passed !== true) {
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
  validateSecurity(report.security, dual);
  validateArtifacts(report.artifacts, dual);
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
    schema: "hereisit-processing-release-report@2",
    version: 2,
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

function reconstructBuiltCandidate(candidate) {
  const { report: _report, evidence: _evidence, ...releaseAssets } = candidate.releaseAssets;
  const { verificationSha256: _verificationSha256, ...finalizedPayload } = candidate;
  const payload = canonicalize({ ...finalizedPayload, state: "built", releaseAssets });
  return validateProcessingCandidate({
    ...payload,
    verificationSha256: sha256Canonical(payload),
  });
}

function assertFinalizedAssetPath(root, path, asset, label) {
  if (resolve(path) !== resolve(root, ...asset.path.split("/"))) {
    throw new TypeError(`${label} path does not match the finalized candidate`);
  }
}

function assertFinalizedAssetBytes(bytes, asset, label) {
  if (bytes.byteLength !== asset.sizeBytes || sha256Bytes(bytes) !== asset.sha256) {
    throw new TypeError(`${label} does not match the finalized candidate`);
  }
}

async function readFinalizedAsset(root, asset, maximumBytes, label) {
  const bytes = await readBoundedRegularFile(
    resolve(root, ...asset.path.split("/")),
    maximumBytes,
    label,
  );
  assertFinalizedAssetBytes(bytes, asset, label);
  return bytes;
}

async function deriveProcessingReleaseReport(
  {
    candidateRoot,
    candidateManifestPath,
    evidenceBundlePath,
    evidenceSignaturePath,
    publicKeyPath,
    now,
  },
  { candidateState = "built", reportBytes, verifiedReportPath } = {},
) {
  const candidateVerification = await verifyProcessingCandidate({
    manifestPath: candidateManifestPath,
    root: candidateRoot,
    requiredState: candidateState,
  });
  const { bytes: candidateBytes, value: candidate } = await readCanonicalJson(
    candidateManifestPath,
    maximumReportBytes,
    "processing candidate manifest",
    validateProcessingCandidate,
  );
  if (candidate.state !== candidateState) {
    throw new TypeError(`processing candidate must be ${candidateState}`);
  }
  assertVerifiedProcessingCandidateManifest({
    verification: candidateVerification,
    manifestBytes: candidateBytes,
    candidate,
  });
  let builtCandidate = candidate;
  if (candidate.state === "finalized") {
    if (!Buffer.isBuffer(reportBytes)) {
      throw new TypeError("finalized candidate verification requires release report bytes");
    }
    assertFinalizedAssetPath(
      candidateRoot,
      verifiedReportPath,
      candidate.releaseAssets.report,
      "release report",
    );
    assertFinalizedAssetPath(
      candidateRoot,
      evidenceBundlePath,
      candidate.releaseAssets.evidence.bundle,
      "processing evidence bundle",
    );
    assertFinalizedAssetPath(
      candidateRoot,
      evidenceSignaturePath,
      candidate.releaseAssets.evidence.signature,
      "processing evidence signature",
    );
    assertFinalizedAssetBytes(reportBytes, candidate.releaseAssets.report, "release report");
    builtCandidate = reconstructBuiltCandidate(candidate);
  }
  const evidenceIdentity = await verifyProcessingEvidenceBundle({
    bundlePath: evidenceBundlePath,
    signaturePath: evidenceSignaturePath,
    publicKeyPath,
    expectedReleaseId: builtCandidate.releaseId,
    expectedGitSha: builtCandidate.gitSha,
    expectedCandidateVerificationSha256: builtCandidate.verificationSha256,
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
  if (candidate.state === "finalized") {
    assertFinalizedAssetBytes(
      evidenceBytes,
      candidate.releaseAssets.evidence.bundle,
      "processing evidence bundle",
    );
    const signatureBytes = await readFinalizedAsset(
      candidateRoot,
      candidate.releaseAssets.evidence.signature,
      64,
      "processing evidence signature",
    );
    if (sha256Bytes(signatureBytes) !== evidenceIdentity.signatureSha256) {
      throw new TypeError("processing evidence signature changed after verification");
    }
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
  if (candidate.state === "finalized") {
    for (const [groupName, group] of Object.entries(candidate.releaseAssets.security)) {
      for (const [name, asset] of Object.entries(group)) {
        await readFinalizedAsset(
          candidateRoot,
          asset,
          groupName === "gates" ? 1024 * 1024 : 8 * 1024 * 1024,
          `${name} security ${groupName} asset`,
        );
      }
    }
    const finalReportBytes = await readFinalizedAsset(
      candidateRoot,
      candidate.releaseAssets.report,
      maximumReportBytes,
      "release report",
    );
    if (!finalReportBytes.equals(reportBytes)) {
      throw new TypeError("processing release report changed during verification");
    }
    const [finalEvidenceBytes, finalSignatureBytes, finalCandidateBytes] = await Promise.all([
      readFinalizedAsset(
        candidateRoot,
        candidate.releaseAssets.evidence.bundle,
        8 * 1024 * 1024,
        "processing evidence bundle",
      ),
      readFinalizedAsset(
        candidateRoot,
        candidate.releaseAssets.evidence.signature,
        64,
        "processing evidence signature",
      ),
      readBoundedRegularFile(
        resolve(candidateManifestPath),
        maximumReportBytes,
        "processing candidate manifest",
      ),
    ]);
    if (
      !finalEvidenceBytes.equals(evidenceBytes) ||
      sha256Bytes(finalSignatureBytes) !== evidenceIdentity.signatureSha256 ||
      !finalCandidateBytes.equals(candidateBytes)
    ) {
      throw new TypeError("finalized release inputs changed during verification");
    }
  }
  return createProcessingReleaseReport({
    releaseId: builtCandidate.releaseId,
    gitSha: builtCandidate.gitSha,
    candidateVerificationSha256: builtCandidate.verificationSha256,
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
    security: cloneSecurity(
      builtCandidate.releaseAssets.security,
      builtCandidate.security.trivyDbDigest,
    ),
    artifacts: {
      engineDockerConfigDigest: builtCandidate.engine.docker.configDigest,
      pdfEngineDockerConfigDigest: builtCandidate.pdfEngine.docker.configDigest,
      pdfBenchmarkSha256: builtCandidate.pdfQuality.benchmarkSha256,
      pdfReleaseGateSha256: builtCandidate.pdfQuality.releaseGateSha256,
      pdfVisualProfilesMeasured: builtCandidate.pdfQuality.visualProfilesMeasured,
      pdfPublicAdmissionReady: builtCandidate.pdfQuality.publicAdmissionReady,
      webStagingArchiveSha256: builtCandidate.web.staging.archiveSha256,
      webProductionArchiveSha256: builtCandidate.web.production.archiveSha256,
      workerSha256: builtCandidate.releaseAssets.worker.sha256,
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
  const { value: candidate } = await readCanonicalJson(
    inputs.candidateManifestPath,
    maximumReportBytes,
    "processing candidate manifest",
    validateProcessingCandidate,
  );
  const expected = await deriveProcessingReleaseReport(inputs, {
    candidateState: candidate.state,
    reportBytes: bytes,
    verifiedReportPath: reportPath,
  });
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
