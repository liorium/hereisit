import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPdfPublicAdmissionState } from "../scripts/create-pdf-public-admission-state.mjs";
import { canonicalJson } from "../scripts/image-lab-common.mjs";

const reportHash = async (path: string) => {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
};

describe("PDF public-admission release gate", () => {
  it("keeps current false visual evidence fail closed without trusting auxiliary assertions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-admission-"));
    try {
      const reportPath = join(root, "report.json"),
        output = join(root, "state.json");
      const { createReportFixture } = await import("./fixtures/processing-release-report-fixture");
      await writeFile(
        reportPath,
        canonicalJson(
          createReportFixture({ visualProfilesMeasured: 0, publicAdmissionReady: false }),
        ),
      );
      const state = await createPdfPublicAdmissionState({
        reportPath,
        deletionEvidencePath: join(root, "missing-delete"),
        costEvidencePath: join(root, "missing-cost"),
        rollbackEvidencePath: join(root, "missing-rollback"),
        output,
      });
      expect(state).toMatchObject({
        enabled: false,
        visualProfilesMeasured: 0,
        deletionPassed: false,
        costPassed: false,
        rollbackPassed: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enables admission only from exact strict release-bound deletion, cost, and rollback receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-admission-ready-"));
    try {
      const reportPath = join(root, "report.json"),
        output = join(root, "state.json");
      const { createReportFixture } = await import("./fixtures/processing-release-report-fixture");
      await writeFile(
        reportPath,
        canonicalJson(
          createReportFixture({ visualProfilesMeasured: 1, publicAdmissionReady: true }),
        ),
      );
      const releaseReportSha256 = await reportHash(reportPath);
      const paths = {
        deletionEvidencePath: join(root, "deletion.json"),
        costEvidencePath: join(root, "cost.json"),
        rollbackEvidencePath: join(root, "rollback.json"),
      };
      await writeFile(
        paths.deletionEvidencePath,
        canonicalJson({
          schema: "hereisit-pdf-deletion-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256,
          deleted: true,
          sweepPassed: true,
        }),
      );
      await writeFile(
        paths.costEvidencePath,
        canonicalJson({
          schema: "hereisit-pdf-cost-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256,
          projectedMonthlyCostMicrousd: 5_000_000,
          costPer1000JobsMicrousd: 500_000,
        }),
      );
      await writeFile(
        paths.rollbackEvidencePath,
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
      const state = await createPdfPublicAdmissionState({ reportPath, output, ...paths });
      expect(state).toEqual({
        schema: "hereisit-pdf-public-admission@1",
        enabled: true,
        releaseReportSha256,
        visualProfilesMeasured: 1,
        deletionPassed: true,
        costPassed: true,
        rollbackPassed: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects abbreviated, extra, over-budget, or report-drifted receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-admission-invalid-"));
    try {
      const reportPath = join(root, "report.json");
      const { createReportFixture } = await import("./fixtures/processing-release-report-fixture");
      await writeFile(
        reportPath,
        canonicalJson(
          createReportFixture({ visualProfilesMeasured: 1, publicAdmissionReady: true }),
        ),
      );
      const releaseReportSha256 = await reportHash(reportPath);
      const invalid = [
        { passed: true, releaseReportSha256 },
        {
          schema: "hereisit-pdf-deletion-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256,
          deleted: true,
          sweepPassed: true,
          privateUrl: "secret",
        },
      ];
      for (const [index, value] of invalid.entries()) {
        const path = join(root, `invalid-${index}.json`);
        await writeFile(path, canonicalJson(value));
        await expect(
          createPdfPublicAdmissionState({
            reportPath,
            deletionEvidencePath: path,
            costEvidencePath: path,
            rollbackEvidencePath: path,
            output: join(root, `output-${index}.json`),
          }),
        ).rejects.toThrow(/evidence|receipt|field|schema/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
