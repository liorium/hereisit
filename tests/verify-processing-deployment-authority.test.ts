import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";
import { verifyProcessingDeploymentAuthority } from "../scripts/verify-processing-deployment-authority.mjs";

function report(schema = "hereisit-processing-release-report@2", version = 2) {
  const dual = version === 2;
  const payload = {
    schema,
    version,
    passed: true,
    releaseId: "2026-08-12.1",
    gitSha: "a".repeat(40),
    candidateVerificationSha256: "b".repeat(64),
    verifiedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-13T00:00:00.000Z",
    evidence: {
      bundleSha256: "c".repeat(64),
      signatureSha256: "d".repeat(64),
      reports: Object.fromEntries(
        [
          "fullCorpusBenchmark",
          "competitorComparison",
          "blindedHumanReview",
          "commercialReview",
          "privacyReview",
          "deviceMatrix",
        ].map((name) => [name, { sourceSha256: "e".repeat(64), summarySha256: "f".repeat(64) }]),
      ),
    },
    security: {
      trivyDbDigest: `sha256:${"1".repeat(64)}`,
      gates: {
        imageEngine: {
          path: "security-image-engine-license-gate.json",
          sizeBytes: 1,
          sha256: "2".repeat(64),
        },
        ...(dual
          ? {
              pdfEngine: {
                path: "security-pdf-engine-license-gate.json",
                sizeBytes: 1,
                sha256: "3".repeat(64),
              },
            }
          : {}),
        applicationSupplyChain: {
          path: "security-application-supply-chain-gate.json",
          sizeBytes: 1,
          sha256: "4".repeat(64),
        },
        vulnerability: {
          path: "security-vulnerability-gate.json",
          sizeBytes: 1,
          sha256: "5".repeat(64),
        },
      },
      sboms: {},
      vulnerabilityReports: {},
    },
    artifacts: {
      engineDockerConfigDigest: `sha256:${"6".repeat(64)}`,
      ...(dual
        ? {
            pdfEngineDockerConfigDigest: `sha256:${"7".repeat(64)}`,
            pdfBenchmarkSha256: "8".repeat(64),
            pdfReleaseGateSha256: "9".repeat(64),
            pdfVisualProfilesMeasured: 0,
            pdfPublicAdmissionReady: false,
          }
        : {}),
      webStagingArchiveSha256: "a".repeat(64),
      webProductionArchiveSha256: "b".repeat(64),
      workerSha256: "c".repeat(64),
      lockfileSha256: "d".repeat(64),
    },
  };
  const securityGroups = payload.security as typeof payload.security & {
    sboms: Record<string, unknown>;
    vulnerabilityReports: Record<string, unknown>;
  };
  for (const group of ["sboms", "vulnerabilityReports"] as const)
    for (const [key, scope] of [
      ["engine", "engine"],
      ...(dual ? [["pdfEngine", "pdf-engine"]] : []),
      ["webStaging", "web-staging"],
      ["webProduction", "web-production"],
      ["worker", "worker"],
      ["lockfile", "lockfile"],
    ] as string[][])
      securityGroups[group][key] = {
        path: `security-${group === "sboms" ? "sbom" : "trivy"}-${scope}.${group === "sboms" ? "cdx.json" : "json"}`,
        sizeBytes: 1,
        sha256: "e".repeat(64),
      };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

describe("deployment release authority", () => {
  it("accepts only exact verified @2 authority and returns the report file SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "authority-"));
    try {
      const path = join(root, "report.json");
      await writeFile(path, canonicalJson(report()));
      const verify = vi.fn(async () => ({
        gitSha: "a".repeat(40),
        releaseId: "2026-08-12.1",
        reportSha256: "f".repeat(64),
      }));
      const value = await verifyProcessingDeploymentAuthority(
        { reportPath: path, expectedGitSha: "a".repeat(40), expectedReportSha256: "f".repeat(64) },
        verify,
      );
      expect(value.reportSha256).toBe("f".repeat(64));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never authorizes a parseable @1 report for current deployment", async () => {
    const root = await mkdtemp(join(tmpdir(), "authority-"));
    try {
      const path = join(root, "report.json");
      await writeFile(path, canonicalJson(report("hereisit-processing-release-report@1", 1)));
      await expect(
        verifyProcessingDeploymentAuthority(
          {
            reportPath: path,
            expectedGitSha: "a".repeat(40),
            expectedReportSha256: "f".repeat(64),
          },
          vi.fn(),
        ),
      ).rejects.toThrow(/@2/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
