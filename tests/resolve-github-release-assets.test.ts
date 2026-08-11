import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicTreeArchive } from "../scripts/create-deterministic-tree-archive.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";
import { resolveGitHubReleaseAssets } from "../scripts/resolve-github-release-assets.mjs";

const repository = "liorium/hereisit";
const releaseId = "2026-07-20.1";
const releaseTag = `processing-release-${releaseId}`;
const targetSha = "a".repeat(40);
const tagObjectSha = "b".repeat(40);
const temporaryRoots: string[] = [];
const securityScopes = [
  ["engine", "engine"],
  ["webStaging", "web-staging"],
  ["webProduction", "web-production"],
  ["worker", "worker"],
  ["lockfile", "lockfile"],
] as const;
const securityPaths = [
  "security-image-engine-license-gate.json",
  "security-application-supply-chain-gate.json",
  "security-vulnerability-gate.json",
  ...securityScopes.map(([, scope]) => `security-sbom-${scope}.cdx.json`),
  ...securityScopes.map(([, scope]) => `security-trivy-${scope}.json`),
];

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function securityAssets(files: Record<string, Uint8Array>) {
  const descriptor = (path: string) => ({
    path,
    sizeBytes: files[path].byteLength,
    sha256: sha256(files[path]),
  });
  const scoped = (prefix: string, suffix: string) =>
    Object.fromEntries(
      securityScopes.map(([key, scope]) => [key, descriptor(`${prefix}${scope}${suffix}`)]),
    );
  return {
    gates: {
      imageEngine: descriptor("security-image-engine-license-gate.json"),
      applicationSupplyChain: descriptor("security-application-supply-chain-gate.json"),
      vulnerability: descriptor("security-vulnerability-gate.json"),
    },
    sboms: scoped("security-sbom-", ".cdx.json"),
    vulnerabilityReports: scoped("security-trivy-", ".json"),
  };
}

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-release-resolver-"));
  temporaryRoots.push(root);
  return root;
}

async function createFixture({ wrongStagingTree = false } = {}) {
  const root = await temporaryDirectory();
  const candidateRoot = join(root, "candidate");
  const build = join(root, "build");
  await mkdir(candidateRoot);
  await mkdir(build);

  const createWeb = async (environment: "staging" | "production", body: string) => {
    const tree = join(build, `web-${environment}`);
    await mkdir(tree);
    await writeFile(join(tree, "index.html"), body);
    const archive = join(build, `web-${environment}.tar`);
    const result = await createDeterministicTreeArchive({ root: tree, output: archive });
    const bytes = await readFile(archive);
    return { bytes, archiveSha256: result.archiveSha256, treeSha256: result.treeSha256 };
  };
  const stagingWeb = await createWeb("staging", "<h1>staging</h1>\n");
  const productionWeb = await createWeb("production", "<h1>production</h1>\n");
  const files: Record<string, Buffer> = {
    "processing-release-report.json": Buffer.from('{"passed":true}\n'),
    "image-engine-linux-amd64.oci.tar": Buffer.from("canonical-oci\n"),
    "image-engine-linux-amd64.docker.tar": Buffer.from("loadable-docker\n"),
    "api-worker.mjs": Buffer.from('export default {fetch(){return new Response("ok")}};\n'),
    "processing-release-inputs.json": Buffer.from('{"release":true}\n'),
    "live-cost-model.json": Buffer.from('{"cost":true}\n'),
    "web-staging.tar": stagingWeb.bytes,
    "web-production.tar": productionWeb.bytes,
    [`evidence-v1--${releaseId}--processing-evidence.json`]: Buffer.from('{"signed":true}\n'),
    [`evidence-v1--${releaseId}--processing-evidence.sig`]: Buffer.from("signature\n"),
    ...Object.fromEntries(securityPaths.map((path) => [path, Buffer.from(`${path}\n`)])),
  };
  const identity = (path: string) => ({
    path,
    sizeBytes: files[path].byteLength,
    sha256: sha256(files[path]),
  });
  const candidatePayload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha: targetSha,
    engine: {
      loadedImage: `hereisit-image-engine:${targetSha}`,
      oci: {
        configDigest: `sha256:${"7".repeat(64)}`,
        distributionLayerDigests: [`sha256:${"8".repeat(64)}`],
        diffIds: [`sha256:${"9".repeat(64)}`],
      },
      docker: {
        configDigest: `sha256:${"7".repeat(64)}`,
        diffIds: [`sha256:${"9".repeat(64)}`],
      },
    },
    web: {
      staging: {
        archiveSha256: stagingWeb.archiveSha256,
        treeSha256: wrongStagingTree ? "9".repeat(64) : stagingWeb.treeSha256,
        processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
      },
      production: {
        archiveSha256: productionWeb.archiveSha256,
        treeSha256: productionWeb.treeSha256,
        processingApiOrigin: "https://api.hereisit.app",
      },
    },
    security: { trivyDbDigest: `sha256:${"a".repeat(64)}` },
    providerUsage: { schemaSha256: "b".repeat(64) },
    releaseInputs: { sha256: identity("processing-release-inputs.json").sha256 },
    costModel: { sha256: identity("live-cost-model.json").sha256 },
    releaseAssets: {
      report: identity("processing-release-report.json"),
      engine: {
        oci: identity("image-engine-linux-amd64.oci.tar"),
        docker: identity("image-engine-linux-amd64.docker.tar"),
      },
      worker: identity("api-worker.mjs"),
      releaseInputs: identity("processing-release-inputs.json"),
      costModel: identity("live-cost-model.json"),
      web: {
        staging: {
          path: "web-staging.tar",
          sizeBytes: stagingWeb.bytes.byteLength,
          archiveSha256: stagingWeb.archiveSha256,
          treeSha256: wrongStagingTree ? "9".repeat(64) : stagingWeb.treeSha256,
          processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
        },
        production: {
          path: "web-production.tar",
          sizeBytes: productionWeb.bytes.byteLength,
          archiveSha256: productionWeb.archiveSha256,
          treeSha256: productionWeb.treeSha256,
          processingApiOrigin: "https://api.hereisit.app",
        },
      },
      security: securityAssets(files),
      evidence: {
        bundle: identity(`evidence-v1--${releaseId}--processing-evidence.json`),
        signature: identity(`evidence-v1--${releaseId}--processing-evidence.sig`),
      },
    },
  };
  const candidate = {
    ...candidatePayload,
    verificationSha256: sha256Canonical(candidatePayload),
  };
  const candidateBytes = Buffer.from(canonicalJson(candidate));
  await writeFile(join(candidateRoot, "processing-candidate.json"), candidateBytes);
  const allFiles = { ...files, "processing-candidate.json": candidateBytes };
  return { root, candidateRoot, candidate, files: allFiles };
}

