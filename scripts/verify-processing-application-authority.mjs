import { resolve } from "node:path";
import { validateProcessingDeploymentReport } from "./create-processing-deployment-report.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";
import { validateProcessingApplicationRelease } from "./processing-application-release.mjs";
import { verifyCanonicalProcessingEvidenceSignature } from "./processing-evidence-signature.mjs";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function readCanonicalJson(path, maximumBytes, label, validate) {
  const bytes = await readBoundedRegularFile(resolve(path), maximumBytes, label);
  let value;
  try {
    value = validate(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`${label} is not valid JSON`);
    throw error;
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new TypeError(`${label} is not canonical JSON`);
  }
  return { bytes, value };
}

function validateActiveAttestation(value) {
  const active = assertObject(value, "active processing attestation");
  assertExactKeys(
    active,
    [
      "activeCount",
      "versionId",
      "workerModuleSha256",
      "generatedConfigSha256",
      "releaseReportSha256",
      "publicAdmissionAllowed",
    ],
    "active processing attestation",
  );
  if (
    active.activeCount !== 1 ||
    active.publicAdmissionAllowed !== 1 ||
    typeof active.versionId !== "string" ||
    !uuidPattern.test(active.versionId)
  ) {
    throw new TypeError("active processing Worker is invalid");
  }
  for (const field of ["workerModuleSha256", "generatedConfigSha256", "releaseReportSha256"]) {
    assertSha256(active[field], `active processing ${field}`);
  }
  return active;
}

function validateActualResources(value) {
  const actual = assertObject(value, "actual processing resources");
  assertExactKeys(
    actual,
    ["imageEngineDigest", "pdfEngineDigest", "resourcesSha256", "pdfPublicAdmissionEnabled"],
    "actual processing resources",
  );
  if (
    typeof actual.imageEngineDigest !== "string" ||
    typeof actual.pdfEngineDigest !== "string" ||
    typeof actual.pdfPublicAdmissionEnabled !== "boolean"
  ) {
    throw new TypeError("actual processing resources are invalid");
  }
  assertSha256(actual.resourcesSha256, "actual processing resources hash");
  return actual;
}

export async function verifyProcessingApplicationAuthority(
  input,
  verifySignature = verifyCanonicalProcessingEvidenceSignature,
) {
  const [{ bytes: manifestBytes, value: manifest }, { bytes: reportBytes, value: report }] =
    await Promise.all([
      readCanonicalJson(
        input.manifestPath,
        1024 * 1024,
        "processing application release",
        validateProcessingApplicationRelease,
      ),
      readCanonicalJson(
        input.baseReportPath,
        1024 * 1024,
        "base processing deployment report",
        validateProcessingDeploymentReport,
      ),
    ]);
  const [manifestSignature, reportSignature] = await Promise.all([
    verifySignature({
      bundlePath: input.manifestPath,
      signaturePath: input.manifestSignaturePath,
      publicKeyPath: input.publicKeyPath,
    }),
    verifySignature({
      bundlePath: input.baseReportPath,
      signaturePath: input.baseReportSignaturePath,
      publicKeyPath: input.publicKeyPath,
    }),
  ]);
  if (
    manifestSignature.bundleSha256 !== sha256Bytes(manifestBytes) ||
    reportSignature.bundleSha256 !== sha256Bytes(reportBytes)
  ) {
    throw new TypeError("processing application signature does not bind the supplied bytes");
  }
  const now = new Date(input.now);
  if (!Number.isFinite(now.valueOf()) || now.toISOString() !== input.now) {
    throw new TypeError("processing application authority time is invalid");
  }
  if (now < new Date(manifest.createdAt) || now >= new Date(manifest.expiresAt)) {
    throw new TypeError("processing application release is expired or not active");
  }
  const active = validateActiveAttestation(input.activeAttestation);
  const actual = validateActualResources(input.actualResources);
  if (
    manifest.baseReleaseReportSha256 !== report.releaseReportSha256 ||
    active.releaseReportSha256 !== report.releaseReportSha256 ||
    active.generatedConfigSha256 !== report.worker.generatedConfigSha256 ||
    actual.imageEngineDigest !== report.engines.imageDigest ||
    actual.pdfEngineDigest !== report.engines.pdfDigest ||
    actual.resourcesSha256 !== report.deployment.resourcesSha256 ||
    actual.pdfPublicAdmissionEnabled !== report.publicAdmissionReady
  ) {
    throw new TypeError("processing application authority does not match active processing state");
  }
  return {
    schema: "hereisit-processing-application-authority@1",
    passed: true,
    gitSha: manifest.gitSha,
    baseReleaseReportSha256: manifest.baseReleaseReportSha256,
    priorWorkerVersionId: active.versionId,
    priorWorkerModuleSha256: active.workerModuleSha256,
    nextWorkerModuleSha256: manifest.worker.sha256,
    generatedConfigSha256: active.generatedConfigSha256,
    imageEngineDigest: actual.imageEngineDigest,
    pdfEngineDigest: actual.pdfEngineDigest,
    resourcesSha256: actual.resourcesSha256,
    pdfPublicAdmissionEnabled: actual.pdfPublicAdmissionEnabled,
    manifestSha256: manifestSignature.bundleSha256,
    baseDeploymentReportSha256: reportSignature.bundleSha256,
  };
}
