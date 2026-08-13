import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  parseCliArguments,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

export async function createPdfDeploymentReceipts({ report, smoke, output }) {
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
    "pdf-cost-receipt.json": {
      schema: "hereisit-pdf-cost-receipt@1",
      version: 1,
      passed: false,
      releaseReportSha256,
      projectedMonthlyCostMicrousd: 0,
      costPer1000JobsMicrousd: 0,
    },
    "pdf-rollback-receipt.json": {
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
    },
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
  const result = await createPdfDeploymentReceipts({
    report: args.report,
    smoke: args.smoke,
    output: args.output,
  });
  process.stdout.write(canonicalJson(result));
}
