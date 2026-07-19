import { describe, expect, it } from "vitest";
import { verifyWorkerVersionChain } from "../scripts/verify-worker-version-chain.mjs";

const ids = {
  prior: "00000000-0000-0000-0000-000000000001",
  bootstrap: "00000000-0000-0000-0000-000000000002",
  secret1: "00000000-0000-0000-0000-000000000003",
  secret2: "00000000-0000-0000-0000-000000000004",
  secret3: "00000000-0000-0000-0000-000000000005",
  secret4: "00000000-0000-0000-0000-000000000006",
  final: "00000000-0000-0000-0000-000000000007",
};

function cloudflareVersion(id: string, number: number, trigger: "upload" | "secret") {
  const timestamp = `2026-07-19T00:0${number}:00.123456Z`;
  return {
    id,
    number,
    metadata: {
      author_email: "deployment@example.invalid",
      author_id: "a".repeat(32),
      created_on: timestamp,
      hasPreview: true,
      modified_on: timestamp,
      source: "wrangler",
    },
    annotations: { "workers/triggered_by": trigger },
  };
}

const versions = {
  prior: cloudflareVersion(ids.prior, 1, "upload"),
  bootstrap: cloudflareVersion(ids.bootstrap, 2, "upload"),
  secret1: cloudflareVersion(ids.secret1, 3, "secret"),
  secret2: cloudflareVersion(ids.secret2, 4, "secret"),
  secret3: cloudflareVersion(ids.secret3, 5, "secret"),
  secret4: cloudflareVersion(ids.secret4, 6, "secret"),
  final: cloudflareVersion(ids.final, 7, "upload"),
};

const hashes = {
  workerModuleSha256: "a".repeat(64),
  generatedConfigSha256: "b".repeat(64),
  releaseReportSha256: "c".repeat(64),
};

function validInput() {
  return {
    snapshots: {
      before: [versions.prior],
      afterBootstrap: [versions.prior, versions.bootstrap],
      afterSecrets: [
        versions.prior,
        versions.bootstrap,
        versions.secret1,
        versions.secret2,
        versions.secret3,
        versions.secret4,
      ],
      afterFinal: [
        versions.prior,
        versions.bootstrap,
        versions.secret1,
        versions.secret2,
        versions.secret3,
        versions.secret4,
        versions.final,
      ],
    },
    bootstrapDeployment: { version_id: ids.bootstrap },
    finalDeployment: { version_id: ids.final },
    bootstrapHashes: hashes,
    finalHashes: hashes,
    publicAdmissionPercent: 0,
    verifiedAt: "2026-07-19T00:08:00.000Z",
  };
}

describe("Worker version chain verifier", () => {
  it("attests one bootstrap, four secret intermediates, and one active final version", () => {
    expect(verifyWorkerVersionChain(validInput())).toEqual({
      schema: "hereisit-worker-version-attestations@1",
      version: 1,
      verifiedAt: "2026-07-19T00:08:00.000Z",
      workerModuleSha256: hashes.workerModuleSha256,
      generatedConfigSha256: hashes.generatedConfigSha256,
      releaseReportSha256: hashes.releaseReportSha256,
      activeVersionId: ids.final,
      previousActive: {
        versionId: ids.prior,
        state: "retiring",
        retireAfter: "2026-07-19T00:18:00.000Z",
      },
      versions: [
        { versionId: ids.bootstrap, state: "bootstrap", publicAdmissionPercent: 0 },
        { versionId: ids.secret1, state: "secret-intermediate", publicAdmissionPercent: 0 },
        { versionId: ids.secret2, state: "secret-intermediate", publicAdmissionPercent: 0 },
        { versionId: ids.secret3, state: "secret-intermediate", publicAdmissionPercent: 0 },
        { versionId: ids.secret4, state: "secret-intermediate", publicAdmissionPercent: 0 },
        { versionId: ids.final, state: "active", publicAdmissionPercent: 0 },
      ],
    });
  });

  it("rejects an unexplained version in any transition", () => {
    const input = validInput();
    input.snapshots.afterBootstrap.push(versions.secret1);
    expect(() => verifyWorkerVersionChain(input)).toThrow(/transition|unexplained/i);
  });

  it("rejects a final deployment without the exact Version Metadata ID", () => {
    expect(() =>
      verifyWorkerVersionChain({
        ...validInput(),
        finalDeployment: {},
      }),
    ).toThrow(/final.*version|metadata/i);
  });

  it("rejects a secret stage with a non-secret trigger", () => {
    const input = validInput();
    input.snapshots.afterSecrets[3] = cloudflareVersion(ids.secret2, 4, "upload");
    expect(() => verifyWorkerVersionChain(input)).toThrow(/secret/i);
  });

  it("rejects mutable module, config, or release hashes", () => {
    expect(() =>
      verifyWorkerVersionChain({
        ...validInput(),
        finalHashes: { ...hashes, generatedConfigSha256: "d".repeat(64) },
      }),
    ).toThrow(/hash|mutable/i);
  });

  it("rejects public admission during the intermediate chain", () => {
    expect(() => verifyWorkerVersionChain({ ...validInput(), publicAdmissionPercent: 1 })).toThrow(
      /admission|rollout/i,
    );
  });

  it("rejects unexpected plaintext in a strict snapshot", () => {
    const input = validInput();
    input.snapshots.afterFinal[6] = { ...versions.final, secret: "must-not-appear" };
    expect(() => verifyWorkerVersionChain(input)).toThrow(/field|snapshot/i);
  });

  it("rejects a new version created outside Wrangler", () => {
    const input = validInput();
    input.snapshots.afterFinal[6] = {
      ...versions.final,
      metadata: { ...versions.final.metadata, source: "api" },
    };
    expect(() => verifyWorkerVersionChain(input)).toThrow(/source|wrangler/i);
  });
});