async function startGitHubServer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  {
    target = targetSha,
    extraAsset = false,
    changedWorkerBytes = false,
    securityMutation,
    onFirstDownload,
  }: {
    target?: string;
    extraAsset?: boolean;
    changedWorkerBytes?: boolean;
    securityMutation?:
      | "missing"
      | "renamed"
      | "duplicate-id"
      | "duplicate-name"
      | "wrong-size"
      | "wrong-hash"
      | "changed-bytes";
    onFirstDownload?: () => void;
  } = {},
) {
  const requests: Array<{ authorization?: string; path: string; version?: string }> = [];
  let origin = "";
  const suffixes = [
    "processing-candidate.json",
    "processing-release-report.json",
    "image-engine-linux-amd64.oci.tar",
    "image-engine-linux-amd64.docker.tar",
    "api-worker.mjs",
    "processing-release-inputs.json",
    "live-cost-model.json",
    "web-staging.tar",
    "web-production.tar",
    `evidence-v1--${releaseId}--processing-evidence.json`,
    `evidence-v1--${releaseId}--processing-evidence.sig`,
    ...securityPaths,
  ];
  const records = suffixes.map((suffix, index) => {
    const evidence = suffix.startsWith("evidence-v1--");
    const name = evidence ? suffix : `candidate-v1--${releaseId}--${suffix}`;
    const bytes = fixture.files[suffix];
    const id = 101 + index;
    return {
      id,
      name,
      size: bytes.byteLength,
      state: "uploaded",
      digest: `sha256:${sha256(bytes)}`,
      url: () => `${origin}/repos/${repository}/releases/assets/${id}`,
      browser_download_url: `https://github.com/${repository}/releases/download/${releaseTag}/${name}`,
      bytes,
    };
  });
  if (extraAsset) {
    records.push({
      id: 999,
      name: `candidate-v1--${releaseId}--unexpected.bin`,
      size: 1,
      state: "uploaded",
      digest: `sha256:${sha256(Buffer.from("x"))}`,
      url: () => `${origin}/repos/${repository}/releases/assets/999`,
      browser_download_url: "https://github.com/invalid",
      bytes: Buffer.from("x"),
    });
  }
  const securityRecord = records.find((record) => record.name.endsWith(securityPaths[0]));
  if (securityRecord === undefined) throw new Error("security record is missing from fixture");
  if (securityMutation === "missing") records.splice(records.indexOf(securityRecord), 1);
  if (securityMutation === "renamed") securityRecord.name += ".renamed";
  if (securityMutation === "duplicate-id") securityRecord.id = records[0].id;
  if (securityMutation === "duplicate-name") securityRecord.name = records[0].name;
  if (securityMutation === "wrong-size") securityRecord.size += 1;
  if (securityMutation === "wrong-hash") securityRecord.digest = `sha256:${"f".repeat(64)}`;

  let downloadStarted = false;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    requests.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
      version: request.headers["x-github-api-version"] as string | undefined,
    });
    const sendJson = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === `/repos/${repository}/releases/tags/${releaseTag}`) {
      sendJson({
        id: 9001,
        tag_name: releaseTag,
        draft: false,
        prerelease: false,
        url: `${origin}/repos/${repository}/releases/9001`,
        assets_url: `${origin}/repos/${repository}/releases/9001/assets`,
        html_url: `https://github.com/${repository}/releases/tag/${releaseTag}`,
      });
      return;
    }
    if (url.pathname === `/repos/${repository}/git/ref/tags/${releaseTag}`) {
      sendJson({ ref: `refs/tags/${releaseTag}`, object: { type: "tag", sha: tagObjectSha } });
      return;
    }
    if (url.pathname === `/repos/${repository}/git/tags/${tagObjectSha}`) {
      sendJson({
        tag: releaseTag,
        sha: tagObjectSha,
        object: { type: "commit", sha: target },
      });
      return;
    }
    if (url.pathname === `/repos/${repository}/releases/9001/assets`) {
      sendJson(
        Number(url.searchParams.get("page")) === 1
          ? records.map((record) => ({ ...record, url: record.url(), bytes: undefined }))
          : [],
      );
      return;
    }
    const apiAsset = records.find(
      (record) => url.pathname === `/repos/${repository}/releases/assets/${record.id}`,
    );
    if (apiAsset) {
      response.writeHead(302, { location: `${origin}/download/${apiAsset.id}` });
      response.end();
      return;
    }
    const download = records.find((record) => url.pathname === `/download/${record.id}`);
    if (download) {
      if (!downloadStarted) {
        downloadStarted = true;
        onFirstDownload?.();
      }
      const bytes =
        changedWorkerBytes && download.name.endsWith("api-worker.mjs")
          ? Buffer.alloc(download.bytes.byteLength, 0x78)
          : securityMutation === "changed-bytes" && download.name.endsWith(securityPaths[0])
            ? Buffer.alloc(download.bytes.byteLength, 0x78)
            : download.bytes;
      response.writeHead(200, { "content-length": String(bytes.byteLength) });
      response.end(bytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitHub release asset resolver", () => {
  it("binds an annotated source tag and every downloaded asset to the finalized candidate", async () => {
    const fixture = await createFixture();
    const server = await startGitHubServer(fixture);
    const output = join(fixture.root, "processing-release-assets.json");
    try {
      const result = await resolveGitHubReleaseAssets({
        repository,
        releaseTag,
        candidateRoot: fixture.candidateRoot,
        output,
        apiOrigin: server.origin,
        token: "test-token",
      });
      expect(result).toMatchObject({
        schema: "hereisit-processing-release-assets@1",
        repository,
        release: { id: 9001, tag: releaseTag, targetSha },
        worker: { assetId: 105, sha256: fixture.candidate.releaseAssets.worker.sha256 },
        web: {
          staging: { treeSha256: fixture.candidate.releaseAssets.web.staging.treeSha256 },
          production: { treeSha256: fixture.candidate.releaseAssets.web.production.treeSha256 },
        },
        security: {
          gates: {
            imageEngine: {
              sha256: fixture.candidate.releaseAssets.security.gates.imageEngine.sha256,
            },
          },
          sboms: {
            worker: { sha256: fixture.candidate.releaseAssets.security.sboms.worker.sha256 },
          },
          vulnerabilityReports: {
            lockfile: {
              sha256: fixture.candidate.releaseAssets.security.vulnerabilityReports.lockfile.sha256,
            },
          },
        },
      });
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(result);
      expect(
        server.requests
          .filter((request) => !request.path.startsWith("/download/"))
          .every(
            (request) =>
              request.authorization === "Bearer test-token" && request.version === "2026-03-10",
          ),
      ).toBe(true);
      expect(
        server.requests
          .filter((request) => request.path.startsWith("/download/"))
          .every((request) => request.authorization === undefined),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects an unknown release asset", async () => {
    const fixture = await createFixture();
    const server = await startGitHubServer(fixture, { extraAsset: true });
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output: join(fixture.root, "manifest.json"),
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(/unexpected|exact/i);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["missing", /exact|missing/i],
    ["renamed", /unexpected|missing/i],
    ["duplicate-id", /duplicated/i],
    ["duplicate-name", /duplicated/i],
    ["wrong-size", /metadata/i],
    ["wrong-hash", /metadata/i],
    ["changed-bytes", /downloaded.*SHA|digest/i],
  ] as const)("rejects a %s security release asset", async (securityMutation, expectedError) => {
    const fixture = await createFixture();
    const server = await startGitHubServer(fixture, { securityMutation });
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output: join(fixture.root, "manifest.json"),
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(expectedError);
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      "renamed",
      (fixture: Awaited<ReturnType<typeof createFixture>>) => {
        fixture.candidate.releaseAssets.security.gates.imageEngine.path = "renamed.json";
      },
    ],
    [
      "oversized gate",
      (fixture: Awaited<ReturnType<typeof createFixture>>) => {
        fixture.candidate.releaseAssets.security.gates.imageEngine.sizeBytes = 1024 * 1024 + 1;
      },
    ],
    [
      "oversized evidence",
      (fixture: Awaited<ReturnType<typeof createFixture>>) => {
        fixture.candidate.releaseAssets.security.sboms.engine.sizeBytes = 8 * 1024 * 1024 + 1;
      },
    ],
  ])("rejects a %s candidate security asset before network access", async (_label, mutate) => {
    const fixture = await createFixture();
    mutate(fixture);
    const { verificationSha256: _old, ...payload } = fixture.candidate;
    fixture.candidate.verificationSha256 = sha256Canonical(payload);
    await writeFile(
      join(fixture.candidateRoot, "processing-candidate.json"),
      canonicalJson(fixture.candidate),
    );
    await expect(
      resolveGitHubReleaseAssets({
        repository,
        releaseTag,
        candidateRoot: fixture.candidateRoot,
        output: join(fixture.root, "manifest.json"),
        apiOrigin: "http://127.0.0.1:9",
        token: "test-token",
      }),
    ).rejects.toThrow(/path|size|limit/i);
  });

  it("rejects a release tag that targets another source commit", async () => {
    const fixture = await createFixture();
    const server = await startGitHubServer(fixture, { target: "c".repeat(40) });
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output: join(fixture.root, "manifest.json"),
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(/tag.*(?:target|source|SHA)/i);
    } finally {
      await server.close();
    }
  });

  it("rejects changed download bytes even when metadata still matches", async () => {
    const fixture = await createFixture();
    const server = await startGitHubServer(fixture, { changedWorkerBytes: true });
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output: join(fixture.root, "manifest.json"),
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(/downloaded.*SHA|digest/i);
    } finally {
      await server.close();
    }
  });

  it("rejects a valid Pages archive with the wrong candidate tree hash", async () => {
    const fixture = await createFixture({ wrongStagingTree: true });
    const server = await startGitHubServer(fixture);
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output: join(fixture.root, "manifest.json"),
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(/tree SHA-256 (?:does not match|mismatch)/i);
    } finally {
      await server.close();
    }
  });

  it("never overwrites an existing output", async () => {
    const fixture = await createFixture();
    const server = await startGitHubServer(fixture);
    const output = join(fixture.root, "manifest.json");
    await writeFile(output, "keep\n");
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output,
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(/exists|overwrite/i);
      expect(await readFile(output, "utf8")).toBe("keep\n");
    } finally {
      await server.close();
    }
  });

  it("never overwrites an output created while assets are downloading", async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, "manifest.json");
    const server = await startGitHubServer(fixture, {
      onFirstDownload: () => writeFileSync(output, "keep\n"),
    });
    try {
      await expect(
        resolveGitHubReleaseAssets({
          repository,
          releaseTag,
          candidateRoot: fixture.candidateRoot,
          output,
          apiOrigin: server.origin,
          token: "test-token",
        }),
      ).rejects.toThrow(/exists|overwrite/i);
      expect(await readFile(output, "utf8")).toBe("keep\n");
    } finally {
      await server.close();
    }
  });

  it("rejects a symbolic-link candidate manifest before any network request", async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.candidateRoot, "processing-candidate.json");
    const backupPath = join(fixture.root, "candidate-backup.json");
    await writeFile(backupPath, await readFile(manifestPath));
    await rm(manifestPath);
    await symlink(backupPath, manifestPath);
    await expect(
      resolveGitHubReleaseAssets({
        repository,
        releaseTag,
        candidateRoot: fixture.candidateRoot,
        output: join(fixture.root, "manifest.json"),
        apiOrigin: "http://127.0.0.1:9",
        token: "test-token",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });
});
