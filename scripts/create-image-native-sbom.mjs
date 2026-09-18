import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { nativeCpe } from "./native-advisory-identities.mjs";
import { artifactSourceByPath, validateSourceLock } from "./verify-image-engine-licenses.mjs";

export async function createImageNativeSbom(root) {
  const runtimeRoot = await realpath(root);
  const lockBytes = await readBoundedRegularFile(
    join(runtimeRoot, "licenses/sources.lock.json"),
    1024 * 1024,
    "native source lock",
  );
  const lock = JSON.parse(lockBytes);
  validateSourceLock(lock);
  const components = [];
  for (const source of lock.sources.filter((entry) => entry.production)) {
    const cpe = nativeCpe(source.name, source.version);
    const properties = [{ name: "hereisit:source-revision", value: source.revision }];
    const occurrences = [];
    const buildName = source.name === "quantizr" ? "png-smart" : source.name;
    const metadata = JSON.parse(
      await readBoundedRegularFile(
        join(runtimeRoot, source.artifactRecord),
        1024 * 1024,
        "native build metadata",
      ),
    );
    if (
      metadata?.schemaVersion !== 1 ||
      metadata.name !== buildName ||
      metadata.revision !== source.revision ||
      !Array.isArray(metadata.artifacts) ||
      metadata.artifacts.length === 0
    )
      throw new TypeError(`native build metadata is invalid: ${source.name}`);
    for (const [path, name] of artifactSourceByPath) {
      if (name !== buildName) continue;
      const resolvedPath = await realpath(join(runtimeRoot, path));
      if (!resolvedPath.startsWith(`${runtimeRoot}${sep}`))
        throw new TypeError("native artifact escapes runtime root");
      const bytes = await readBoundedRegularFile(
        resolvedPath,
        128 * 1024 * 1024,
        "native artifact",
      );
      const location = `/${relative(runtimeRoot, resolvedPath)}`;
      const hash = sha256Bytes(bytes);
      const buildPath = `/opt/hereisit-native/${buildName}/${relative("/usr/local", location)}`;
      if (
        !metadata.artifacts.some(
          (artifact) => artifact?.path === buildPath && artifact.sha256 === hash,
        )
      )
        throw new TypeError(`native artifact is not bound to build metadata: ${source.name}`);
      occurrences.push({ location });
      properties.push({ name: `hereisit:runtime-sha256:${location}`, value: hash });
    }
    if (occurrences.length === 0)
      throw new TypeError(`native artifact mapping missing: ${source.name}`);
    components.push({
      "bom-ref": `native:${source.name}@${source.revision}`,
      type: "library",
      name: source.name,
      version: source.version,
      purl: `pkg:generic/${encodeURIComponent(source.name)}@${encodeURIComponent(source.version)}`,
      ...(cpe === undefined ? {} : { cpe }),
      licenses: [{ expression: source.licenses.join(" AND ") }],
      externalReferences: [{ type: "vcs", url: `${source.repository}#${source.revision}` }],
      evidence: { occurrences },
      properties,
    });
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      properties: [{ name: "hereisit:source-lock:sha256", value: sha256Bytes(lockBytes) }],
    },
    components,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new TypeError("runtime root is required");
    const root = resolve(process.argv[2]);
    await writeCanonicalJsonAtomic(
      join(root, "build-metadata/native.cdx.json"),
      await createImageNativeSbom(root),
      {
        refuseOverwrite: true,
      },
    );
  } catch {
    process.stderr.write("native SBOM generation failed\n");
    process.exitCode = 1;
  }
}
