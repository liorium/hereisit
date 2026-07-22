import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runApplicationSupplyChain } from "../scripts/application-supply-chain.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const sha = (character: string) => character.repeat(64);
const scopes = ["engine", "web-staging", "web-production", "worker", "lockfile"] as const;
const syftImage =
  "ghcr.io/anchore/syft@sha256:2baa4d24d90599840c0100a8d30deaa533821fcd99f405ce6f90e3d225bd836d";
const checkedInMit = `Copyright (c) 2020 Cloudflare, Inc. <wrangler@cloudflare.com>\n\nPermission is hereby granted, free of charge, to any\nperson obtaining a copy of this software and associated\ndocumentation files (the "Software"), to deal in the\nSoftware without restriction, including without\nlimitation the rights to use, copy, modify, merge,\npublish, distribute, sublicense, and/or sell copies of\nthe Software, and to permit persons to whom the Software\nis furnished to do so, subject to the following\nconditions:\n\nThe above copyright notice and this permission notice\nshall be included in all copies or substantial portions\nof the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF\nANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED\nTO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A\nPARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT\nSHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY\nCLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION\nOF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR\nIN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER\nDEALINGS IN THE SOFTWARE.\n`;

const policy = {
  allowedLicenseExpressions: [
    "0BSD",
    "Apache-2.0",
    "BSD-3-Clause",
    "CC-BY-4.0",
    "ISC",
    "MIT",
    "MIT OR Apache-2.0",
    "(MIT AND Zlib)",
  ],
  fallbacks: {
    "@cloudflare/containers@0.3.7": {
      kind: "checked-in",
      path: "security/license-texts/cloudflare-containers-0.3.7-MIT.txt",
      sha256: "9bb3b077cc8628334bab25961223dd8207252c8a56aa054195be38f1c042aaf4",
    },
    "@img/sharp-libvips-linux-x64@1.2.4": { kind: "root-readme", path: "README.md" },
    "@napi-rs/canvas-linux-x64-gnu@1.0.2": {
      kind: "package",
      package: "@napi-rs/canvas@1.0.2",
    },
    "@next/env@16.2.10": { kind: "package", package: "next@16.2.10" },
    "@next/swc-linux-x64-gnu@16.2.10": { kind: "package", package: "next@16.2.10" },
    "client-only@0.0.1": { kind: "package", package: "react@19.2.7" },
  },
  mustNotShip: ["@img/sharp-libvips-linux-x64@1.2.4"],
  pnpm: { version: "11.11.0" },
  schemaVersion: 1,
  syft: { image: syftImage, version: "1.44.0" },
};

type PackageSpec = { name: string; version: string; license: string; text?: string | null };

