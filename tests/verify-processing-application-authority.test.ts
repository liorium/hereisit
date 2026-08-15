import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingDeploymentReport } from "../scripts/create-processing-deployment-report.mjs";
import { canonicalJson, sha256Bytes } from "../scripts/image-lab-common.mjs";
import { createProcessingApplicationRelease } from "../scripts/processing-application-release.mjs";
import { verifyProcessingApplicationAuthority } from "../scripts/verify-processing-application-authority.mjs";

const roots: string[] = [];
const sha = (value: string) => value.repeat(64);
const account = "a".repeat(32);

function artifact(name: string, value: string) {
  return { path: `.artifacts/application/${name}`, sizeBytes: 1, sha256: sha(value) };
}

function applicationRelease(baseReleaseReportSha256 = sha("b")) {
  return createProcessingApplicationRelease({
    gitSha: "1".repeat(40),
    baseReleaseReportSha256,
    worker: artifact("api-worker.mjs", "2"),
    web: {
      staging: { ...artifact("web-staging.tar", "3"), treeSha256: sha("4") },
      production: { ...artifact("web-production.tar", "5"), treeSha256: sha("6") },
    },
    security: {
      sboms: {
        worker: artifact("worker.sbom.json", "7"),
        webStaging: artifact("web-staging.sbom.json", "8"),
        webProduction: artifact("web-production.sbom.json", "9"),
        lockfile: artifact("lockfile.sbom.json", "a"),
      },
      vulnerabilityReports: {
        worker: artifact("worker.trivy.json", "b"),
        webStaging: artifact("web-staging.trivy.json", "c"),
        webProduction: artifact("web-production.trivy.json", "d"),
        lockfile: artifact("lockfile.trivy.json", "e"),
      },
    },
    createdAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-08-16T00:00:00.000Z",
  });
}

function baseReport() {
  const receipts = Object.fromEntries(
    [
      ["imageCanary", "hereisit-processing-production-canary-smoke@1", true],
      ["pdfCanary", "hereisit-processing-pdf-smoke@1", true],
      ["deletion", "hereisit-pdf-deletion-receipt@1", true],
      ["cost", "hereisit-pdf-cost-receipt@1", false],
      ["rollback", "hereisit-pdf-rollback-receipt@1", false],
      ["admission", "hereisit-pdf-public-admission@1", false],
      ["gate", "hereisit-processing-deployment-gate@1", true],
      ["policy", "hereisit-processing-production-canary-policy-smoke@1", true],
    ].map(([name, schema, passed], index) => [
      name,
      { schema, sha256: String(index + 1).repeat(64), passed },
    ]),
  );
  return createProcessingDeploymentReport({
    gitSha: "0".repeat(40),
    releaseReportSha256: sha("b"),
    worker: {
      activeVersionId: "00000000-0000-4000-8000-000000000001",
      moduleSha256: sha("c"),
      generatedConfigSha256: sha("d"),
    },
    engines: {
      imageDigest: `registry.cloudflare.com/${account}/hereisit-image-engine@sha256:${sha("e")}`,
      pdfDigest: `registry.cloudflare.com/${account}/hereisit-pdf-engine@sha256:${sha("f")}`,
    },
    deployment: {
      resourcesSha256: sha("1"),
      pagesTreeSha256: sha("2"),
      pagesDeploymentId: "00000000-0000-4000-8000-000000000002",
    },
    receipts,
    createdAt: "2026-08-14T00:00:00.000Z",
  });
}

function activeAttestation() {
  return {
    activeCount: 1,
    versionId: "00000000-0000-4000-8000-000000000001",
    workerModuleSha256: sha("c"),
    generatedConfigSha256: sha("d"),
    releaseReportSha256: sha("b"),
    publicAdmissionAllowed: 1,
  };
}

