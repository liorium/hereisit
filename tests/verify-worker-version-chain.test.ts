import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../scripts/image-lab-common.mjs";
import {
  captureWorkerArtifactHashWitnessFile,
  createWorkerArtifactHashWitness,
  createWorkerVersionAttestationBatch,
  finalizeWorkerVersionChainFiles,
  runWorkerVersionChainCli,
  verifyWorkerArtifactHashWitness,
  verifyWorkerVersionChain,
} from "../scripts/verify-worker-version-chain.mjs";

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
      author_email: "",
      author_id: "a".repeat(32),
      created_on: timestamp,
      has_preview: false,
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
    previousActiveVersionId: ids.prior,
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

  it("never infers a previous active deployment from the newest listed version", () => {
    expect(
      verifyWorkerVersionChain({ ...validInput(), previousActiveVersionId: null }).previousActive,
    ).toBeNull();
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

  it("seals rollout-zero Worker, config, and release bytes at bootstrap", () => {
    const workerModule = "export default { fetch() {} };\n";
    const releaseReport = '{"schema":"release@1"}\n';
    const releaseReportSha256 = sha256Bytes(releaseReport);
    const generatedConfig = `${JSON.stringify({
      name: "hereisit-processing-staging",
      version_metadata: { binding: "WORKER_VERSION" },
      vars: {
        IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
        RELEASE_REPORT_SHA256: releaseReportSha256,
      },
    })}\n`;

    expect(
      createWorkerArtifactHashWitness({
        workerModule,
        generatedConfig,
        releaseReport,
        capturedAt: "2026-07-19T00:02:30.000Z",
      }),
    ).toEqual({
      schema: "hereisit-worker-artifact-hashes@1",
      version: 1,
      capturedAt: "2026-07-19T00:02:30.000Z",
      workerModuleSha256: sha256Bytes(workerModule),
      generatedConfigSha256: sha256Bytes(generatedConfig),
      releaseReportSha256,
    });
  });

  it("rejects a bootstrap witness when public rollout is enabled", () => {
    const releaseReport = "{}\n";
    expect(() =>
      createWorkerArtifactHashWitness({
        workerModule: "export default {};\n",
        generatedConfig: JSON.stringify({
          version_metadata: { binding: "WORKER_VERSION" },
          vars: {
            IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "1",
            RELEASE_REPORT_SHA256: sha256Bytes(releaseReport),
          },
        }),
        releaseReport,
        capturedAt: "2026-07-19T00:02:30.000Z",
      }),
    ).toThrow(/rollout|admission/i);
  });

  it("detects artifact mutation after the bootstrap witness", () => {
    const releaseReport = "{}\n";
    const generatedConfig = JSON.stringify({
      version_metadata: { binding: "WORKER_VERSION" },
      vars: {
        IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
        RELEASE_REPORT_SHA256: sha256Bytes(releaseReport),
      },
    });
    const witness = createWorkerArtifactHashWitness({
      workerModule: "export default {};\n",
      generatedConfig,
      releaseReport,
      capturedAt: "2026-07-19T00:02:30.000Z",
    });

    expect(() =>
      verifyWorkerArtifactHashWitness(witness, {
        workerModule: "export default { changed: true };\n",
        generatedConfig,
        releaseReport,
      }),
    ).toThrow(/mutable|hash|changed/i);
  });

  it("plans a parameterized D1 attestation batch without provider metadata", () => {
    const attestation = verifyWorkerVersionChain(validInput());
    const batch = createWorkerVersionAttestationBatch(attestation);

    expect(batch.version).toBe(1);
    expect(batch.statements).toHaveLength(7);
    expect(batch.statements[0]).toEqual({
      sql: "UPDATE worker_version_attestations SET kind = ?, public_admission_allowed = 0, retired_at = ? WHERE version_id = ?",
      params: ["retired", Date.parse("2026-07-19T00:18:00.000Z"), ids.prior],
    });
    expect(batch.statements.at(-1)).toMatchObject({
      params: [
        ids.final,
        hashes.workerModuleSha256,
        hashes.generatedConfigSha256,
        hashes.releaseReportSha256,
        "active",
        1,
        Date.parse("2026-07-19T00:08:00.000Z"),
        null,
      ],
    });
    expect(batch.verification[0]).toMatchObject({
      params: [
        ids.prior,
        ids.bootstrap,
        ids.secret1,
        ids.secret2,
        ids.secret3,
        ids.secret4,
        ids.final,
      ],
      expected: expect.arrayContaining([
        expect.objectContaining({ versionId: ids.prior, kind: "retired" }),
        expect.objectContaining({
          versionId: ids.final,
          kind: "active",
          publicAdmissionAllowed: 1,
        }),
      ]),
    });
    expect(batch.verification[1]).toMatchObject({
      params: [ids.bootstrap, ids.secret1, ids.secret2, ids.secret3, ids.secret4, ids.final],
      expected: expect.arrayContaining([
        expect.objectContaining({
          versionId: ids.final,
          workerModuleSha256: hashes.workerModuleSha256,
          generatedConfigSha256: hashes.generatedConfigSha256,
          releaseReportSha256: hashes.releaseReportSha256,
        }),
      ]),
    });
    expect(JSON.stringify(batch)).not.toMatch(
      /author|email|destination|token|filename|object_key/i,
    );
  });

  it("rejects a D1 batch with a mismatched active version", () => {
    const attestation = verifyWorkerVersionChain(validInput());
    expect(() =>
      createWorkerVersionAttestationBatch({ ...attestation, activeVersionId: ids.bootstrap }),
    ).toThrow(/active/i);
  });

  it("atomically captures a bounded bootstrap witness file without overwriting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-worker-witness-"));
    const workerModuleFile = join(directory, "worker.mjs");
    const configFile = join(directory, "wrangler.jsonc");
    const releaseReportFile = join(directory, "release.json");
    const outputFile = join(directory, "bootstrap-witness.json");
    const workerModule = "export default {};\n";
    const releaseReport = "{}\n";
    const generatedConfig = JSON.stringify({
      version_metadata: { binding: "WORKER_VERSION" },
      vars: {
        IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
        RELEASE_REPORT_SHA256: sha256Bytes(releaseReport),
      },
    });
    try {
      await Promise.all([
        writeFile(workerModuleFile, workerModule, "utf8"),
        writeFile(configFile, generatedConfig, "utf8"),
        writeFile(releaseReportFile, releaseReport, "utf8"),
      ]);
      await captureWorkerArtifactHashWitnessFile({
        workerModuleFile,
        configFile,
        releaseReportFile,
        outputFile,
        capturedAt: "2026-07-19T00:02:30.000Z",
      });
      const witness = JSON.parse(await readFile(outputFile, "utf8"));
      expect(witness.workerModuleSha256).toBe(sha256Bytes(workerModule));
      await expect(
        captureWorkerArtifactHashWitnessFile({
          workerModuleFile,
          configFile,
          releaseReportFile,
          outputFile,
          capturedAt: "2026-07-19T00:02:31.000Z",
        }),
      ).rejects.toThrow(/exist|overwrite/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finalizes bounded snapshots and deploy outputs against the bootstrap witness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-worker-finalize-"));
    const paths = Object.fromEntries(
      [
        "before",
        "afterBootstrap",
        "afterSecrets",
        "afterFinal",
        "bootstrapOutput",
        "finalOutput",
        "workerModule",
        "config",
        "releaseReport",
        "witness",
        "output",
        "cliOutput",
      ].map((name) => [name, join(directory, `${name}.json`)]),
    );
    const workerModule = "export default {};\n";
    const releaseReport = "{}\n";
    const generatedConfig = JSON.stringify({
      version_metadata: { binding: "WORKER_VERSION" },
      vars: {
        IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
        RELEASE_REPORT_SHA256: sha256Bytes(releaseReport),
      },
    });
    const snapshots = validInput().snapshots;
    const deployOutput = (versionId: string) =>
      `${JSON.stringify({
        type: "deploy",
        version: 1,
        version_id: versionId,
        targets: ["https://hereisit-processing-staging.example.workers.dev"],
      })}\n`;
    try {
      await Promise.all([
        writeFile(paths.before, JSON.stringify(snapshots.before), "utf8"),
        writeFile(paths.afterBootstrap, JSON.stringify(snapshots.afterBootstrap), "utf8"),
        writeFile(paths.afterSecrets, JSON.stringify(snapshots.afterSecrets), "utf8"),
        writeFile(paths.afterFinal, JSON.stringify(snapshots.afterFinal), "utf8"),
        writeFile(paths.bootstrapOutput, deployOutput(ids.bootstrap), "utf8"),
        writeFile(paths.finalOutput, deployOutput(ids.final), "utf8"),
        writeFile(paths.workerModule, workerModule, "utf8"),
        writeFile(paths.config, generatedConfig, "utf8"),
        writeFile(paths.releaseReport, releaseReport, "utf8"),
      ]);
      await captureWorkerArtifactHashWitnessFile({
        workerModuleFile: paths.workerModule,
        configFile: paths.config,
        releaseReportFile: paths.releaseReport,
        outputFile: paths.witness,
        capturedAt: "2026-07-19T00:02:30.000Z",
      });

      const result = await finalizeWorkerVersionChainFiles({
        beforeFile: paths.before,
        afterBootstrapFile: paths.afterBootstrap,
        afterSecretsFile: paths.afterSecrets,
        afterFinalFile: paths.afterFinal,
        bootstrapOutputFile: paths.bootstrapOutput,
        finalOutputFile: paths.finalOutput,
        bootstrapWitnessFile: paths.witness,
        workerModuleFile: paths.workerModule,
        configFile: paths.config,
        releaseReportFile: paths.releaseReport,
        outputFile: paths.output,
        previousActiveVersionId: ids.prior,
        verifiedAt: "2026-07-19T00:08:00.000Z",
      });

      expect(result.attestation.activeVersionId).toBe(ids.final);
      expect(result.batch.statements).toHaveLength(7);
      expect(JSON.parse(await readFile(paths.output, "utf8"))).toEqual(result.attestation);
      await runWorkerVersionChainCli(
        [
          "--mode",
          "finalize",
          "--before",
          paths.before,
          "--after-bootstrap",
          paths.afterBootstrap,
          "--after-secrets",
          paths.afterSecrets,
          "--after-final",
          paths.afterFinal,
          "--bootstrap-output",
          paths.bootstrapOutput,
          "--final-output",
          paths.finalOutput,
          "--bootstrap-witness",
          paths.witness,
          "--worker-module",
          paths.workerModule,
          "--config",
          paths.config,
          "--release-report",
          paths.releaseReport,
          "--output",
          paths.cliOutput,
          "--previous-active-version-id",
          ids.prior,
        ],
        { now: () => new Date("2026-07-19T00:08:00.000Z") },
      );
      expect(JSON.parse(await readFile(paths.cliOutput, "utf8"))).toEqual(result.attestation);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs bootstrap capture through a strict CLI mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-worker-cli-"));
    const workerModuleFile = join(directory, "worker.mjs");
    const configFile = join(directory, "wrangler.jsonc");
    const releaseReportFile = join(directory, "release.json");
    const outputFile = join(directory, "witness.json");
    const releaseReport = "{}\n";
    try {
      await Promise.all([
        writeFile(workerModuleFile, "export default {};\n", "utf8"),
        writeFile(
          configFile,
          JSON.stringify({
            version_metadata: { binding: "WORKER_VERSION" },
            vars: {
              IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
              RELEASE_REPORT_SHA256: sha256Bytes(releaseReport),
            },
          }),
          "utf8",
        ),
        writeFile(releaseReportFile, releaseReport, "utf8"),
      ]);
      await runWorkerVersionChainCli(
        [
          "--mode",
          "capture-bootstrap",
          "--worker-module",
          workerModuleFile,
          "--config",
          configFile,
          "--release-report",
          releaseReportFile,
          "--output",
          outputFile,
        ],
        { now: () => new Date("2026-07-19T00:02:30.000Z") },
      );
      expect(JSON.parse(await readFile(outputFile, "utf8"))).toMatchObject({
        schema: "hereisit-worker-artifact-hashes@1",
        capturedAt: "2026-07-19T00:02:30.000Z",
      });
      await expect(
        runWorkerVersionChainCli(["--mode", "capture-bootstrap", "--token", "no"]),
      ).rejects.toThrow(/argument|unknown/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
