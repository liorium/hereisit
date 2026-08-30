import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPdfDeploymentReceipts } from "../scripts/create-pdf-deployment-receipts.mjs";
import { canonicalJson, sha256Bytes } from "../scripts/image-lab-common.mjs";

const smoke = {
  schema: "hereisit-processing-pdf-smoke@1",
  version: 1,
  passed: true,
  deleted: true,
  sweepPassed: true,
};

describe("PDF deployment receipts", () => {
  it("uses report-bound cost and rollback evidence when supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-receipts-"));
    try {
      const reportPath = join(root, "report.json");
      await writeFile(reportPath, '{"release":"test"}\n');
      const releaseReportSha256 = sha256Bytes(await readFile(reportPath));
      const costEvidencePath = join(root, "cost-evidence.json");
      const rollbackEvidencePath = join(root, "rollback-evidence.json");
      await writeFile(
        costEvidencePath,
        canonicalJson({
          schema: "hereisit-pdf-cost-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256,
          projectedMonthlyCostMicrousd: 4_000_000,
          costPer1000JobsMicrousd: 400_000,
        }),
      );
      await writeFile(
        rollbackEvidencePath,
        canonicalJson({
          schema: "hereisit-pdf-rollback-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256,
          workerRestored: true,
          imageEngineRestored: true,
          pdfEngineRestored: true,
          configRestored: true,
          policyRestored: true,
          queuesRestored: true,
        }),
      );

      const receipts = await createPdfDeploymentReceipts({
        report: reportPath,
        smoke: await writeJson(root, "smoke.json", smoke),
        costEvidencePath,
        rollbackEvidencePath,
        output: join(root, "receipts"),
      });

      expect(receipts["pdf-cost-receipt.json"]).toMatchObject({
        passed: true,
        releaseReportSha256,
        projectedMonthlyCostMicrousd: 4_000_000,
        costPer1000JobsMicrousd: 400_000,
      });
      expect(receipts["pdf-rollback-receipt.json"]).toMatchObject({
        passed: true,
        releaseReportSha256,
        workerRestored: true,
        queuesRestored: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps missing evidence fail closed for backward-compatible canaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-receipts-disabled-"));
    try {
      const reportPath = join(root, "report.json");
      await writeFile(reportPath, '{"release":"test"}\n');
      const receipts = await createPdfDeploymentReceipts({
        report: reportPath,
        smoke: await writeJson(root, "smoke.json", smoke),
        output: join(root, "receipts"),
      });
      expect(receipts["pdf-cost-receipt.json"].passed).toBe(false);
      expect(receipts["pdf-rollback-receipt.json"].passed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unbound or extra evidence fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-receipts-invalid-"));
    try {
      const reportPath = join(root, "report.json");
      await writeFile(reportPath, '{"release":"test"}\n');
      const smokePath = await writeJson(root, "smoke.json", smoke);
      const invalidCostPath = join(root, "invalid-cost.json");
      await writeFile(
        invalidCostPath,
        canonicalJson({
          schema: "hereisit-pdf-cost-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256: "0".repeat(64),
          projectedMonthlyCostMicrousd: 1,
          costPer1000JobsMicrousd: 1,
          privateUrl: "https://example.invalid/secret",
        }),
      );
      await expect(
        createPdfDeploymentReceipts({
          report: reportPath,
          smoke: smokePath,
          costEvidencePath: invalidCostPath,
          output: join(root, "receipts"),
        }),
      ).rejects.toThrow(/cost evidence|field|bound|hash/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeJson(root: string, name: string, value: unknown) {
  const path = join(root, name);
  await writeFile(path, canonicalJson(value));
  return path;
}
