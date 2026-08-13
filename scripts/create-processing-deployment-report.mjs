import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateProcessingReleaseReport } from "./create-processing-release-report.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalize,
  canonicalJson,
  parseCliArguments,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import { validateProcessingProvisionManifest } from "./read-processing-provision-manifest.mjs";
import { validatePdfSmokeTrace } from "./smoke-pdf-compress-server.mjs";
import { validateWorkerVersionAttestation } from "./verify-worker-version-chain.mjs";

const gitShaPattern = /^[a-f0-9]{40}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digestPattern =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/hereisit-(?:image|pdf)-engine@sha256:[0-9a-f]{64}$/;
const receiptNames = Object.freeze([
  "imageCanary",
  "pdfCanary",
  "deletion",
  "cost",
  "rollback",
  "admission",
  "gate",
  "policy",
]);
const receiptSchemas = Object.freeze({
  imageCanary: "hereisit-processing-production-canary-smoke@1",
  pdfCanary: "hereisit-processing-pdf-smoke@1",
  deletion: "hereisit-pdf-deletion-receipt@1",
  cost: "hereisit-pdf-cost-receipt@1",
  rollback: "hereisit-pdf-rollback-receipt@1",
  admission: "hereisit-pdf-public-admission@1",
  gate: "hereisit-processing-deployment-gate@1",
  policy: "hereisit-processing-production-canary-policy-smoke@1",
});

export function validateProcessingDeploymentReport(value) {
  const report = assertObject(value, "processing deployment report");
  assertExactKeys(
    report,
    [
      "schema",
      "version",
      "passed",
      "publicAdmissionReady",
      "gitSha",
      "releaseReportSha256",
      "worker",
      "engines",
      "deployment",
      "receipts",
      "createdAt",
      "verificationSha256",
    ],
    "processing deployment report",
  );
  if (
    report.schema !== "hereisit-processing-deployment-report@1" ||
    report.version !== 1 ||
    report.passed !== true ||
    typeof report.publicAdmissionReady !== "boolean" ||
    !gitShaPattern.test(report.gitSha ?? "")
  )
    throw new TypeError("processing deployment report identity is invalid");
  assertSha256(report.releaseReportSha256, "deployment release report hash");
  const worker = assertObject(report.worker, "deployment Worker");
  assertExactKeys(
    worker,
    ["activeVersionId", "moduleSha256", "generatedConfigSha256"],
    "deployment Worker",
  );
  if (!uuidPattern.test(worker.activeVersionId ?? ""))
    throw new TypeError("deployment Worker version is invalid");
  assertSha256(worker.moduleSha256, "deployment Worker module hash");
  assertSha256(worker.generatedConfigSha256, "deployment generated config hash");
  const engines = assertObject(report.engines, "deployment engines");
  assertExactKeys(engines, ["imageDigest", "pdfDigest"], "deployment engines");
  if (!digestPattern.test(engines.imageDigest) || !digestPattern.test(engines.pdfDigest))
    throw new TypeError("deployment engine digest is invalid");
  const deployment = assertObject(report.deployment, "deployment coordinates");
  assertExactKeys(
    deployment,
    ["resourcesSha256", "pagesTreeSha256", "pagesDeploymentId"],
    "deployment coordinates",
  );
  assertSha256(deployment.resourcesSha256, "deployment resources hash");
  assertSha256(deployment.pagesTreeSha256, "deployment Pages tree hash");
  if (!uuidPattern.test(deployment.pagesDeploymentId ?? ""))
    throw new TypeError("deployment Pages ID is invalid");
  const receipts = assertObject(report.receipts, "deployment receipts");
  assertExactKeys(receipts, receiptNames, "deployment receipts");
  for (const name of receiptNames) {
    const receipt = assertObject(receipts[name], `${name} deployment receipt`);
    assertExactKeys(receipt, ["schema", "sha256", "passed"], `${name} deployment receipt`);
    if (receipt.schema !== receiptSchemas[name] || typeof receipt.passed !== "boolean")
      throw new TypeError(`${name} deployment receipt identity is invalid`);
    assertSha256(receipt.sha256, `${name} deployment receipt hash`);
  }
  for (const name of ["imageCanary", "pdfCanary", "deletion", "gate", "policy"]) {
    if (receipts[name].passed !== true)
      throw new TypeError(`${name} deployment receipt did not pass`);
  }
  if (
    report.publicAdmissionReady !== receipts.admission.passed ||
    (report.publicAdmissionReady &&
      ["cost", "rollback", "deletion"].some((name) => receipts[name].passed !== true))
  )
    throw new TypeError("public admission receipts are incomplete");
  const created = new Date(report.createdAt);
  if (!Number.isFinite(created.valueOf()) || created.toISOString() !== report.createdAt)
    throw new TypeError("deployment report timestamp is invalid");
  assertSha256(report.verificationSha256, "deployment report verification hash");
  const { verificationSha256: _verificationSha256, ...payload } = report;
  if (sha256Canonical(payload) !== report.verificationSha256)
    throw new TypeError("deployment report verification hash does not match");
  return report;
}

