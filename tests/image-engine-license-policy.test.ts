import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateSpdxExpression,
  validateCommercialReview,
  validatePackageLicenses,
  validateRuntimeInventory,
  validateVulnerabilityExceptions,
} from "../scripts/verify-image-engine-licenses.mjs";

const repositoryRoot = process.cwd();

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

describe("image engine native supply-chain policy", () => {
  it("builds the complete WebP library set required by libvips inside isolated prefixes", async () => {
    const [webpBuild, mozjpegBuild, jpegliBuild, libjxlMetricsBuild, dockerfile, rootDockerignore] =
      await Promise.all([
        readFile(join(repositoryRoot, "apps/image-engine/native/build-libwebp.sh"), "utf8"),
        readFile(join(repositoryRoot, "apps/image-engine/native/build-mozjpeg.sh"), "utf8"),
        readFile(join(repositoryRoot, "apps/image-engine/native/build-jpegli.sh"), "utf8"),
        readFile(join(repositoryRoot, "apps/image-engine/native/build-libjxl-metrics.sh"), "utf8"),
        readFile(join(repositoryRoot, "apps/image-engine/Dockerfile"), "utf8"),
        readFile(join(repositoryRoot, ".dockerignore"), "utf8"),
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
    expect(dockerfile).toContain("! -name node_modules ! -name package.json -exec rm -rf {} +");
    expect(dockerfile).toContain("rm -rf /opt/yarn-v1.22.22 /usr/local/lib/node_modules");
    expect(dockerfile).toContain(
      "rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx",
    );
    expect(dockerfile).toContain(
      "/usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh",
    );
    expect(dockerfile).toContain("chmod -R a=rX /licenses /security /build-metadata");
    expect(dockerfile.trimEnd()).toMatch(/FROM runtime AS production$/);
    expect(rootDockerignore).toContain("**/node_modules");
    expect(rootDockerignore).toContain("**/target");
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

  it("fails closed on copyleft application licenses and starts with no CVE exceptions", async () => {
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
    await expect(
      readJson("apps/image-engine/security/vulnerability-exceptions.json"),
    ).resolves.toEqual({ schemaVersion: 1, exceptions: [] });
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
