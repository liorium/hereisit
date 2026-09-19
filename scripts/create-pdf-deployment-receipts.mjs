import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const maximumReceiptBytes = 1024 * 1024;
const maximumCostPer1000JobsMicrousd = 500_000;
const maximumProjectedMonthlyCostMicrousd = 5_000_000;

async function readReceipt(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`${label} path is required`);
  }
  const bytes = await readBoundedRegularFile(resolve(path), maximumReceiptBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

function validateCostReceipt(value, releaseReportSha256) {
  const receipt = assertObject(value, "cost evidence");
  assertExactKeys(
    receipt,
    [
      "schema",
      "version",
      "passed",
      "releaseReportSha256",
      "projectedMonthlyCostMicrousd",
      "costPer1000JobsMicrousd",
    ],
    "cost evidence",
  );
  if (
    receipt.schema !== "hereisit-pdf-cost-receipt@1" ||
    receipt.version !== 1 ||
    typeof receipt.passed !== "boolean" ||
    receipt.releaseReportSha256 !== releaseReportSha256
  ) {
    throw new TypeError("cost evidence is not bound to the exact release report");
  }
  assertSha256(receipt.releaseReportSha256, "cost evidence release report hash");
  const projectedMonthlyCostMicrousd = assertNonNegativeSafeInteger(
    receipt.projectedMonthlyCostMicrousd,
    "cost evidence projected monthly cost",
  );
  const costPer1000JobsMicrousd = assertNonNegativeSafeInteger(
    receipt.costPer1000JobsMicrousd,
    "cost evidence cost per 1000 jobs",
  );
  if (
    projectedMonthlyCostMicrousd > maximumProjectedMonthlyCostMicrousd ||
    costPer1000JobsMicrousd > maximumCostPer1000JobsMicrousd
  ) {
    throw new TypeError("cost evidence exceeds the release ceiling");
  }
  return {
    schema: "hereisit-pdf-cost-receipt@1",
    version: 1,
    passed: receipt.passed,
    releaseReportSha256,
    projectedMonthlyCostMicrousd,
    costPer1000JobsMicrousd,
  };
}

function validateRollbackReceipt(value, releaseReportSha256) {
  const keys = [
    "workerRestored",
    "imageEngineRestored",
    "pdfEngineRestored",
    "configRestored",
    "policyRestored",
    "queuesRestored",
  ];
  const receipt = assertObject(value, "rollback evidence");
  assertExactKeys(
    receipt,
    ["schema", "version", "passed", "releaseReportSha256", ...keys],
    "rollback evidence",
  );
  if (
    receipt.schema !== "hereisit-pdf-rollback-receipt@1" ||
    receipt.version !== 1 ||
    typeof receipt.passed !== "boolean" ||
    receipt.releaseReportSha256 !== releaseReportSha256
  ) {
    throw new TypeError("rollback evidence is not bound to the exact release report");
  }
  assertSha256(receipt.releaseReportSha256, "rollback evidence release report hash");
  if (keys.some((key) => typeof receipt[key] !== "boolean")) {
    throw new TypeError("rollback evidence is invalid");
  }
  if (receipt.passed && keys.some((key) => receipt[key] !== true)) {
    throw new TypeError("rollback evidence did not prove the exact release state");
  }
  return {
    schema: "hereisit-pdf-rollback-receipt@1",
    version: 1,
    passed: receipt.passed,
    releaseReportSha256,
    ...Object.fromEntries(keys.map((key) => [key, receipt[key]])),
  };
}

export async function createPdfDeploymentReceipts({
  report,
  smoke,
  costEvidencePath,
  rollbackEvidencePath,
  output,
}) {
  const reportBytes = await readFile(resolve(report));
  const smokeValue = JSON.parse(await readFile(resolve(smoke), "utf8"));
  if (
    smokeValue.schema !== "hereisit-processing-pdf-smoke@1" ||
    smokeValue.version !== 1 ||
    smokeValue.passed !== true ||
    smokeValue.deleted !== true ||
    smokeValue.sweepPassed !== true
  )
    throw new TypeError("PDF deletion smoke did not pass");
  const releaseReportSha256 = sha256Bytes(reportBytes);
  const costReceipt =
    costEvidencePath === undefined
      ? {
          schema: "hereisit-pdf-cost-receipt@1",
          version: 1,
          passed: false,
          releaseReportSha256,
          projectedMonthlyCostMicrousd: 0,
          costPer1000JobsMicrousd: 0,
        }
      : validateCostReceipt(
          await readReceipt(costEvidencePath, "cost evidence"),
          releaseReportSha256,
        );
  const rollbackReceipt =
    rollbackEvidencePath === undefined
      ? {
          schema: "hereisit-pdf-rollback-receipt@1",
          version: 1,
          passed: false,
          releaseReportSha256,
          workerRestored: false,
          imageEngineRestored: false,
          pdfEngineRestored: false,
          configRestored: false,
          policyRestored: false,
          queuesRestored: false,
        }
      : validateRollbackReceipt(
          await readReceipt(rollbackEvidencePath, "rollback evidence"),
          releaseReportSha256,
        );
  const root = resolve(output);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const receipts = {
    "pdf-deletion-receipt.json": {
      schema: "hereisit-pdf-deletion-receipt@1",
      version: 1,
      passed: true,
      releaseReportSha256,
      deleted: true,
      sweepPassed: true,
    },
    "pdf-cost-receipt.json": costReceipt,
    "pdf-rollback-receipt.json": rollbackReceipt,
  };
  await Promise.all(
    Object.entries(receipts).map(([name, value]) =>
      writeCanonicalJsonAtomic(join(root, name), value, {
        refuseOverwrite: true,
        mode: 0o600,
      }),
    ),
  );
  return receipts;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = parseCliArguments(process.argv.slice(2));
  const required = ["report", "smoke", "output"];
  const allowed = new Set([...required, "cost-evidence", "rollback-evidence"]);
  if (
    required.some((key) => typeof args[key] !== "string") ||
    Object.keys(args).some((key) => !allowed.has(key))
  ) {
    throw new TypeError("PDF deployment receipt arguments are invalid");
  }
  const result = await createPdfDeploymentReceipts({
    report: args.report,
    smoke: args.smoke,
    costEvidencePath: args["cost-evidence"],
    rollbackEvidencePath: args["rollback-evidence"],
    output: args.output,
  });
  process.stdout.write(canonicalJson(result));
}
