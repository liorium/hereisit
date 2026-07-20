import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicTreeArchive } from "../scripts/create-deterministic-tree-archive.mjs";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  runProcessingCandidateVerifier,
  verifyProcessingCandidate,
} from "../scripts/verify-processing-candidate.mjs";

const releaseId = "2026-07-20.1";
const gitSha = "a".repeat(40);
const temporaryRoots: string[] = [];

async function createFixture() {
  const parent = await mkdtemp(join(tmpdir(), "hereisit-candidate-verifier-"));
  temporaryRoots.push(parent);
  const root = join(parent, "candidate");
  const build = join(parent, "build");
  await mkdir(root);
  await mkdir(build);

  const createWeb = async (environment: "staging" | "production") => {
    const tree = join(build, `web-${environment}`);
    await mkdir(tree);
    await writeFile(join(tree, "index.html"), `<h1>${environment}</h1>\n`);
    const archive = join(root, `web-${environment}.tar`);
    const result = await createDeterministicTreeArchive({ root: tree, output: archive });
    return { archive, ...result };
  };
  const staging = await createWeb("staging");
  const production = await createWeb("production");

  const fileBytes = {
    "processing-release-report.json": Buffer.from('{"passed":true}\n'),
    "image-engine-linux-amd64.oci.tar": Buffer.from("oci archive\n"),
    "image-engine-linux-amd64.docker.tar": Buffer.from("docker archive\n"),
    "api-worker.mjs": Buffer.from("export default {};\n"),
    [`evidence-v1--${releaseId}--processing-evidence.json`]: Buffer.from('{"signed":true}\n'),
    [`evidence-v1--${releaseId}--processing-evidence.sig`]: Buffer.from("signature\n"),
  };
  for (const [path, bytes] of Object.entries(fileBytes)) {
    await writeFile(join(root, path), bytes, { mode: 0o600 });
  }
  const artifact = (path: keyof typeof fileBytes) => ({
    path,
    sizeBytes: fileBytes[path].byteLength,
    sha256: sha256Bytes(fileBytes[path]),
  });
  const webIdentity = (environment: "staging" | "production", value: typeof staging) => ({
    archiveSha256: value.archiveSha256,
    treeSha256: value.treeSha256,
    processingApiOrigin: `https://hereisit-processing-${environment}.example.workers.dev`,
  });
  const stagingIdentity = webIdentity("staging", staging);
  const productionIdentity = webIdentity("production", production);
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha,
    engine: {
      loadedImage: `hereisit-image-engine:${gitSha}`,
      oci: {
        configDigest: `sha256:${"b".repeat(64)}`,
        layerDigests: [`sha256:${"c".repeat(64)}`],
      },
      docker: {
        configDigest: `sha256:${"b".repeat(64)}`,
        layerDigests: [`sha256:${"c".repeat(64)}`],
      },
    },
    web: { staging: stagingIdentity, production: productionIdentity },
    security: { trivyDbDigest: `sha256:${"d".repeat(64)}` },
    providerUsage: { schemaSha256: "e".repeat(64) },
    releaseAssets: {
      report: artifact("processing-release-report.json"),
      engine: {
        oci: artifact("image-engine-linux-amd64.oci.tar"),
        docker: artifact("image-engine-linux-amd64.docker.tar"),
      },
      worker: artifact("api-worker.mjs"),
      web: {
        staging: {
          path: "web-staging.tar",
          sizeBytes: (await readFile(staging.archive)).byteLength,
          ...stagingIdentity,
        },
        production: {
          path: "web-production.tar",
          sizeBytes: (await readFile(production.archive)).byteLength,
          ...productionIdentity,
        },
      },
      evidence: {
        bundle: artifact(`evidence-v1--${releaseId}--processing-evidence.json`),
        signature: artifact(`evidence-v1--${releaseId}--processing-evidence.sig`),
      },
    },
  };
  const candidate = {
    ...payload,
    verificationSha256: sha256Canonical(payload),
  };
  const manifestPath = join(root, "processing-candidate.json");
  await writeFile(manifestPath, canonicalJson(candidate), { mode: 0o600 });
  return { parent, root, manifestPath, candidate };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing candidate verifier", () => {
  it("verifies every release asset and both deterministic Pages trees", async () => {
    const fixture = await createFixture();

    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).resolves.toEqual({
      schema: "hereisit-processing-candidate-verification@1",
      version: 1,
      state: "finalized",
      releaseId,
      gitSha,
      assetCount: 8,
      web: {
        staging: expect.objectContaining({ treeSha256: fixture.candidate.web.staging.treeSha256 }),
        production: expect.objectContaining({
          treeSha256: fixture.candidate.web.production.treeSha256,
        }),
      },
    });
  });

  it.each([
    ["wrong required state", { requiredState: "built" }],
    ["wrong source SHA", { expectedGitSha: "f".repeat(40) }],
  ])("rejects %s", async (_label, override) => {
    const fixture = await createFixture();
    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
        ...override,
      }),
    ).rejects.toThrow(/state|SHA/i);
  });

  it("rejects changed asset bytes before claiming the candidate is verified", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "api-worker.mjs"), "tampered\n");
    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/Worker|size|hash/i);
  });

  it("rejects symbolic-link manifests, roots, and release assets", async () => {
    const manifestFixture = await createFixture();
    const manifestLink = join(manifestFixture.parent, "manifest-link.json");
    await symlink(manifestFixture.manifestPath, manifestLink);
    await expect(
      verifyProcessingCandidate({
        manifestPath: manifestLink,
        root: manifestFixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/manifest|root|symbolic|canonical/i);

    const rootFixture = await createFixture();
    const rootLink = join(rootFixture.parent, "root-link");
    await symlink(rootFixture.root, rootLink);
    await expect(
      verifyProcessingCandidate({
        manifestPath: join(rootLink, "processing-candidate.json"),
        root: rootLink,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/root|symbolic|canonical/i);

    const assetFixture = await createFixture();
    const workerPath = join(assetFixture.root, "api-worker.mjs");
    const workerBytes = await readFile(workerPath);
    await rm(workerPath);
    const outside = join(assetFixture.parent, "worker.mjs");
    await writeFile(outside, workerBytes);
    await symlink(outside, workerPath);
    await expect(
      verifyProcessingCandidate({
        manifestPath: assetFixture.manifestPath,
        root: assetFixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/Worker|symbolic|regular/i);
  });

  it("prints only a content-free verification summary at the CLI boundary", async () => {
    const fixture = await createFixture();
    const writes: string[] = [];
    await runProcessingCandidateVerifier(
      [
        "--manifest",
        fixture.manifestPath,
        "--root",
        fixture.root,
        "--required-state",
        "finalized",
        "--expected-git-sha",
        gitSha,
      ],
      {
        write(value: string) {
          writes.push(value);
        },
      },
    );
    expect(writes).toHaveLength(1);
    const summary = JSON.parse(writes[0]);
    expect(summary).toMatchObject({ state: "finalized", assetCount: 8 });
    expect(writes[0]).not.toContain("api-worker.mjs");
    expect(writes[0]).not.toContain(fixture.root);
  });
});
