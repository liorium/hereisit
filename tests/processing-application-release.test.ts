import { describe, expect, it } from "vitest";
import {
  createProcessingApplicationRelease,
  validateProcessingApplicationRelease,
} from "../scripts/processing-application-release.mjs";

const sha = (value: string) => value.repeat(64);

function artifact(name: string, value: string) {
  return {
    path: `.artifacts/application/${name}`,
    sizeBytes: 1024,
    sha256: sha(value),
  };
}

function input() {
  return {
    gitSha: "a".repeat(40),
    baseReleaseReportSha256: sha("b"),
    worker: artifact("api-worker.mjs", "c"),
    web: {
      staging: { ...artifact("web-staging.tar", "d"), treeSha256: sha("e") },
      production: { ...artifact("web-production.tar", "f"), treeSha256: sha("1") },
    },
    security: {
      sboms: {
        worker: artifact("worker.sbom.json", "2"),
        webStaging: artifact("web-staging.sbom.json", "3"),
        webProduction: artifact("web-production.sbom.json", "4"),
        lockfile: artifact("lockfile.sbom.json", "5"),
      },
      vulnerabilityReports: {
        worker: artifact("worker.trivy.json", "6"),
        webStaging: artifact("web-staging.trivy.json", "7"),
        webProduction: artifact("web-production.trivy.json", "8"),
        lockfile: artifact("lockfile.trivy.json", "9"),
      },
    },
    createdAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-08-16T00:00:00.000Z",
  };
}

const invalidMutations: ReadonlyArray<[string, (value: ReturnType<typeof input>) => void]> = [
  ["extra key", (value) => Object.assign(value, { extra: true })],
  ["engine identity", (value) => Object.assign(value, { engineDigest: sha("0") })],
  ["bad Git SHA", (value) => Object.assign(value, { gitSha: "main" })],
  ["path traversal", (value) => Object.assign(value.worker, { path: "../api-worker.mjs" })],
  [
    "URL path",
    (value) => Object.assign(value.web.staging, { path: "https://example.com/web.tar" }),
  ],
  [
    "expiry beyond one day",
    (value) => Object.assign(value, { expiresAt: "2026-08-16T00:00:00.001Z" }),
  ],
];

describe("processing application releases", () => {
  it("creates one strict canonical Worker and web-only manifest", () => {
    const release = createProcessingApplicationRelease(input());
    expect(validateProcessingApplicationRelease(release)).toEqual(release);
    expect(release).toMatchObject({
      schema: "hereisit-processing-application-release@1",
      version: 1,
      gitSha: "a".repeat(40),
      baseReleaseReportSha256: sha("b"),
      verificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(release)).not.toMatch(/engine|pdf/i);
  });

  it.each(invalidMutations)("rejects %s", (_name, mutate) => {
    const value = input();
    mutate(value);
    expect(() => createProcessingApplicationRelease(value)).toThrow();
  });

  it("rejects a flipped verification hash", () => {
    const release = createProcessingApplicationRelease(input());
    expect(() =>
      validateProcessingApplicationRelease({ ...release, verificationSha256: sha("0") }),
    ).toThrow(/verification/i);
  });
});
