import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../scripts/image-lab-common.mjs";
import {
  captureWorkerArtifactHashWitnessFile,
  createWorkerAdmissionAttestationBatch,
  createWorkerArtifactHashWitness,
  createWorkerVersionAttestationBatch,
  finalizeWorkerVersionChainFiles,
  runWorkerVersionChainCli,
  verifyWorkerAdmissionTransition,
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
  public: "00000000-0000-0000-0000-000000000008",
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
  public: cloudflareVersion(ids.public, 8, "upload"),
};

const hashes = {
  workerModuleSha256: "a".repeat(64),
  generatedConfigSha256: "b".repeat(64),
  releaseReportSha256: "c".repeat(64),
};

function validInput() {
  return {
    snapshots: {
      before: [],
      afterBootstrap: [versions.bootstrap],
      afterSecrets: [
        versions.bootstrap,
        versions.secret1,
        versions.secret2,
        versions.secret3,
        versions.secret4,
      ],
      afterFinal: [
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
    previousActiveDeployment: { versions: [{ version_id: ids.prior, percentage: 100 }] },
    publicAdmissionPercent: 0,
    verifiedAt: "2026-07-19T00:08:00.000Z",
  };
}

function processingConfig(releaseReport: string, rollout: "0" | "100") {
  return `${JSON.stringify({
    name: "hereisit-processing-production",
    main: "dist/worker.mjs",
    version_metadata: { binding: "WORKER_VERSION" },
    vars: {
      IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: rollout,
      RELEASE_REPORT_SHA256: sha256Bytes(releaseReport),
      ENGINE_IMAGE_DIGEST: "sha256:engine",
      MAX_PROJECTED_MONTHLY_COST_MICROUSD: "5000000",
      MAX_LIVE_COST_PER_1000_MICROUSD: "500000",
      MAINTAINER_SESSION_HASHES: "[]",
      WEB_ORIGIN: "https://hereisit.app",
    },
    d1_databases: [{ binding: "DB", database_id: ids.prior }],
  })}\n`;
}

function admissionInput() {
  const workerModule = "export default { fetch() {} };\n";
  const releaseReport = '{"schema":"release@1"}\n';
  const currentConfig = processingConfig(releaseReport, "0");
  const nextConfig = processingConfig(releaseReport, "100");
  return {
    before: [versions.final],
    after: [versions.final, versions.public],
    deployment: { version_id: ids.public },
    beforeDeployment: { versions: [{ version_id: ids.final, percentage: 100 }] },
    afterDeployment: { versions: [{ version_id: ids.public, percentage: 100 }] },
    currentAttestation: {
      ...verifyWorkerVersionChain({
        ...validInput(),
        bootstrapHashes: {
          workerModuleSha256: sha256Bytes(workerModule),
          generatedConfigSha256: sha256Bytes(currentConfig),
          releaseReportSha256: sha256Bytes(releaseReport),
        },
        finalHashes: {
          workerModuleSha256: sha256Bytes(workerModule),
          generatedConfigSha256: sha256Bytes(currentConfig),
          releaseReportSha256: sha256Bytes(releaseReport),
        },
      }),
    },
    workerModule,
    currentConfig,
    nextConfig,
    releaseReport,
    fromPublicAdmissionPercent: 0,
    publicAdmissionPercent: 100,
    verifiedAt: "2026-08-10T00:09:00.000Z",
  };
}

describe("Worker version chain verifier", () => {
  it("attests the one-version rollout-zero to public transition", () => {
    expect(verifyWorkerAdmissionTransition(admissionInput())).toEqual({
      schema: "hereisit-worker-admission-transition@1",
      version: 1,
      verifiedAt: "2026-08-10T00:09:00.000Z",
      fromVersionId: ids.final,
      activeVersionId: ids.public,
      fromPublicAdmissionPercent: 0,
      publicAdmissionPercent: 100,
      workerModuleSha256: sha256Bytes(admissionInput().workerModule),
      previousConfigSha256: sha256Bytes(admissionInput().currentConfig),
      generatedConfigSha256: sha256Bytes(admissionInput().nextConfig),
      releaseReportSha256: sha256Bytes(admissionInput().releaseReport),
      versions: [{ versionId: ids.public, state: "active", publicAdmissionPercent: 100 }],
    });
  });

  it.each([
    ["a partial rollout", () => ({ publicAdmissionPercent: 5 })],
    [
      "a non-zero starting rollout",
      () => ({
        fromPublicAdmissionPercent: 100,
        currentConfig: processingConfig(admissionInput().releaseReport, "100"),
      }),
    ],
    [
      "an extra Worker version",
      () => ({ after: [versions.final, versions.public, versions.secret1] }),
    ],
    [
      "a non-Wrangler upload",
      () => ({
        after: [
          versions.final,
          { ...versions.public, metadata: { ...versions.public.metadata, source: "api" } },
        ],
      }),
    ],
    ["a deployment/version mismatch", () => ({ deployment: { version_id: ids.bootstrap } })],
    [
      "an inactive canary version",
      () => ({ beforeDeployment: { versions: [{ version_id: ids.bootstrap, percentage: 100 }] } }),
    ],
    [
      "a partial public deployment",
      () => ({
        afterDeployment: {
          versions: [
            { version_id: ids.final, percentage: 5 },
            { version_id: ids.public, percentage: 95 },
          ],
        },
      }),
    ],
    ["changed Worker bytes", () => ({ workerModule: "export default { changed: true };\n" })],
    ["changed release bytes", () => ({ releaseReport: "{}\n" })],
    [
      "a current config absent from the canary attestation",
      () => ({ currentConfig: `${admissionInput().currentConfig} ` }),
    ],
    [
      "a non-rollout config change",
      () => ({
        nextConfig: admissionInput().nextConfig.replace(
          '"MAX_PROJECTED_MONTHLY_COST_MICROUSD":"5000000"',
          '"MAX_PROJECTED_MONTHLY_COST_MICROUSD":"5000001"',
        ),
      }),
    ],
  ])("rejects %s", (_label, mutate) => {
    expect(() => verifyWorkerAdmissionTransition({ ...admissionInput(), ...mutate() })).toThrow();
  });

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
      verifyWorkerVersionChain({
        ...validInput(),
        previousActiveVersionId: null,
        previousActiveDeployment: { versions: [] },
      }).previousActive,
    ).toBeNull();
  });

  it("rejects a first-deployment claim while Cloudflare serves an active version", () => {
    expect(() =>
      verifyWorkerVersionChain({
        ...validInput(),
        previousActiveVersionId: null,
        previousActiveDeployment: validInput().previousActiveDeployment,
      }),
    ).toThrow(/first|previous|deployment/i);
  });

  it("rejects an attested predecessor not served at 100% before deployment", () => {
    expect(() =>
      verifyWorkerVersionChain({
        ...validInput(),
        previousActiveDeployment: {
          versions: [{ version_id: ids.bootstrap, percentage: 100 }],
        },
      }),
    ).toThrow(/deployment|active/i);
  });

  it("rejects unexpected plaintext in a strict snapshot", () => {
    const input = validInput();
    input.snapshots.afterFinal[5] = { ...versions.final, secret: "must-not-appear" };
    expect(() => verifyWorkerVersionChain(input)).toThrow(/field|snapshot/i);
  });

  it("rejects a new version created outside Wrangler", () => {
    const input = validInput();
    input.snapshots.afterFinal[5] = {
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

  it("retires the canary and persists only the new public active version", () => {
    const attestation = verifyWorkerAdmissionTransition(admissionInput());
    const batch = createWorkerAdmissionAttestationBatch(attestation);

    expect(batch.statements).toEqual([
      {
        sql: "UPDATE worker_version_attestations SET kind = ?, public_admission_allowed = 0, retired_at = ? WHERE version_id = ?",
        params: ["retired", Date.parse(attestation.verifiedAt), ids.final],
      },
      expect.objectContaining({
        params: [
          ids.public,
          attestation.workerModuleSha256,
          attestation.generatedConfigSha256,
          attestation.releaseReportSha256,
          "active",
          1,
          Date.parse(attestation.verifiedAt),
          null,
        ],
      }),
    ]);
    expect(batch.verification).toEqual([
      expect.objectContaining({
        params: [ids.final, ids.public],
        expected: [
          {
            versionId: ids.final,
            kind: "retired",
            publicAdmissionAllowed: 0,
            retiredAt: Date.parse(attestation.verifiedAt),
          },
          {
            versionId: ids.public,
            kind: "active",
            publicAdmissionAllowed: 1,
            retiredAt: null,
          },
        ],
      }),
      expect.objectContaining({
        params: [ids.public],
        expected: [
          {
            versionId: ids.public,
            workerModuleSha256: attestation.workerModuleSha256,
            generatedConfigSha256: attestation.generatedConfigSha256,
            releaseReportSha256: attestation.releaseReportSha256,
          },
        ],
      }),
    ]);
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
        "beforeDeployment",
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
        writeFile(
          paths.beforeDeployment,
          JSON.stringify(validInput().previousActiveDeployment),
          "utf8",
        ),
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
        previousActiveDeploymentFile: paths.beforeDeployment,
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
          "--before-deployment",
          paths.beforeDeployment,
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

  it("finalizes admission from bounded files into a private non-overwritten artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-worker-admission-"));
    const input = admissionInput();
    const paths = Object.fromEntries(
      [
        "before",
        "after",
        "deployment",
        "beforeDeployment",
        "afterDeployment",
        "attestation",
        "workerModule",
        "currentConfig",
        "nextConfig",
        "releaseReport",
        "output",
      ].map((name) => [name, join(directory, `${name}.json`)]),
    );
    try {
      await Promise.all([
        writeFile(paths.before, JSON.stringify(input.before), "utf8"),
        writeFile(paths.after, JSON.stringify(input.after), "utf8"),
        writeFile(paths.beforeDeployment, JSON.stringify(input.beforeDeployment), "utf8"),
        writeFile(paths.afterDeployment, JSON.stringify(input.afterDeployment), "utf8"),
        writeFile(
          paths.deployment,
          `${JSON.stringify({
            type: "deploy",
            version: 1,
            version_id: ids.public,
            targets: ["https://hereisit-processing-production.example.workers.dev"],
          })}\n`,
          "utf8",
        ),
        writeFile(paths.attestation, JSON.stringify(input.currentAttestation), "utf8"),
        writeFile(paths.workerModule, input.workerModule, "utf8"),
        writeFile(paths.currentConfig, input.currentConfig, "utf8"),
        writeFile(paths.nextConfig, input.nextConfig, "utf8"),
        writeFile(paths.releaseReport, input.releaseReport, "utf8"),
      ]);
      const argv = [
        "--mode",
        "finalize-admission",
        "--before",
        paths.before,
        "--after",
        paths.after,
        "--deployment-output",
        paths.deployment,
        "--before-deployment",
        paths.beforeDeployment,
        "--after-deployment",
        paths.afterDeployment,
        "--current-attestation",
        paths.attestation,
        "--worker-module",
        paths.workerModule,
        "--current-config",
        paths.currentConfig,
        "--next-config",
        paths.nextConfig,
        "--release-report",
        paths.releaseReport,
        "--output",
        paths.output,
      ];
      const result = await runWorkerVersionChainCli(argv, {
        now: () => new Date(input.verifiedAt),
      });
      expect(JSON.parse(await readFile(paths.output, "utf8"))).toEqual(result.attestation);
      expect((await stat(paths.output)).mode & 0o777).toBe(0o600);
      await expect(
        runWorkerVersionChainCli(argv, { now: () => new Date(input.verifiedAt) }),
      ).rejects.toThrow(/exist|overwrite/i);
      await expect(
        runWorkerVersionChainCli([...argv, "--token", "secret"], {
          now: () => new Date(input.verifiedAt),
        }),
      ).rejects.toThrow(/unknown.*argument/i);
      const reordered = [...argv];
      [reordered[2], reordered[4]] = [reordered[4], reordered[2]];
      [reordered[3], reordered[5]] = [reordered[5], reordered[3]];
      await expect(
        runWorkerVersionChainCli(reordered, { now: () => new Date(input.verifiedAt) }),
      ).rejects.toThrow(/order/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
