import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createImageNativeSbom } from "../scripts/create-image-native-sbom.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-native-sbom-"));
  roots.push(root);
  for (const path of ["licenses", "build-metadata", "usr/local/lib"])
    await mkdir(join(root, path), { recursive: true });
  const lock = JSON.parse(await readFile("apps/image-engine/native/sources.lock.json", "utf8"));
  lock.sources = lock.sources.filter(
    (source: { name: string; production: boolean }) =>
      source.name === "expat" || !source.production,
  );
  await writeFile(join(root, "licenses/sources.lock.json"), JSON.stringify(lock));
  const library = Buffer.from("\x7fELFfixture");
  const hash = createHash("sha256").update(library).digest("hex");
  const libraryPath = join(root, "usr/local/lib/libexpat.so.1.12.4");
  await writeFile(libraryPath, library);
  await symlink("libexpat.so.1.12.4", join(root, "usr/local/lib/libexpat.so"));
  const metadata = {
    schemaVersion: 1,
    name: "expat",
    revision: lock.sources[0].revision,
    artifacts: [{ path: "/opt/hereisit-native/expat/lib/libexpat.so.1.12.4", sha256: hash }],
  };
  const metadataPath = join(root, "build-metadata/expat.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  return { root, hash, libraryPath, metadata, metadataPath };
}

it("catalogs production native sources with evidence from the shipped binary, excluding benchmark sources", async () => {
  const { root, hash } = await fixture();
  const sbom = await createImageNativeSbom(root);
  expect(sbom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 });
  expect(sbom.components).toHaveLength(1);
  expect(sbom.components[0]).toMatchObject({
    name: "expat",
    version: "2.8.4",
    purl: "pkg:generic/expat@2.8.4",
    evidence: { occurrences: [{ location: "/usr/local/lib/libexpat.so.1.12.4" }] },
  });
  expect(sbom.components[0].properties).toContainEqual({
    name: "hereisit:runtime-sha256:/usr/local/lib/libexpat.so.1.12.4",
    value: hash,
  });
});

it.each([
  "revision",
  "hash",
  "build-name",
  "artifact-path",
  "empty-artifacts",
])("rejects %s drift instead of describing an unproven native build", async (drift) => {
  const { root, metadata, metadataPath } = await fixture();
  if (drift === "revision") metadata.revision = "0".repeat(40);
  if (drift === "hash") metadata.artifacts[0].sha256 = "0".repeat(64);
  if (drift === "build-name") metadata.name = "wrong-source";
  if (drift === "artifact-path") metadata.artifacts[0].path = "/opt/unrelated/file";
  if (drift === "empty-artifacts") metadata.artifacts = [];
  await writeFile(metadataPath, JSON.stringify(metadata));
  await expect(createImageNativeSbom(root)).rejects.toThrow(/metadata|bound/i);
});

it("rejects missing binaries and links outside the assembled runtime", async () => {
  const { root, libraryPath } = await fixture();
  await rm(libraryPath);
  await expect(createImageNativeSbom(root)).rejects.toThrow();
  await symlink(process.execPath, libraryPath);
  await expect(createImageNativeSbom(root)).rejects.toThrow(/escapes/i);
});

it("writes the embedded SBOM once and refuses to overwrite build evidence", async () => {
  const { root } = await fixture();
  const args = ["scripts/create-image-native-sbom.mjs", root];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const path = join(root, "build-metadata/native.cdx.json");
  const bytes = await readFile(path, "utf8");
  expect(JSON.parse(bytes).components[0].name).toBe("expat");
  expect(spawnSync(process.execPath, args).status).toBe(1);
  expect(await readFile(path, "utf8")).toBe(bytes);
});
