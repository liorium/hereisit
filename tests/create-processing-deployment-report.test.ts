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
          passed: true,
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
      schema: "hereisit-processing-deployment-report@2",
      version: 2,
      passed: true,
      publicAdmissionReady: false,
    });
  });

  it("never authorizes public admission from canary evidence", () => {
    const value = { ...input(), publicAdmissionReady: true };
    expect(() => createProcessingDeploymentReport(value)).toThrow(/admission|receipt/i);
  });

  it("strictly parses report-bound receipts before projecting their hash", () => {
    const reportSha = sha("b");
    expect(
      validateProcessingDeploymentReceipt(
        "gate",
        {
          schema: "hereisit-processing-deployment-gate@1",
          version: 1,
          passed: true,
          verified: true,
        },
        reportSha,
      ),
    ).toMatchObject({ passed: true, verified: true });
    expect(() =>
      validateProcessingDeploymentReceipt(
        "gate",
        {
          schema: "hereisit-processing-deployment-gate@1",
          version: 1,
          passed: true,
          verified: false,
        },
        reportSha,
      ),
    ).toThrow(/did not pass/i);
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