function actualResources() {
  const report = baseReport();
  return {
    imageEngineDigest: report.engines.imageDigest,
    pdfEngineDigest: report.engines.pdfDigest,
    resourcesSha256: report.deployment.resourcesSha256,
    pdfPublicAdmissionEnabled: false,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-application-authority-"));
  roots.push(root);
  const manifestPath = join(root, "application.json");
  const baseReportPath = join(root, "base-report.json");
  await writeFile(manifestPath, canonicalJson(applicationRelease()));
  await writeFile(baseReportPath, canonicalJson(baseReport()));
  return { root, manifestPath, baseReportPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("processing application authority", () => {
  it("inherits the exact active engines, resources, config, cost authority, and PDF admission", async () => {
    const files = await fixture();
    const verify = vi.fn(async ({ bundlePath }: { bundlePath: string }) => ({
      bundleSha256: sha256Bytes(await readFile(bundlePath)),
      signatureSha256: sha("9"),
    }));
    await expect(
      verifyProcessingApplicationAuthority(
        {
          ...files,
          manifestSignaturePath: join(files.root, "application.sig"),
          baseReportSignaturePath: join(files.root, "base.sig"),
          publicKeyPath: join(files.root, "public.pem"),
          activeAttestation: activeAttestation(),
          actualResources: actualResources(),
          now: "2026-08-15T12:00:00.000Z",
        },
        verify,
      ),
    ).resolves.toMatchObject({
      schema: "hereisit-processing-application-authority@1",
      passed: true,
      gitSha: "1".repeat(40),
      priorWorkerVersionId: "00000000-0000-4000-8000-000000000001",
      nextWorkerModuleSha256: sha("2"),
      imageEngineDigest: expect.stringContaining("hereisit-image-engine@sha256:"),
      pdfPublicAdmissionEnabled: false,
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "changed image engine",
      () => ({ actualResources: { ...actualResources(), imageEngineDigest: "changed" } }),
    ],
    [
      "changed PDF engine",
      () => ({ actualResources: { ...actualResources(), pdfEngineDigest: "changed" } }),
    ],
    [
      "changed resources",
      () => ({ actualResources: { ...actualResources(), resourcesSha256: sha("0") } }),
    ],
    [
      "PDF admission transition",
      () => ({ actualResources: { ...actualResources(), pdfPublicAdmissionEnabled: true } }),
    ],
    ["inactive Worker", () => ({ activeAttestation: { ...activeAttestation(), activeCount: 0 } })],
    [
      "changed generated config",
      () => ({ activeAttestation: { ...activeAttestation(), generatedConfigSha256: sha("0") } }),
    ],
    [
      "changed base release",
      () => ({ activeAttestation: { ...activeAttestation(), releaseReportSha256: sha("0") } }),
    ],
  ])("rejects %s", async (_name, change) => {
    const files = await fixture();
    await expect(
      verifyProcessingApplicationAuthority(
        {
          ...files,
          manifestSignaturePath: join(files.root, "application.sig"),
          baseReportSignaturePath: join(files.root, "base.sig"),
          publicKeyPath: join(files.root, "public.pem"),
          activeAttestation: activeAttestation(),
          actualResources: actualResources(),
          now: "2026-08-15T12:00:00.000Z",
          ...change(),
        },
        async ({ bundlePath }) => ({
          bundleSha256: sha256Bytes(await readFile(bundlePath)),
          signatureSha256: sha("9"),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects expiry and a signature projection for different bytes", async () => {
    const files = await fixture();
    const common = {
      ...files,
      manifestSignaturePath: join(files.root, "application.sig"),
      baseReportSignaturePath: join(files.root, "base.sig"),
      publicKeyPath: join(files.root, "public.pem"),
      activeAttestation: activeAttestation(),
      actualResources: actualResources(),
    };
    await expect(
      verifyProcessingApplicationAuthority(
        { ...common, now: "2026-08-16T00:00:00.001Z" },
        async ({ bundlePath }) => ({
          bundleSha256: sha256Bytes(await readFile(bundlePath)),
          signatureSha256: sha("9"),
        }),
      ),
    ).rejects.toThrow(/expired/i);
    await expect(
      verifyProcessingApplicationAuthority(
        { ...common, now: "2026-08-15T12:00:00.000Z" },
        async () => ({ bundleSha256: sha("0"), signatureSha256: sha("9") }),
      ),
    ).rejects.toThrow(/signature|bytes/i);
  });
});
