import { describe, expect, it } from "vitest";
import {
  createProcessingDeploymentReport,
  validateProcessingDeploymentReceipt,
  validateProcessingDeploymentReport,
} from "../scripts/create-processing-deployment-report.mjs";

const sha = (value: string) => value.repeat(64);

function input() {
  const schemas = {
    imageCanary: "hereisit-processing-production-canary-smoke@1",
    pdfCanary: "hereisit-processing-pdf-smoke@1",
    deletion: "hereisit-pdf-deletion-receipt@1",
    cost: "hereisit-pdf-cost-receipt@1",
    rollback: "hereisit-pdf-rollback-receipt@1",
    admission: "hereisit-pdf-public-admission@1",
    gate: "hereisit-processing-deployment-gate@1",
    policy: "hereisit-processing-production-canary-policy-smoke@1",
  };
  return {
    gitSha: "a".repeat(40),
    releaseReportSha256: sha("b"),
    worker: {
      activeVersionId: "00000000-0000-4000-8000-000000000001",
      moduleSha256: sha("c"),
      generatedConfigSha256: sha("d"),
    },
    engines: {
      imageDigest: `registry.cloudflare.com/${"e".repeat(32)}/hereisit-image-engine@sha256:${sha("f")}`,
      pdfDigest: `registry.cloudflare.com/${"e".repeat(32)}/hereisit-pdf-engine@sha256:${sha("0")}`,
    },
    deployment: {
      resourcesSha256: sha("1"),
      pagesTreeSha256: sha("2"),
      pagesDeploymentId: "00000000-0000-4000-8000-000000000002",
    },
    receipts: Object.fromEntries(
      Object.entries(schemas).map(([name, schema], index) => [
        name,
        {
          schema,
          sha256: String(index + 1).repeat(64),
          passed: name !== "admission" && !["cost", "rollback"].includes(name),
        },
      ]),
    ),
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

describe("final processing deployment report", () => {
  it("binds the immutable release, generated deployment, Pages, and all gate receipts", () => {
    const report = createProcessingDeploymentReport(input());
    expect(validateProcessingDeploymentReport(report)).toEqual(report);
    expect(report).toMatchObject({
      schema: "hereisit-processing-deployment-report@1",
      version: 1,
      passed: true,
      publicAdmissionReady: false,
    });
  });

  it("requires all public receipts when admission is enabled", () => {
    const value = input();
    value.receipts.admission.passed = true;
    expect(() => createProcessingDeploymentReport(value)).toThrow(/admission|receipt/i);
  });

  it("strictly parses report-bound receipts before projecting their hash", () => {
    const reportSha = sha("b");
    expect(
      validateProcessingDeploymentReceipt(
        "deletion",
        {
          schema: "hereisit-pdf-deletion-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256: reportSha,
          deleted: true,
          sweepPassed: true,
        },
        reportSha,
      ),
    ).toMatchObject({ passed: true, deleted: true });
    expect(() =>
      validateProcessingDeploymentReceipt(
        "deletion",
        {
          schema: "hereisit-pdf-deletion-receipt@1",
          version: 1,
          passed: true,
          releaseReportSha256: sha("c"),
          deleted: true,
          sweepPassed: true,
        },
        reportSha,
      ),
    ).toThrow(/exact release report/i);
    expect(() =>
      validateProcessingDeploymentReceipt(
        "policy",
        {
          schema: "hereisit-processing-production-canary-policy-smoke@1",
          passed: true,
          execution: "server",
          reason: "LOCAL_FALLBACK_REQUIRED",
          upload: false,
          queuesPaused: true,
        },
        reportSha,
      ),
    ).toThrow(/fail closed/i);
  });
});
