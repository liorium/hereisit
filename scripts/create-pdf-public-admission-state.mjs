import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateProcessingReleaseReport } from "./create-processing-release-report.mjs";
import {
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

function evidencePassed(value, reportSha256, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.passed !== true ||
    value.releaseReportSha256 !== reportSha256
  ) {
    throw new TypeError(`${label} is not passed and bound to the exact release report`);
  }
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
    deletionPassed = evidencePassed(
      (await readJson(deletionEvidencePath, 1024 * 1024, "deletion evidence")).value,
      reportSha256,
      "deletion evidence",
    );
    costPassed = evidencePassed(
      (await readJson(costEvidencePath, 1024 * 1024, "cost evidence")).value,
      reportSha256,
      "cost evidence",
    );
    rollbackPassed = evidencePassed(
      (await readJson(rollbackEvidencePath, 1024 * 1024, "rollback evidence")).value,
      reportSha256,
      "rollback evidence",
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
