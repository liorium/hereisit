import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProcessingReleaseReport,
  validateProcessingReleaseReport,
  writeProcessingReleaseReport,
} from "../scripts/create-processing-release-report.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";

const temporaryRoots: string[] = [];
const names = [
  "fullCorpusBenchmark",
  "competitorComparison",
  "blindedHumanReview",
  "commercialReview",
  "privacyReview",
  "deviceMatrix",
] as const;
const scopes = ["engine", "webStaging", "webProduction", "worker", "lockfile"] as const;

function descriptor(path: string, digit: string) {
  return { path, sizeBytes: 10, sha256: digit.repeat(64) };
}

function inputs() {
  return {
    releaseId: "2026-07-20.1",
    gitSha: "a".repeat(40),
    candidateVerificationSha256: "b".repeat(64),
    verifiedAt: "2026-07-20T12:00:00.000Z",
    expiresAt: "2026-07-21T10:00:00.000Z",
    evidence: {
      bundleSha256: "c".repeat(64),
      signatureSha256: "d".repeat(64),
      reports: Object.fromEntries(
        names.map((name, index) => [
          name,
          { sourceSha256: `${index + 1}`.repeat(64), summarySha256: `${index + 2}`.repeat(64) },
        ]),
      ),
    },
    security: {
      trivyDbDigest: `sha256:${"e".repeat(64)}`,
      gates: {
        imageEngine: descriptor("security-image-engine-license-gate.json", "1"),
        applicationSupplyChain: descriptor("security-application-supply-chain-gate.json", "2"),
        vulnerability: descriptor("security-vulnerability-gate.json", "3"),
      },
      sboms: Object.fromEntries(
        scopes.map((scope, index) => [
          scope,
          descriptor(
            `security-sbom-${scope.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}.cdx.json`,
            String(index + 4),
          ),
        ]),
      ),
      vulnerabilityReports: Object.fromEntries(
        scopes.map((scope, index) => [
          scope,
          descriptor(
            `security-trivy-${scope.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}.json`,
            String(index + 1),
          ),
        ]),
      ),
    },
    artifacts: {
      engineDockerConfigDigest: `sha256:${"f".repeat(64)}`,
      webStagingArchiveSha256: "1".repeat(64),
      webProductionArchiveSha256: "2".repeat(64),
      workerSha256: "3".repeat(64),
      lockfileSha256: "4".repeat(64),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing release report creation", () => {
  it("publishes a strict schema for the exact report contract", async () => {
    const schema = JSON.parse(
      await readFile("docs/deployment/processing-release-report.schema.json", "utf8"),
    );
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        schema: { const: "hereisit-processing-release-report@1" },
        version: { const: 1 },
        passed: { const: true },
      },
    });
    expect(schema.required.sort()).toEqual(
      [
        "schema",
        "version",
        "passed",
        "releaseId",
        "gitSha",
        "candidateVerificationSha256",
        "verifiedAt",
        "expiresAt",
        "evidence",
        "security",
        "artifacts",
        "verificationSha256",
      ].sort(),
    );
  });

  it("creates one deterministic canonical report with an exact verification hash", () => {
    const first = createProcessingReleaseReport(inputs());
    const second = createProcessingReleaseReport(inputs());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: "hereisit-processing-release-report@1",
      version: 1,
      passed: true,
      releaseId: inputs().releaseId,
      gitSha: inputs().gitSha,
      candidateVerificationSha256: inputs().candidateVerificationSha256,
      verifiedAt: inputs().verifiedAt,
      expiresAt: inputs().expiresAt,
    });
    expect(Object.keys(first.evidence.reports).sort()).toEqual([...names].sort());
    const { verificationSha256, ...payload } = first;
    expect(verificationSha256).toBe(sha256Canonical(payload));
    expect(canonicalJson(first)).toBe(canonicalJson(validateProcessingReleaseReport(first)));
  });

  it("rejects unknown fields and mutation in every major binding group", () => {
    const base = createProcessingReleaseReport(inputs());
    const changes = [
      { ...base, releaseId: "2026-07-20.2" },
      { ...base, evidence: { ...base.evidence, bundleSha256: "0".repeat(64) } },
      {
        ...base,
        security: {
          ...base.security,
          gates: {
            ...base.security.gates,
            imageEngine: { ...base.security.gates.imageEngine, sha256: "0".repeat(64) },
          },
        },
      },
      {
        ...base,
        security: {
          ...base.security,
          sboms: {
            ...base.security.sboms,
            engine: { ...base.security.sboms.engine, sha256: "0".repeat(64) },
          },
        },
      },
      {
        ...base,
        security: {
          ...base.security,
          vulnerabilityReports: {
            ...base.security.vulnerabilityReports,
            worker: {
              ...base.security.vulnerabilityReports.worker,
              sha256: "0".repeat(64),
            },
          },
        },
      },
      { ...base, artifacts: { ...base.artifacts, workerSha256: "0".repeat(64) } },
      { ...base, verifiedAt: "2026-07-20T12:00:00Z" },
      { ...base, unexpected: true },
    ];

    for (const changed of changes) {
      expect(() => validateProcessingReleaseReport(changed)).toThrow();
    }
  });

  it("enforces candidate security descriptor size ceilings", () => {
    const report = createProcessingReleaseReport(inputs());
    for (const changed of [
      {
        ...report,
        security: {
          ...report.security,
          gates: {
            ...report.security.gates,
            imageEngine: { ...report.security.gates.imageEngine, sizeBytes: 1024 * 1024 + 1 },
          },
        },
      },
      {
        ...report,
        security: {
          ...report.security,
          sboms: {
            ...report.security.sboms,
            engine: { ...report.security.sboms.engine, sizeBytes: 8 * 1024 * 1024 + 1 },
          },
        },
      },
      {
        ...report,
        security: {
          ...report.security,
          vulnerabilityReports: {
            ...report.security.vulnerabilityReports,
            engine: {
              ...report.security.vulnerabilityReports.engine,
              sizeBytes: 8 * 1024 * 1024 + 1,
            },
          },
        },
      },
    ]) {
      const { verificationSha256: _verificationSha256, ...payload } = changed;
      expect(() =>
        validateProcessingReleaseReport({
          ...changed,
          verificationSha256: sha256Canonical(payload),
        }),
      ).toThrow(/size|limit/i);
    }
  });

  it("writes mode-0600 canonical bytes atomically and refuses overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-release-report-create-"));
    temporaryRoots.push(root);
    const output = join(root, "processing-release-report.json");
    const report = createProcessingReleaseReport(inputs());

    await expect(writeProcessingReleaseReport({ output, report })).resolves.toBe(
      report.verificationSha256,
    );
    expect(await readFile(output, "utf8")).toBe(canonicalJson(report));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(writeProcessingReleaseReport({ output, report })).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(canonicalJson(report));
  });

  it("rejects a report larger than one MiB", async () => {
    const value = { ...createProcessingReleaseReport(inputs()), padding: "x".repeat(1024 * 1024) };
    expect(() => validateProcessingReleaseReport(value)).toThrow(/field|size|exact/i);

    const root = await mkdtemp(join(tmpdir(), "hereisit-release-report-size-"));
    temporaryRoots.push(root);
    const output = join(root, "processing-release-report.json");
    await writeFile(output, JSON.stringify(value));
  });
});