export function createProcessingDeploymentReport(input) {
  const payload = canonicalize({
    schema: "hereisit-processing-deployment-report@1",
    version: 1,
    passed: true,
    publicAdmissionReady: input.receipts?.admission?.passed === true,
    ...input,
  });
  return canonicalize(
    validateProcessingDeploymentReport({
      ...payload,
      verificationSha256: sha256Canonical(payload),
    }),
  );
}

async function readJson(path) {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024)
    throw new RangeError("deployment receipt is not bounded");
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function passedFor(name, value) {
  if (name === "admission") return value.enabled === true;
  if (name === "gate") return value.verified === true;
  return value.passed === true;
}

function commonReleaseReceipt(value, name, schema, releaseReportSha256, keys) {
  const receipt = assertObject(value, `${name} deployment receipt`);
  assertExactKeys(
    receipt,
    ["schema", "version", "passed", "releaseReportSha256", ...keys],
    `${name} deployment receipt`,
  );
  if (
    receipt.schema !== schema ||
    receipt.version !== 1 ||
    typeof receipt.passed !== "boolean" ||
    receipt.releaseReportSha256 !== releaseReportSha256
  )
    throw new TypeError(`${name} deployment receipt does not bind the exact release report`);
  return receipt;
}

export function validateProcessingDeploymentReceipt(name, value, releaseReportSha256) {
  assertSha256(releaseReportSha256, "deployment receipt release report hash");
  if (name === "imageCanary") {
    const receipt = assertObject(value, "image canary deployment receipt");
    assertExactKeys(
      receipt,
      [
        "schema",
        "version",
        "passed",
        "rolloutPercent",
        "nonMaintainerLocal",
        "maintainerServer",
        "browserPreflight",
        "exactLengthUpload",
        "directDownload",
        "downloadAcknowledged",
        "sourceFilenameLeak",
      ],
      "image canary deployment receipt",
    );
    if (
      receipt.schema !== receiptSchemas.imageCanary ||
      receipt.version !== 1 ||
      receipt.passed !== true ||
      receipt.rolloutPercent !== 0 ||
      receipt.nonMaintainerLocal !== true ||
      receipt.maintainerServer !== true ||
      receipt.browserPreflight !== true ||
      receipt.exactLengthUpload !== true ||
      receipt.directDownload !== true ||
      receipt.downloadAcknowledged !== true ||
      receipt.sourceFilenameLeak !== false
    )
      throw new TypeError("image canary deployment receipt did not pass");
    return receipt;
  }
  if (name === "pdfCanary") return validatePdfSmokeTrace(value);
  if (name === "deletion") {
    const receipt = commonReleaseReceipt(
      value,
      name,
      receiptSchemas.deletion,
      releaseReportSha256,
      ["deleted", "sweepPassed"],
    );
    if (receipt.passed !== true || receipt.deleted !== true || receipt.sweepPassed !== true)
      throw new TypeError("deletion deployment receipt did not pass");
    return receipt;
  }
  if (name === "cost") {
    const receipt = commonReleaseReceipt(value, name, receiptSchemas.cost, releaseReportSha256, [
      "projectedMonthlyCostMicrousd",
      "costPer1000JobsMicrousd",
    ]);
    for (const key of ["projectedMonthlyCostMicrousd", "costPer1000JobsMicrousd"]) {
      if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0)
        throw new TypeError("cost deployment receipt is invalid");
    }
    return receipt;
  }
  if (name === "rollback") {
    const keys = [
      "workerRestored",
      "imageEngineRestored",
      "pdfEngineRestored",
      "configRestored",
      "policyRestored",
      "queuesRestored",
    ];
    const receipt = commonReleaseReceipt(
      value,
      name,
      receiptSchemas.rollback,
      releaseReportSha256,
      keys,
    );
    if (keys.some((key) => typeof receipt[key] !== "boolean"))
      throw new TypeError("rollback deployment receipt is invalid");
    return receipt;
  }
  if (name === "admission") {
    const receipt = assertObject(value, "admission deployment receipt");
    assertExactKeys(
      receipt,
      [
        "schema",
        "enabled",
        "releaseReportSha256",
        "visualProfilesMeasured",
        "deletionPassed",
        "costPassed",
        "rollbackPassed",
      ],
      "admission deployment receipt",
    );
    if (
      receipt.schema !== receiptSchemas.admission ||
      receipt.releaseReportSha256 !== releaseReportSha256 ||
      typeof receipt.enabled !== "boolean" ||
      !Number.isSafeInteger(receipt.visualProfilesMeasured) ||
      receipt.visualProfilesMeasured < 0 ||
      ["deletionPassed", "costPassed", "rollbackPassed"].some(
        (key) => typeof receipt[key] !== "boolean",
      ) ||
      receipt.enabled !==
        (receipt.visualProfilesMeasured > 0 &&
          receipt.deletionPassed &&
          receipt.costPassed &&
          receipt.rollbackPassed)
    )
      throw new TypeError("admission deployment receipt is inconsistent");
    return receipt;
  }
  if (name === "gate") {
    const receipt = assertObject(value, "gate deployment receipt");
    assertExactKeys(
      receipt,
      ["schema", "version", "passed", "verified"],
      "gate deployment receipt",
    );
    if (
      receipt.schema !== receiptSchemas.gate ||
      receipt.version !== 1 ||
      receipt.passed !== true ||
      receipt.verified !== true
    )
      throw new TypeError("deployment gate did not pass");
    return receipt;
  }
  if (name === "policy") {
    const receipt = assertObject(value, "policy deployment receipt");
    assertExactKeys(
      receipt,
      ["schema", "passed", "execution", "reason", "upload", "queuesPaused"],
      "policy deployment receipt",
    );
    if (
      receipt.schema !== receiptSchemas.policy ||
      receipt.passed !== true ||
      receipt.execution !== "local" ||
      receipt.reason !== "LOCAL_FALLBACK_REQUIRED" ||
      receipt.upload !== false ||
      receipt.queuesPaused !== true
    )
      throw new TypeError("deployment policy did not remain fail closed");
    return receipt;
  }
  throw new TypeError("deployment receipt name is invalid");
}

