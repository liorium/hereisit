import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateProcessingReleaseReport } from "./create-processing-release-report.mjs";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

async function readJson(path, maximumBytes, label) {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes)
    throw new RangeError(`${label} is not bounded`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  return { bytes, value };
}

function commonReceipt(value, reportSha256, label, schema, keys) {
  const receipt = assertObject(value, label);
  assertExactKeys(receipt, ["schema", "version", "passed", "releaseReportSha256", ...keys], label);
  if (
    receipt.schema !== schema ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.releaseReportSha256 !== reportSha256
  )
    throw new TypeError(`${label} is not passed and bound to the exact release report`);
  assertSha256(receipt.releaseReportSha256, `${label} release report hash`);
  return receipt;
}

function deletionReceipt(value, reportSha256) {
  const receipt = commonReceipt(
    value,
    reportSha256,
    "deletion evidence",
    "hereisit-pdf-deletion-receipt@1",
    ["deleted", "sweepPassed"],
  );
  if (receipt.deleted !== true || receipt.sweepPassed !== true)
    throw new TypeError("deletion evidence did not prove deletion and sweep");
  return true;
}

function costReceipt(value, reportSha256) {
  const receipt = commonReceipt(
    value,
    reportSha256,
    "cost evidence",
    "hereisit-pdf-cost-receipt@1",
    ["projectedMonthlyCostMicrousd", "costPer1000JobsMicrousd"],
  );
  assertNonNegativeSafeInteger(receipt.projectedMonthlyCostMicrousd, "projected monthly cost");
  assertNonNegativeSafeInteger(receipt.costPer1000JobsMicrousd, "cost per 1000 jobs");
  if (receipt.projectedMonthlyCostMicrousd > 5_000_000 || receipt.costPer1000JobsMicrousd > 500_000)
    throw new TypeError("cost evidence exceeds the release ceiling");
  return true;
}

function rollbackReceipt(value, reportSha256) {
  const keys = [
    "workerRestored",
    "imageEngineRestored",
    "pdfEngineRestored",
    "configRestored",
    "policyRestored",
    "queuesRestored",
  ];
  const receipt = commonReceipt(
    value,
    reportSha256,
    "rollback evidence",
    "hereisit-pdf-rollback-receipt@1",
    keys,
  );
  if (keys.some((key) => receipt[key] !== true))
    throw new TypeError("rollback evidence did not prove the exact release state");
  return true;
}

export async function createPdfPublicAdmissionState({
  reportPath,
  deletionEvidencePath,
  costEvidencePath,
  rollbackEvidencePath,
  output,
}) {
  const { bytes: reportBytes, value: report } = await readJson(
    reportPath,
    1024 * 1024,
    "release report",
  );
  validateProcessingReleaseReport(report);
  if (report.schema !== "hereisit-processing-release-report@2")
    throw new TypeError("PDF public admission requires release report @2");
  const reportSha256 = sha256Bytes(reportBytes);
  const visualProfilesMeasured = report.artifacts.pdfVisualProfilesMeasured;
  const reportReady =
    report.artifacts.pdfPublicAdmissionReady === true && visualProfilesMeasured > 0;
  let deletionPassed = false,
    costPassed = false,
    rollbackPassed = false;
  if (reportReady) {
    deletionPassed = deletionReceipt(
      (await readJson(deletionEvidencePath, 1024 * 1024, "deletion evidence")).value,
      reportSha256,
    );
    costPassed = costReceipt(
      (await readJson(costEvidencePath, 1024 * 1024, "cost evidence")).value,
      reportSha256,
    );
    rollbackPassed = rollbackReceipt(
      (await readJson(rollbackEvidencePath, 1024 * 1024, "rollback evidence")).value,
      reportSha256,
    );
  }
  const state = {
    schema: "hereisit-pdf-public-admission@1",
    enabled: reportReady && deletionPassed && costPassed && rollbackPassed,
    releaseReportSha256: reportSha256,
    visualProfilesMeasured,
    deletionPassed,
    costPassed,
    rollbackPassed,
  };
  await writeCanonicalJsonAtomic(output, state, { refuseOverwrite: true, mode: 0o600 });
  return state;
}

export async function runPdfPublicAdmissionStateCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const keys = ["report", "deletion-evidence", "cost-evidence", "rollback-evidence", "output"];
  if (Object.keys(args).sort().join(",") !== keys.sort().join(","))
    throw new TypeError("PDF public admission arguments are invalid");
  const value = await createPdfPublicAdmissionState({
    reportPath: args.report,
    deletionEvidencePath: args["deletion-evidence"],
    costEvidencePath: args["cost-evidence"],
    rollbackEvidencePath: args["rollback-evidence"],
    output: args.output,
  });
  stdout.write(canonicalJson(value));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await runPdfPublicAdmissionStateCli(process.argv.slice(2));
