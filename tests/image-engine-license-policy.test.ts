import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../scripts/image-lab-common.mjs";
import {
  evaluateSpdxExpression,
  runImageEngineLicenseCli,
  validateCommercialReview,
  validatePackageLicenses,
  validateRuntimeInventory,
  validateVulnerabilityExceptions,
  verifyImageEngineLicenseGate,
} from "../scripts/verify-image-engine-licenses.mjs";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

async function licenseGateFixture(scope: "pr" | "release" = "pr") {
  const root = await mkdtemp(join(tmpdir(), "hereisit-engine-license-gate-"));
  temporaryRoots.push(root);
  const sourceLock = (await readJson("apps/image-engine/native/sources.lock.json")) as {
    schemaVersion: number;
    sources: Array<Record<string, unknown>>;
  };
  const policy = await readJson("apps/image-engine/licenses/policy.json");
  const exceptions = await readJson("apps/image-engine/security/vulnerability-exceptions.json");
  const baseImages = await readJson("apps/image-engine/base-images.lock.json");
  const paths = {
    sourceLockPath: join(root, "sources.json"),
    policyPath: join(root, "policy.json"),
    exceptionsPath: join(root, "exceptions.json"),
    baseImageLockPath: join(root, "base-images.json"),
    commercialReviewPath: join(root, "commercial-review.json"),
    outputPath: join(root, "gate.json"),
  };
  const documents = { sourceLock, policy, exceptions, baseImages };
  await Promise.all([
    writeFile(paths.sourceLockPath, canonicalJson(sourceLock)),
    writeFile(paths.policyPath, canonicalJson(policy)),
    writeFile(paths.exceptionsPath, canonicalJson(exceptions)),
    writeFile(paths.baseImageLockPath, canonicalJson(baseImages)),
  ]);
  if (scope === "release") {
    await writeFile(
      paths.commercialReviewPath,
      canonicalJson({
        schemaVersion: 1,
        sourceLockSha256: sha256(canonicalJson(sourceLock)),
        records: sourceLock.sources
          .filter((source) => source.production === true)
          .map((source) => ({
            component: source.name,
            revision: source.revision,
            reviewedFiles: source.noticePaths,
            reviewer: "Independent counsel",
            organization: "Review organization",
            reviewDate: "2026-07-21",
            decision: "approved",
            conditions: [],
            approvalReference: "LEGAL-2026-001",
          })),
      }),
    );
  }

  const requiredPaths = [
    "/usr/local/bin/cjpeg",
    "/usr/local/bin/djpeg",
    "/usr/local/bin/jpegtran",
    "/usr/local/bin/jpeg-coeff-verify",
    "/usr/local/bin/oxipng",
    "/usr/local/bin/png-smart",
    "/usr/local/bin/cwebp",
    "/usr/local/bin/dwebp",
    "/usr/local/lib/libvips.so",
    "/app/dist/server.mjs",
    "/app/dist/job/job-runner.mjs",
  ];
  const required = requiredPaths.map((path, index) => ({
    path,
    mode: path.startsWith("/usr/local/bin/") ? 0o755 : 0o644,
    sha256: String(index + 1).padStart(64, "0"),
  }));
  const sourcePaths: Record<string, string[]> = {
    mozjpeg: requiredPaths.slice(0, 4),
    oxipng: [requiredPaths[4]],
    quantizr: [requiredPaths[5]],
    libwebp: requiredPaths.slice(6, 8),
    libvips: [requiredPaths[8]],
  };
  const buildMetadata = Object.fromEntries(
    sourceLock.sources
      .filter((source) => source.production === true)
      .map((source) => [
        String(source.artifactRecord).split("/").at(-1),
        {
          schemaVersion: 1,
          name: source.name === "quantizr" ? "png-smart" : source.name,
          revision: source.revision,
          artifacts: (sourcePaths[String(source.name)] ?? []).map((path) => ({
            sha256: required.find((record) => record.path === path)?.sha256,
          })),
        },
      ]),
  );
  Object.assign(buildMetadata, {
    "debian-packages.json": {
      schemaVersion: 1,
      snapshot: "20260815T000000Z",
      packages: [{ name: "base-files", version: "1" }],
      copyrightPaths: ["/usr/share/doc/base-files/copyright"],
    },
    "oxipng-cargo-metadata.json": {
      packages: [{ name: "oxipng", version: "10.1.1", license: "MIT" }],
    },
    "png-smart-cargo-metadata.json": {
      packages: [{ name: "png-smart", version: "0.1.0", license: null }],
    },
  });
  const inventory = {
    schemaVersion: 1,
    uid: 10001,
    entries: sourceLock.sources
      .filter((source) => source.production === true)
      .flatMap((source) =>
        (source.noticePaths as string[]).map((noticePath) => ({
          path: `/licenses/${String(source.name)}/${noticePath}`,
          type: "file",
          sha256: "f".repeat(64),
        })),
      ),
    required,
    packages: [{ name: "@hereisit/image-engine", version: "0.1.0", license: null }],
    linkage: [],
    buildMetadata,
  };
  const artifactSha256 = "a".repeat(64);
  const { commercialReviewPath, ...commonPaths } = paths;
  return {
    root,
    documents,
    paths,
    inventory,
    options: {
      scope,
      image: "hereisit-image-engine:test",
      artifactSha256,
      ...commonPaths,
      ...(scope === "release" ? { commercialReviewPath } : {}),
    },
  };
}