export async function loadProcessingDeploymentReportInput(args, createdAt) {
  const release = await readJson(args["release-report"]);
  const releaseValue = validateProcessingReleaseReport(release.value);
  if (releaseValue.schema !== "hereisit-processing-release-report@2")
    throw new TypeError("deployment projection requires release report @2");
  const attestation = validateWorkerVersionAttestation(
    (await readJson(args["worker-attestation"])).value,
  );
  const candidate = validateProcessingCandidate((await readJson(args.candidate)).value);
  if (candidate.schema !== "hereisit-processing-candidate@2")
    throw new TypeError("deployment projection requires candidate @2");
  const resources = await readJson(args.resources);
  validateProcessingProvisionManifest(resources.value);
  const imageDigest = (await readFile(resolve(args["image-digest"]), "utf8")).trim();
  const pdfDigest = (await readFile(resolve(args["pdf-digest"]), "utf8")).trim();
  const pagesDeploymentId = (await readFile(resolve(args["pages-deployment-id"]), "utf8")).trim();
  const releaseReportSha256 = sha256Bytes(release.bytes);
  if (
    attestation.releaseReportSha256 !== releaseReportSha256 ||
    candidate.gitSha !== releaseValue.gitSha ||
    candidate.releaseId !== releaseValue.releaseId ||
    resources.value.environment !== "production"
  )
    throw new TypeError("deployment artifacts do not bind the exact release authority");
  const paths = {
    imageCanary: args["image-canary"],
    pdfCanary: args["pdf-canary"],
    deletion: args["deletion-receipt"],
    cost: args["cost-receipt"],
    rollback: args["rollback-receipt"],
    admission: args.admission,
    gate: args.gate,
    policy: args.policy,
  };
  const receipts = {};
  for (const [name, path] of Object.entries(paths)) {
    const source = await readJson(path);
    const receipt = validateProcessingDeploymentReceipt(name, source.value, releaseReportSha256);
    receipts[name] = {
      schema: receiptSchemas[name],
      sha256: sha256Bytes(source.bytes),
      passed: passedFor(name, receipt),
    };
  }
  return {
    gitSha: releaseValue.gitSha,
    releaseReportSha256,
    worker: {
      activeVersionId: attestation.activeVersionId,
      moduleSha256: attestation.workerModuleSha256,
      generatedConfigSha256: attestation.generatedConfigSha256,
    },
    engines: { imageDigest, pdfDigest },
    deployment: {
      resourcesSha256: sha256Bytes(resources.bytes),
      pagesTreeSha256: candidate.web.production.treeSha256,
      pagesDeploymentId,
    },
    receipts,
    createdAt,
  };
}

export async function runProcessingDeploymentReportCli(argv) {
  const args = parseCliArguments(argv);
  const report = createProcessingDeploymentReport(
    await loadProcessingDeploymentReportInput(args, args["created-at"]),
  );
  await writeCanonicalJsonAtomic(resolve(args.output), report, {
    refuseOverwrite: true,
    mode: 0o600,
  });
  return report;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const report = await runProcessingDeploymentReportCli(process.argv.slice(2));
    process.stdout.write(canonicalJson(report));
  } catch {
    process.stderr.write("processing deployment report creation failed\n");
    process.exitCode = 1;
  }
}
