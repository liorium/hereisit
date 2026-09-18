import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPdfNativeSbom } from "../scripts/create-pdf-native-sbom.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-sbom-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const build = join(root, "build");
  for (const path of [
    "runtime/licenses",
    "runtime/usr/local/bin",
    "runtime/usr/local/lib",
    "build/bin",
    "build/lib",
  ])
    await mkdir(join(root, path), { recursive: true });
  const lock = await readFile("apps/pdf-engine/native/sources.lock.json");
  await writeFile(join(runtime, "licenses/sources.lock.json"), lock);
  await writeFile(join(build, "source-lock.json"), lock);
  for (const prefix of [join(runtime, "usr/local"), build]) {
    await writeFile(join(prefix, "bin/qpdf"), "\x7fELFqpdf");
    await writeFile(join(prefix, "lib/libqpdf.so.30.4.0"), "\x7fELFqpdf-library");
    await symlink("libqpdf.so.30.4.0", join(prefix, "lib/libqpdf.so.30"));
  }
  return { root, runtime, build };
}

it("records qpdf's source archive and both shipped binaries without inventing an OS package", async () => {
  const { runtime, build } = await fixture();
  const sbom = await createPdfNativeSbom(runtime, build);
  expect(sbom.components).toHaveLength(1);
  expect(sbom.components[0]).toMatchObject({
    name: "qpdf",
    version: "12.4.0",
    purl: "pkg:generic/qpdf@12.4.0",
    cpe: "cpe:2.3:a:qpdf_project:qpdf:12.4.0:*:*:*:*:*:*:*",
    evidence: {
      occurrences: [
        { location: "/usr/local/bin/qpdf" },
        { location: "/usr/local/lib/libqpdf.so.30.4.0" },
      ],
    },
    externalReferences: [
      {
        type: "distribution",
        url: "https://github.com/qpdf/qpdf/releases/download/v12.4.0/qpdf-12.4.0.tar.gz",
      },
    ],
  });
  expect(sbom.components[0]["bom-ref"]).toBe(
    "native:qpdf@2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529",
  );
});

it.each([
  "bin/qpdf",
  "lib/libqpdf.so.30.4.0",
  "source-lock.json",
])("rejects a runtime that does not match the verified build's %s", async (path) => {
  const { runtime, build } = await fixture();
  await writeFile(join(build, path), "different build");
  await expect(createPdfNativeSbom(runtime, build)).rejects.toThrow(/build|bound/i);
});

it.each([
  "runtime",
  "build",
] as const)("rejects library links escaping the %s tree", async (side) => {
  const fixtureValue = await fixture();
  const path =
    side === "runtime"
      ? join(fixtureValue.runtime, "usr/local/lib/libqpdf.so.30")
      : join(fixtureValue.build, "lib/libqpdf.so.30");
  await rm(path);
  await symlink(process.execPath, path);
  await expect(createPdfNativeSbom(fixtureValue.runtime, fixtureValue.build)).rejects.toThrow(
    /escapes/i,
  );
});

it("writes the embedded inventory once and leaves no output on a build mismatch", async () => {
  const { runtime, build } = await fixture();
  const args = ["scripts/create-pdf-native-sbom.mjs", runtime, build];
  const output = join(runtime, "build-metadata/native.cdx.json");
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(first.status, first.stderr).toBe(0);
  const bytes = await readFile(output, "utf8");
  expect(JSON.parse(bytes).components[0].name).toBe("qpdf");
  expect(spawnSync(process.execPath, args).status).toBe(1);
  expect(await readFile(output, "utf8")).toBe(bytes);
  await rm(output);
  await writeFile(join(build, "bin/qpdf"), "different build");
  expect(spawnSync(process.execPath, args).status).toBe(1);
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
