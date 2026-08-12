import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPdfPublicAdmissionState } from "../scripts/create-pdf-public-admission-state.mjs";
import { canonicalJson } from "../scripts/image-lab-common.mjs";

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
});