const packageSpecs: PackageSpec[] = [
  { name: "allow-0bsd", version: "1.0.0", license: "0BSD" },
  { name: "allow-apache", version: "1.0.0", license: "Apache-2.0" },
  { name: "allow-bsd", version: "1.0.0", license: "BSD-3-Clause" },
  { name: "allow-cc", version: "1.0.0", license: "CC-BY-4.0" },
  { name: "allow-isc", version: "1.0.0", license: "ISC" },
  { name: "allow-mit", version: "1.0.0", license: "MIT" },
  { name: "allow-dual", version: "1.0.0", license: "MIT OR Apache-2.0" },
  { name: "allow-combined", version: "1.0.0", license: "(MIT AND Zlib)" },
  { name: "@napi-rs/canvas", version: "1.0.2", license: "MIT" },
  { name: "@napi-rs/canvas-linux-x64-gnu", version: "1.0.2", license: "MIT", text: null },
  { name: "next", version: "16.2.10", license: "MIT" },
  { name: "@next/env", version: "16.2.10", license: "MIT", text: null },
  { name: "@next/swc-linux-x64-gnu", version: "16.2.10", license: "MIT", text: null },
  { name: "react", version: "19.2.7", license: "MIT" },
  { name: "client-only", version: "0.0.1", license: "MIT", text: null },
  { name: "@cloudflare/containers", version: "0.3.7", license: "MIT OR Apache-2.0", text: null },
  {
    name: "@img/sharp-libvips-linux-x64",
    version: "1.2.4",
    license: "LGPL-3.0-or-later",
    text: "libvips distribution terms\n",
  },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${canonical(value)}\n`);
}

function pnpmRecord(spec: PackageSpec, path: string) {
  return {
    name: spec.name,
    versions: [spec.version],
    paths: [path],
    license: spec.license,
    homepage: "https://example.invalid/package",
    description: "fixture package",
  };
}

function makeSbom(
  scope: (typeof scopes)[number],
  artifactSha256: string,
  components = packageSpecs,
) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    version: 1,
    metadata: {
      timestamp: "2026-07-22T00:00:00Z",
      tools: {
        components: [{ type: "application", author: "anchore", name: "syft", version: "1.44.0" }],
      },
      component: {
        "bom-ref": `hereisit-${scope}:sha256-${artifactSha256}`,
        type: "file",
        name: `hereisit-${scope}:sha256-${artifactSha256}`,
      },
    },
    components: components.map((entry) => ({
      "bom-ref": `${entry.name}@${entry.version}`,
      type: "library",
      name: entry.name,
      version: entry.version,
      licenses: [{ expression: entry.license }],
      properties: [{ name: "syft:package:type", value: "npm" }],
    })),
  };
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-application-supply-chain-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "security/license-texts"), { recursive: true });
  await mkdir(join(root, "node_modules/.pnpm"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"packageManager":"pnpm@11.11.0"}\n');
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(root, "security/license-texts/cloudflare-containers-0.3.7-MIT.txt"),
    checkedInMit,
  );
  await writeCanonical(join(root, "security/application-license-policy.json"), policy);

  const inventory: Record<string, ReturnType<typeof pnpmRecord>[]> = {};
  for (const spec of packageSpecs) {
    const escapedName = spec.name.replaceAll("/", "+").replace(/^@/, "@");
    const packageRoot = join(
      root,
      "node_modules/.pnpm",
      `${escapedName}@${spec.version}`,
      "node_modules",
      spec.name,
    );
    await mkdir(packageRoot, { recursive: true });
    await writeCanonical(join(packageRoot, "package.json"), {
      name: spec.name,
      version: spec.version,
      license: spec.license,
    });
    if (spec.text !== null) {
      const file = spec.name === "@img/sharp-libvips-linux-x64" ? "README.md" : "LICENSE";
      await writeFile(join(packageRoot, file), spec.text ?? `${spec.name} license\r\n`);
    }
    inventory[spec.license] ??= [];
    inventory[spec.license].push(pnpmRecord(spec, packageRoot));
  }

  const noticesPath = join(root, "apps/web/public/THIRD_PARTY_NOTICES.txt");
  const gatePath = join(root, "gate.json");
  const sboms = Object.fromEntries(
    await Promise.all(
      scopes.map(async (scope, index) => {
        const artifactSha256 = sha(String(index + 1));
        const path = join(root, `${scope}.cdx.json`);
        const components = ["web-staging", "web-production", "worker"].includes(scope)
          ? packageSpecs.filter((entry) => entry.name !== "@img/sharp-libvips-linux-x64")
          : packageSpecs;
        await writeCanonical(path, makeSbom(scope, artifactSha256, components));
        return [scope, { path, artifactSha256 }];
      }),
    ),
  );
  const options = {
    repositoryRoot: root,
    policyPath: join(root, "security/application-license-policy.json"),
    lockfilePath: join(root, "pnpm-lock.yaml"),
    noticesPath,
  };
  const adapters = { listProductionLicenses: async () => JSON.stringify(inventory) };
  return { root, inventory, noticesPath, gatePath, sboms, options, adapters };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("application supply-chain gate", () => {
  it("exactly regenerates the committed notices from the current production inventory", async () => {
    const repositoryRoot = process.cwd();
    const result = await runApplicationSupplyChain(
      {
        mode: "notices",
        repositoryRoot,
        policyPath: join(repositoryRoot, "security/application-license-policy.json"),
        lockfilePath: join(repositoryRoot, "pnpm-lock.yaml"),
        noticesPath: join(repositoryRoot, "apps/web/public/THIRD_PARTY_NOTICES.txt"),
      },
      {
        listProductionLicenses: async ({ command, args, cwd, maxBuffer }) =>
          (await execFileAsync(command, args, { cwd, maxBuffer })).stdout,
      },
    );
    expect(result).toEqual({
      noticeSha256: "bafe9bf3579700944f06f5cfd297e693e9bb47f2d41bd708766cfe04a70d235a",
      packageCount: 44,
    });
  });

  it("writes deterministic notices and permits exact regeneration", async () => {
    const fixture = await makeFixture();
    const first = await runApplicationSupplyChain(
      { mode: "notices", ...fixture.options },
      fixture.adapters,
    );
    const bytes = await readFile(fixture.noticesPath, "utf8");
    const second = await runApplicationSupplyChain(
      { mode: "notices", ...fixture.options },
      fixture.adapters,
    );

    expect(second).toEqual(first);
    expect(first).toEqual({
      noticeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      packageCount: 17,
    });
    expect(bytes).toContain("HereIsIt Third-Party Notices");
    expect(bytes).toContain("@cloudflare/containers\nVersion: 0.3.7");
    expect(bytes).toContain(checkedInMit.trimEnd());
    expect(bytes).not.toContain(fixture.root);
    await writeFile(fixture.noticesPath, "changed\n");
    await expect(
      runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters),
    ).rejects.toThrow(/overwrite|different/i);
  });

  it("verifies five genuine-shaped Syft SBOMs and writes a content-free canonical gate", async () => {
    const fixture = await makeFixture();
    await runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters);
    const result = await runApplicationSupplyChain(
      { mode: "verify", ...fixture.options, sboms: fixture.sboms, gatePath: fixture.gatePath },
      fixture.adapters,
    );
    const gateBytes = await readFile(fixture.gatePath, "utf8");
    const gate = JSON.parse(gateBytes);

    expect(result).toEqual(gate);
    expect(gate).toMatchObject({
      schema: "hereisit-application-supply-chain-gate@1",
      passed: true,
      pnpmVersion: "11.11.0",
      syftVersion: "1.44.0",
      syftImage,
      reviewedPackageCount: 17,
      scopes: Object.fromEntries(
        scopes.map((scope, index) => [
          scope,
          {
            artifactSha256: sha(String(index + 1)),
            sbomSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            componentCount: scope.startsWith("web-") || scope === "worker" ? 16 : 17,
          },
        ]),
      ),
    });
    expect(gateBytes).toBe(`${canonical(gate)}\n`);
    expect(gateBytes).not.toMatch(/allow-mit|LGPL|node_modules|\.cdx\.json|example\.invalid/);
  });

  it("uses the exact pnpm command contract and sanitizes adapter failures", async () => {
    const fixture = await makeFixture();
    let request: unknown;
    await runApplicationSupplyChain(
      { mode: "notices", ...fixture.options },
      {
        listProductionLicenses: async (value: unknown) => {
          request = value;
          return JSON.stringify(fixture.inventory);
        },
      },
    );
    expect(request).toEqual({
      command: "pnpm",
      args: [
        "licenses",
        "list",
        "--prod",
        "--json",
        "--filter",
        "@hereisit/web...",
        "--filter",
        "@hereisit/api-worker...",
      ],
      cwd: fixture.root,
      maxBuffer: 2 * 1024 * 1024,
    });
    await expect(
      runApplicationSupplyChain(
        { mode: "notices", ...fixture.options },
        {
          listProductionLicenses: async () =>
            Promise.reject(new Error(`/secret/path ${fixture.root}`)),
        },
      ),
    ).rejects.toThrow("production dependency inventory failed");
  });

  it("rejects inventory path escapes, symlinks, malformed shapes, and duplicates", async () => {
    const fixture = await makeFixture();
    const firstLicense = Object.keys(fixture.inventory)[0];
    const base = structuredClone(fixture.inventory);
    base[firstLicense][0].paths[0] = join(fixture.root, "outside");
    await expect(
      runApplicationSupplyChain(
        { mode: "notices", ...fixture.options },
        { listProductionLicenses: async () => JSON.stringify(base) },
      ),
    ).rejects.toThrow(/node_modules|path/i);

    const duplicated = structuredClone(fixture.inventory);
    duplicated[firstLicense].push(structuredClone(duplicated[firstLicense][0]));
    await expect(
      runApplicationSupplyChain(
        { mode: "notices", ...fixture.options },
        { listProductionLicenses: async () => JSON.stringify(duplicated) },
      ),
    ).rejects.toThrow(/duplicate/i);

    const unknown = structuredClone(fixture.inventory) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    unknown[firstLicense][0].repository = "hidden";
    await expect(
      runApplicationSupplyChain(
        { mode: "notices", ...fixture.options },
        { listProductionLicenses: async () => JSON.stringify(unknown) },
      ),
    ).rejects.toThrow(/field/i);

    const linkedRoot = join(fixture.root, "node_modules/.pnpm/linked/node_modules/linked");
    await mkdir(join(linkedRoot, ".."), { recursive: true });
    await symlink(join(fixture.root, "outside"), linkedRoot);
    const symbolic = structuredClone(fixture.inventory);
    symbolic[firstLicense][0].paths[0] = linkedRoot;
    await expect(
      runApplicationSupplyChain(
        { mode: "notices", ...fixture.options },
        { listProductionLicenses: async () => JSON.stringify(symbolic) },
      ),
    ).rejects.toThrow(/symbolic|path|read/i);
  });

  it.each([
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "unknown",
    "",
    "NOASSERTION",
    "LicenseRef-private",
  ])("fails closed on the unreviewed license %j", async (license) => {
    const fixture = await makeFixture();
    const inventory = structuredClone(fixture.inventory);
    const record = inventory.MIT[0];
    inventory.MIT = inventory.MIT.slice(1);
    record.license = license;
    inventory[license || "missing"] = [record];
    await expect(
      runApplicationSupplyChain(
        { mode: "notices", ...fixture.options },
        { listProductionLicenses: async () => JSON.stringify(inventory) },
      ),
    ).rejects.toThrow(/license|inventory/i);
  });

  it("rejects unused, wrong, cyclic, and changed fallback definitions", async () => {
    const fixture = await makeFixture();
    const cases = [
      {
        ...policy,
        fallbacks: {
          ...policy.fallbacks,
          "unused@1.0.0": { kind: "package", package: "react@19.2.7" },
        },
      },
      {
        ...policy,
        fallbacks: {
          ...policy.fallbacks,
          "@next/env@16.2.10": { kind: "package", package: "missing@1.0.0" },
        },
      },
      {
        ...policy,
        fallbacks: {
          ...policy.fallbacks,
          "@next/env@16.2.10": { kind: "package", package: "@next/swc-linux-x64-gnu@16.2.10" },
          "@next/swc-linux-x64-gnu@16.2.10": { kind: "package", package: "@next/env@16.2.10" },
        },
      },
      {
        ...policy,
        fallbacks: {
          ...policy.fallbacks,
          "@cloudflare/containers@0.3.7": {
            ...policy.fallbacks["@cloudflare/containers@0.3.7"],
            sha256: sha("0"),
          },
        },
      },
    ];
    for (const invalid of cases) {
      await writeCanonical(fixture.options.policyPath, invalid);
      await expect(
        runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters),
      ).rejects.toThrow(/fallback|license text|SHA-256|package/i);
    }
  });

  it("allows must-not-ship inventory but rejects it from application SBOMs", async () => {
    const fixture = await makeFixture();
    await runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters);
    const worker = fixture.sboms.worker;
    await writeCanonical(worker.path, makeSbom("worker", worker.artifactSha256, packageSpecs));
    await expect(
      runApplicationSupplyChain(
        { mode: "verify", ...fixture.options, sboms: fixture.sboms, gatePath: fixture.gatePath },
        fixture.adapters,
      ),
    ).rejects.toThrow(/must not ship|prohibited/i);
  });

  it("rejects must-not-ship policy drift", async () => {
    const fixture = await makeFixture();
    await writeCanonical(fixture.options.policyPath, {
      ...policy,
      mustNotShip: [...policy.mustNotShip, "allow-mit@1.0.0"],
    });
    await expect(
      runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters),
    ).rejects.toThrow(/mustNotShip|drift/i);
  });

  it("rejects Syft identity drift, source swaps, duplicate components, and oversized SBOMs", async () => {
    for (const mutate of [
      (sbom: ReturnType<typeof makeSbom>) => {
        sbom.metadata.tools.components[0].version = "1.43.0";
      },
      (sbom: ReturnType<typeof makeSbom>) => {
        sbom.metadata.component.name = `hereisit-worker:sha256-${sha("4")}`;
      },
      (sbom: ReturnType<typeof makeSbom>) => {
        sbom.components.push(structuredClone(sbom.components[0]));
      },
    ]) {
      const fixture = await makeFixture();
      await runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters);
      const sbom = makeSbom("engine", fixture.sboms.engine.artifactSha256);
      mutate(sbom);
      await writeCanonical(fixture.sboms.engine.path, sbom);
      await expect(
        runApplicationSupplyChain(
          { mode: "verify", ...fixture.options, sboms: fixture.sboms, gatePath: fixture.gatePath },
          fixture.adapters,
        ),
      ).rejects.toThrow(/Syft|source|duplicate|component/i);
    }

    const fixture = await makeFixture();
    await runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters);
    await writeFile(fixture.sboms.engine.path, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    await expect(
      runApplicationSupplyChain(
        { mode: "verify", ...fixture.options, sboms: fixture.sboms, gatePath: fixture.gatePath },
        fixture.adapters,
      ),
    ).rejects.toThrow(/bounded|SBOM/i);
  });

  it("rejects notices mismatch and refuses gate overwrite", async () => {
    const fixture = await makeFixture();
    await runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters);
    await writeFile(fixture.noticesPath, "wrong\n");
    await expect(
      runApplicationSupplyChain(
        { mode: "verify", ...fixture.options, sboms: fixture.sboms, gatePath: fixture.gatePath },
        fixture.adapters,
      ),
    ).rejects.toThrow(/notices/i);
    await rm(fixture.noticesPath);
    await runApplicationSupplyChain({ mode: "notices", ...fixture.options }, fixture.adapters);
    await writeFile(fixture.gatePath, "occupied\n");
    await expect(
      runApplicationSupplyChain(
        { mode: "verify", ...fixture.options, sboms: fixture.sboms, gatePath: fixture.gatePath },
        fixture.adapters,
      ),
    ).rejects.toThrow(/exist|overwrite/i);
  });

  it("prints only a path-safe generic direct-execution error", async () => {
    const script = join(process.cwd(), "scripts/application-supply-chain.mjs");
    await expect(
      execFileAsync(process.execPath, [
        script,
        "--mode",
        "notices",
        "--repository",
        "/secret/value",
      ]),
    ).rejects.toMatchObject({
      stderr: "application supply-chain gate failed\n",
    });
  });
});