describe("image engine native supply-chain policy", () => {
  it("writes a canonical content-free PR gate bound to one runtime inspection", async () => {
    const fixture = await licenseGateFixture();
    const requests: unknown[] = [];
    const gate = await verifyImageEngineLicenseGate(fixture.options, {
      inspectRuntimeImage: async (request: unknown) => {
        requests.push(request);
        return fixture.inventory;
      },
    });
    const expected = {
      schema: "hereisit-image-engine-license-gate@1",
      passed: true,
      scope: "pr",
      artifactSha256: "a".repeat(64),
      sourceLockSha256: sha256(canonicalJson(fixture.documents.sourceLock)),
      policySha256: sha256(canonicalJson(fixture.documents.policy)),
      exceptionsSha256: sha256(canonicalJson(fixture.documents.exceptions)),
      baseImagesSha256: sha256(canonicalJson(fixture.documents.baseImages)),
    };

    expect(gate).toEqual(expected);
    expect(requests).toEqual([
      { image: "hereisit-image-engine:test", artifactSha256: "a".repeat(64) },
    ]);
    expect(await readFile(fixture.paths.outputPath, "utf8")).toBe(canonicalJson(expected));
    expect(await readFile(fixture.paths.outputPath, "utf8")).not.toMatch(
      /hereisit-image-engine:test|mozjpeg|MIT|sources\.json|licenses\//u,
    );
  });

  it("adds only the commercial-review hash to a valid release gate", async () => {
    const fixture = await licenseGateFixture("release");
    const gate = await verifyImageEngineLicenseGate(fixture.options, {
      inspectRuntimeImage: async () => fixture.inventory,
    });

    expect(gate).toEqual({
      schema: "hereisit-image-engine-license-gate@1",
      passed: true,
      scope: "release",
      artifactSha256: "a".repeat(64),
      sourceLockSha256: sha256(canonicalJson(fixture.documents.sourceLock)),
      policySha256: sha256(canonicalJson(fixture.documents.policy)),
      exceptionsSha256: sha256(canonicalJson(fixture.documents.exceptions)),
      baseImagesSha256: sha256(canonicalJson(fixture.documents.baseImages)),
      commercialReviewSha256: sha256(await readFile(fixture.paths.commercialReviewPath)),
    });
  });

  it("rejects invalid artifact identity and scope/review mismatches before inspection", async () => {
    const fixture = await licenseGateFixture();
    let inspections = 0;
    const adapters = {
      inspectRuntimeImage: async () => {
        inspections += 1;
        return fixture.inventory;
      },
    };
    await expect(
      verifyImageEngineLicenseGate(
        { ...fixture.options, artifactSha256: `sha256:${"a".repeat(64)}` },
        adapters,
      ),
    ).rejects.toThrow(/SHA-256/u);
    await expect(
      verifyImageEngineLicenseGate(
        { ...fixture.options, commercialReviewPath: fixture.paths.commercialReviewPath },
        adapters,
      ),
    ).rejects.toThrow(/fields/u);
    await expect(
      verifyImageEngineLicenseGate({ ...fixture.options, scope: "release" } as never, adapters),
    ).rejects.toThrow(/fields/u);
    expect(inspections).toBe(0);
  });

  it("rejects malformed, symlinked, and oversized JSON inputs", async () => {
    const malformed = await licenseGateFixture();
    await writeFile(malformed.paths.policyPath, "{\n");
    await expect(
      verifyImageEngineLicenseGate(malformed.options, {
        inspectRuntimeImage: async () => malformed.inventory,
      }),
    ).rejects.toThrow(/JSON/u);

    const linked = await licenseGateFixture();
    const policyTarget = join(linked.root, "policy-target.json");
    await writeFile(policyTarget, canonicalJson(linked.documents.policy));
    await rm(linked.paths.policyPath);
    await symlink(policyTarget, linked.paths.policyPath);
    await expect(
      verifyImageEngineLicenseGate(linked.options, {
        inspectRuntimeImage: async () => linked.inventory,
      }),
    ).rejects.toThrow(/symbolic/u);

    const oversized = await licenseGateFixture();
    await writeFile(oversized.paths.policyPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(
      verifyImageEngineLicenseGate(oversized.options, {
        inspectRuntimeImage: async () => oversized.inventory,
      }),
    ).rejects.toThrow(/bounded/u);
  });

  it("rejects JSON changed while it is being read", async () => {
    const fixture = await licenseGateFixture();
    const bytes = Buffer.from(
      canonicalJson({ ...fixture.documents.sourceLock, padding: "x".repeat(900_000) }),
    );
    await writeFile(fixture.paths.sourceLockPath, bytes);
    const handle = await open(fixture.paths.sourceLockPath, "r+");
    let active = true;
    let byte = 0x20;
    const writer = (async () => {
      while (active) {
        await handle.write(Buffer.from([byte]), 0, 1, bytes.length - 1);
        byte = byte === 0x20 ? 0x0a : 0x20;
        await new Promise<void>((done) => setImmediate(done));
      }
    })();
    try {
      await expect(
        verifyImageEngineLicenseGate(fixture.options, {
          inspectRuntimeImage: async () => fixture.inventory,
        }),
      ).rejects.toThrow(/changed while reading/u);
    } finally {
      active = false;
      await writer;
      await handle.close();
    }
  });

  it("writes mode 0600 without overwriting an existing gate", async () => {
    const fixture = await licenseGateFixture();
    const adapters = { inspectRuntimeImage: async () => fixture.inventory };
    await verifyImageEngineLicenseGate(fixture.options, adapters);
    expect((await stat(fixture.paths.outputPath)).mode & 0o777).toBe(0o600);
    await expect(verifyImageEngineLicenseGate(fixture.options, adapters)).rejects.toThrow();
  });

  it("requires the exact scope-specific CLI fields", async () => {
    const cases = [
      [],
      ["--scope", "pr", "--scope", "pr"],
      ["--scope", "pr", "--unknown", "value"],
      ["--scope", "release"],
      ["--scope", "pr", "--commercial-review", "review.json"],
    ];
    for (const argv of cases) {
      await expect(runImageEngineLicenseCli(argv)).rejects.toThrow();
    }
  });

  it("prints only the canonical gate digest for a valid CLI run", async () => {
    const fixture = await licenseGateFixture();
    const docker = join(fixture.root, "docker");
    await writeFile(
      docker,
      `#!/usr/bin/env node\nif (process.argv[2] === "image") process.stdout.write("sha256:${fixture.options.artifactSha256}\\n");\nelse process.stdout.write(${JSON.stringify(JSON.stringify(fixture.inventory))});\n`,
    );
    await chmod(docker, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/verify-image-engine-licenses.mjs",
        "--scope",
        "pr",
        "--image",
        fixture.options.image,
        "--artifact-sha256",
        fixture.options.artifactSha256,
        "--lock",
        fixture.paths.sourceLockPath,
        "--policy",
        fixture.paths.policyPath,
        "--exceptions",
        fixture.paths.exceptionsPath,
        "--base-lock",
        fixture.paths.baseImageLockPath,
        "--output",
        fixture.paths.outputPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fixture.root}:${process.env.PATH}` },
      },
    );
    const gateBytes = await readFile(fixture.paths.outputPath);
    const expected = canonicalJson({ gateSha256: sha256(gateBytes), passed: true });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected);
  });

  it("rejects a runtime image whose config digest does not match the artifact identity", async () => {
    const fixture = await licenseGateFixture();
    const docker = join(fixture.root, "docker");
    await writeFile(
      docker,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(fixture.inventory))});\n`,
    );
    await chmod(docker, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/verify-image-engine-licenses.mjs",
        "--scope",
        "pr",
        "--image",
        fixture.options.image,
        "--artifact-sha256",
        fixture.options.artifactSha256,
        "--lock",
        fixture.paths.sourceLockPath,
        "--policy",
        fixture.paths.policyPath,
        "--exceptions",
        fixture.paths.exceptionsPath,
        "--base-lock",
        fixture.paths.baseImageLockPath,
        "--output",
        fixture.paths.outputPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fixture.root}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("image engine license verification failed\n");
  });

  it("prints one generic direct-execution error without supplied data", () => {
    const secret = "/tmp/must-not-appear-source-lock.json";
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-image-engine-licenses.mjs", "--scope", "pr", "--lock", secret],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("image engine license verification failed\n");
    expect(result.stderr).not.toContain(secret);
  });

  it("builds the complete WebP library set required by libvips inside isolated prefixes", async () => {
    const [
      webpBuild,
      mozjpegBuild,
      jpegliBuild,
      libjxlMetricsBuild,
      dockerfile,
      rootDockerignore,
      verifier,
    ] = await Promise.all([
      readFile(join(repositoryRoot, "apps/image-engine/native/build-libwebp.sh"), "utf8"),
      readFile(join(repositoryRoot, "apps/image-engine/native/build-mozjpeg.sh"), "utf8"),
      readFile(join(repositoryRoot, "apps/image-engine/native/build-jpegli.sh"), "utf8"),
      readFile(join(repositoryRoot, "apps/image-engine/native/build-libjxl-metrics.sh"), "utf8"),
      readFile(join(repositoryRoot, "apps/image-engine/Dockerfile"), "utf8"),
      readFile(join(repositoryRoot, ".dockerignore"), "utf8"),
      readFile(join(repositoryRoot, "scripts/verify-image-engine-licenses.mjs"), "utf8"),
    ]);
    expect(webpBuild).toContain("-DWEBP_BUILD_LIBWEBPMUX=ON");
    expect(webpBuild).toContain("-DWEBP_BUILD_WEBPMUX=OFF");
    expect(mozjpegBuild).toContain('-DCMAKE_INSTALL_LIBDIR:PATH="$PREFIX/lib"');
    expect(mozjpegBuild).toContain("-DCMAKE_POSITION_INDEPENDENT_CODE=ON");
    expect(jpegliBuild).toContain('CC=cc CXX=c++ cmake -S "$SOURCE" -B "$SOURCE/build"');
    expect(jpegliBuild).toContain("-DBUILD_TESTING=OFF");
    expect(jpegliBuild).toContain("-DBUILD_SHARED_LIBS=OFF");
    expect(jpegliBuild).toContain(
      'cmake --build "$SOURCE/build" --parallel "$(nproc)" --target cjpegli',
    );
    expect(jpegliBuild).not.toContain('"$SOURCE/ci.sh"');
    expect(libjxlMetricsBuild).toContain("-DJPEGXL_ENABLE_DEVTOOLS=ON");
    expect(libjxlMetricsBuild).toContain("-DBUILD_SHARED_LIBS=OFF");
    expect(libjxlMetricsBuild).toContain(
      'cmake --build "$SOURCE/build" --parallel "$(nproc)" --target ssimulacra2 butteraugli_main',
    );
    expect(dockerfile).toContain(
      "cd apps/image-engine/node_modules/sharp \\\n  && PATH=/src/apps/image-engine/node_modules/.bin:$PATH SHARP_FORCE_GLOBAL_LIBVIPS=1 \\\n    node install/build.js",
    );
    expect(dockerfile).toContain(
      "pnpm install --filter @hereisit/image-engine... --frozen-lockfile --no-optional --ignore-scripts",
    );
    expect(dockerfile).toContain(
      "pnpm --filter @hereisit/image-engine deploy --prod --no-optional --legacy /opt/app",
    );
    expect(dockerfile).toContain(
      "! find /opt/app/node_modules -path '*/@img/sharp-*' -print -quit | grep .",
    );
    expect(dockerfile).toContain(
      "install -Dm755 apps/image-engine/node_modules/sharp/src/build/Release/sharp-linux-x64-0.35.3.node",
    );
    expect(dockerfile).toContain(
      '"$(readlink -f /opt/app/node_modules/sharp)/src/build/Release/sharp-linux-x64-0.35.3.node"',
    );
    expect(dockerfile).toContain('require("/opt/app/node_modules/sharp")');
    expect(dockerfile).toContain(
      'test "$(readlink /opt/app/node_modules/.pnpm/node_modules/@hereisit/image-engine)" = "../../../../../../src/apps/image-engine"',
    );
    expect(dockerfile).toContain(
      "unlink /opt/app/node_modules/.pnpm/node_modules/@hereisit/image-engine",
    );
    expect(dockerfile).toContain("rm /opt/app/node_modules/.modules.yaml");
    expect(dockerfile).toContain("! -name node_modules ! -name package.json -exec rm -rf {} +");
    expect(dockerfile).toContain("chmod -R a=rX /runtime-root/app /runtime-root/licenses");
    expect(dockerfile).toContain(
      "ARG DISTROLESS_NODE_IMAGE=gcr.io/distroless/nodejs24-debian13@sha256:fbbdda866ea71aef98c4abece17e3d61fbf820cc2ef3961522caa2478716171a",
    );
    const runtimeStage = "FROM $" + "{DISTROLESS_NODE_IMAGE} AS runtime";
    expect(dockerfile).toContain(runtimeStage);
    expect(dockerfile).toContain("COPY --from=runtime-files /runtime-root /");
    expect(dockerfile).not.toContain("cp -a apps/image-engine/security /runtime-root/security");
    expect(verifier).toContain('debian.snapshot !== "20260815T000000Z"');
    expect(verifier).toContain('"--entrypoint",\n      "/nodejs/bin/node",');
    expect(verifier).not.toContain('"--entrypoint",\n      "node",');
    const runtime = dockerfile.slice(dockerfile.indexOf(runtimeStage));
    expect(runtime).not.toMatch(/\b(?:apt-get|corepack|npm|SHELL|RUN)\b/u);
    expect(runtime).toContain('ENTRYPOINT ["/nodejs/bin/node", "/app/dist/server.mjs"]');
    expect(dockerfile.trimEnd()).toMatch(/FROM runtime AS production$/);
    expect(rootDockerignore).toContain("**/node_modules");
    expect(rootDockerignore).toContain("**/target");
    expect(rootDockerignore).toContain(".artifacts");
    expect(rootDockerignore).toContain(".wrangler");
  });

  it("locks every production source to reviewable origin and notice metadata", async () => {
    const lock = (await readJson("apps/image-engine/native/sources.lock.json")) as {
      schemaVersion: number;
      sources: Array<Record<string, unknown>>;
    };
    expect(lock.schemaVersion).toBe(1);
    for (const source of lock.sources.filter((candidate) => candidate.production === true)) {
      expect(source).toMatchObject({
        repository: expect.stringMatching(/^https:\/\/github\.com\//),
        revision: expect.stringMatching(/^[0-9a-f]{40}$/),
        licenses: expect.arrayContaining([expect.any(String)]),
        noticePaths: expect.arrayContaining([expect.any(String)]),
        buildRole: expect.stringMatching(/^runtime-/),
        artifactRecord: expect.stringMatching(/^\/build-metadata\/.+\.json$/),
      });
    }
    expect(lock.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "mozjpeg",
          version: "4.1.1",
          revision: "a2d2907ff023227e80c1e4efa809812410275a12",
          production: true,
          licenses: ["IJG", "BSD-3-Clause", "Zlib"],
          noticePaths: ["LICENSE.md", "README.ijg"],
          buildRole: "runtime-codec",
          artifactRecord: "/build-metadata/mozjpeg.json",
        }),
        expect.objectContaining({
          name: "jpegli",
          revision: "031a0077f5799a6041004267fc12b956c1f52a20",
          production: false,
          complianceReview: "blocked-pending-patent-and-corpus-review",
        }),
      ]),
    );
  });

  it("pins every base image to an index and linux/amd64 manifest digest", async () => {
    const lock = (await readJson("apps/image-engine/base-images.lock.json")) as {
      platform: string;
      images: Array<Record<string, unknown>>;
    };
    expect(lock.platform).toBe("linux/amd64");
    for (const image of lock.images) {
      expect(image).toMatchObject({
        reference: expect.any(String),
        indexDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        platformDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    }
  });

  it("fails closed on copyleft licenses and keeps reviewed CVEs exact and temporary", async () => {
    const policy = (await readJson("apps/image-engine/licenses/policy.json")) as {
      applicationAndNative: { prohibited: string[] };
      runtime: { prohibitedNames: string[]; benchmarkOnlyNames: string[] };
      vulnerabilityExceptions: { requiredFields: string[] };
    };
    expect(policy.applicationAndNative.prohibited).toEqual(
      expect.arrayContaining(["GPL-2.0", "GPL-3.0", "AGPL-3.0"]),
    );
    expect(policy.runtime.prohibitedNames).toEqual(
      expect.arrayContaining(["libimagequant", "pngquant"]),
    );
    expect(policy.runtime.benchmarkOnlyNames).toEqual(expect.arrayContaining(["jpegli", "libjxl"]));
    expect(policy.vulnerabilityExceptions.requiredFields).toEqual(
      expect.arrayContaining(["affectedVersion", "affectedScope"]),
    );
    const exceptions = (await readJson(
      "apps/image-engine/security/vulnerability-exceptions.json",
    )) as Parameters<typeof validateVulnerabilityExceptions>[0] & {
      exceptions: Array<Record<string, string>>;
    };
    expect(() =>
      validateVulnerabilityExceptions(exceptions, new Date("2026-08-16T00:00:00.000Z"), {
        allowedScopes: ["engine", "pdf-engine"],
      }),
    ).not.toThrow();
    expect(exceptions.exceptions).toHaveLength(9);
    expect(
      new Set(exceptions.exceptions.map(({ cve, affectedPackage }) => `${cve}:${affectedPackage}`)),
    ).toEqual(
      new Set([
        "CVE-2026-14456:libssl3t64",
        "CVE-2026-58010:libglib2.0-0t64",
        "CVE-2026-58011:libglib2.0-0t64",
        "CVE-2026-58012:libglib2.0-0t64",
        "CVE-2026-58013:libglib2.0-0t64",
        "CVE-2026-58014:libglib2.0-0t64",
        "CVE-2026-58015:libglib2.0-0t64",
        "CVE-2026-58016:libglib2.0-0t64",
      ]),
    );
    expect(new Set(exceptions.exceptions.map(({ affectedDigest }) => affectedDigest))).toEqual(
      new Set([
        "sha256:a69d05dfcb13a75dee5bb3b13582001d9d784f39a98356be3ae668e666d8f91c",
        "sha256:53da27375ee705eadf4136998cced1256d70c9d8e3897f2868fcd36b15349281",
      ]),
    );
    expect(
      exceptions.exceptions
        .filter(
          ({ cve, affectedPackage }) =>
            cve === "CVE-2026-14456" && affectedPackage === "libssl3t64",
        )
        .map(({ affectedScope, affectedDigest }) => `${affectedScope}:${affectedDigest}`),
    ).toEqual([
      "engine:sha256:a69d05dfcb13a75dee5bb3b13582001d9d784f39a98356be3ae668e666d8f91c",
      "pdf-engine:sha256:53da27375ee705eadf4136998cced1256d70c9d8e3897f2868fcd36b15349281",
    ]);
  });

  it.each([
    ["MIT", "allowed"],
    ["MIT AND BSD-3-Clause", "allowed"],
    ["MIT OR GPL-3.0-only", "prohibited"],
    ["LGPL-2.1-or-later", "conditional"],
    ["(MIT OR BSD-3-Clause) AND Zlib", "allowed"],
    ["GPL-2.0-or-later", "prohibited"],
    ["LicenseRef-Proprietary", "unknown"],
    ["NOASSERTION", "unknown"],
    ["Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "allowed"],
    ["Unlicense OR MIT", "allowed"],
    ["MIT WITH Classpath-exception-2.0", "unknown"],
  ] as const)("evaluates SPDX %s as %s", async (expression, expected) => {
    const policy = (await readJson("apps/image-engine/licenses/policy.json")) as Parameters<
      typeof evaluateSpdxExpression
    >[1];
    expect(evaluateSpdxExpression(expression, policy)).toBe(expected);
  });

  it("rejects incomplete, expired, and overlong vulnerability exceptions", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const valid = {
      schemaVersion: 1,
      exceptions: [
        {
          cve: "CVE-2026-12345",
          affectedPackage: "example",
          affectedVersion: "1.0.0",
          affectedScope: "engine",
          affectedDigest: `sha256:${"a".repeat(64)}`,
          exploitabilityEvidence: "Unreachable code path in the network-disabled runtime.",
          owner: "security-owner",
          approvalReference: "https://github.com/liorium/hereisit/issues/123",
          expiresAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    };
    expect(() => validateVulnerabilityExceptions(valid, now)).not.toThrow();
    expect(() =>
      validateVulnerabilityExceptions(
        {
          ...valid,
          exceptions: [{ ...valid.exceptions[0], expiresAt: "2026-07-15T00:00:00.000Z" }],
        },
        now,
      ),
    ).toThrow("expired");
    expect(() =>
      validateVulnerabilityExceptions(
        {
          ...valid,
          exceptions: [{ ...valid.exceptions[0], expiresAt: "2026-08-20T00:00:00.000Z" }],
        },
        now,
      ),
    ).toThrow("30 days");
    const { owner: _owner, ...incomplete } = valid.exceptions[0];
    expect(() =>
      validateVulnerabilityExceptions({ ...valid, exceptions: [incomplete] }, now),
    ).toThrow("owner");
  });

  it("reconciles every package license and permits only explicit first-party packages", async () => {
    const policy = (await readJson("apps/image-engine/licenses/policy.json")) as Parameters<
      typeof validatePackageLicenses
    >[1];
    expect(() =>
      validatePackageLicenses(
        [
          { name: "png-smart", version: "0.1.0", license: null },
          { name: "zod", version: "4.4.3", license: "MIT" },
        ],
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validatePackageLicenses([{ name: "mystery", version: "1.0.0", license: null }], policy),
    ).toThrow("mystery@1.0.0");
    expect(() =>
      validatePackageLicenses(
        [{ name: "copyleft", version: "1.0.0", license: "MIT OR GPL-3.0-only" }],
        policy,
      ),
    ).toThrow("copyleft@1.0.0");
    const quantizr = {
      name: "quantizr",
      version: "1.4.3",
      license: null,
      license_file: "LICENSE",
      source: `git+https://github.com/DarthSim/quantizr.git?rev=${"c".repeat(40)}#${"c".repeat(40)}`,
    };
    const sourceLock = {
      schemaVersion: 1,
      sources: [
        {
          name: "quantizr",
          version: "1.4.3",
          repository: "https://github.com/DarthSim/quantizr.git",
          revision: "c".repeat(40),
          licenses: ["MIT"],
          noticePaths: ["LICENSE"],
        },
      ],
    };
    expect(() => validatePackageLicenses([quantizr], policy, sourceLock)).not.toThrow();
    expect(() =>
      validatePackageLicenses(
        [{ ...quantizr, source: quantizr.source.replace(/c{40}$/u, "d".repeat(40)) }],
        policy,
        sourceLock,
      ),
    ).toThrow("quantizr@1.4.3");
  });

  it("requires an immutable approved commercial review bound to the exact source lock", () => {
    const sourceLock = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            name: "libvips",
            revision: "e".repeat(40),
            production: true,
            noticePaths: ["LICENSE"],
          },
        ],
      }),
    );
    const sourceLockSha256 = createHash("sha256").update(sourceLock).digest("hex");
    const approved = {
      schemaVersion: 1,
      sourceLockSha256,
      records: [
        {
          component: "libvips",
          revision: "e".repeat(40),
          reviewedFiles: ["LICENSE"],
          reviewer: "Independent counsel",
          organization: "Review organization",
          reviewDate: "2026-07-16",
          decision: "approved",
          conditions: [],
          approvalReference: "LEGAL-2026-001",
        },
      ],
    };
    expect(() =>
      validateCommercialReview(approved, sourceLock, new Date("2026-07-17T00:00:00Z")),
    ).not.toThrow();
    expect(() =>
      validateCommercialReview(
        {
          ...approved,
          records: [{ ...approved.records[0], decision: "not-reviewed" }],
        },
        sourceLock,
        new Date("2026-07-17T00:00:00Z"),
      ),
    ).toThrow("not approved");
    expect(() =>
      validateCommercialReview(
        { ...approved, sourceLockSha256: "0".repeat(64) },
        sourceLock,
        new Date("2026-07-17T00:00:00Z"),
      ),
    ).toThrow("source lock");
  });

  it("fails closed on a privileged or prohibited runtime inventory", async () => {
    const [lock, policy] = (await Promise.all([
      readJson("apps/image-engine/native/sources.lock.json"),
      readJson("apps/image-engine/licenses/policy.json"),
    ])) as [
      Parameters<typeof validateRuntimeInventory>[1],
      Parameters<typeof validateRuntimeInventory>[2],
    ];
    const invalid = {
      schemaVersion: 1,
      uid: 0,
      entries: [{ path: "/usr/local/bin/pngquant", type: "file", sha256: "a".repeat(64) }],
      required: [],
      packages: [],
      linkage: [],
      buildMetadata: {},
    };
    expect(() => validateRuntimeInventory(invalid, lock, policy)).toThrow(/uid|privileged/i);
    expect(() => validateRuntimeInventory({ ...invalid, uid: 10001 }, lock, policy)).toThrow(
      /pngquant|prohibited/i,
    );
  });
});
