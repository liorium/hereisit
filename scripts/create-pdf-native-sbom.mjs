import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { validatePdfSourceLock } from "./verify-pdf-engine-licenses.mjs";

export async function createPdfNativeSbom(root, buildRoot) {
  const runtimeRoot = await realpath(root);
  const nativeBuildRoot = await realpath(buildRoot);
  const lockBytes = await readBoundedRegularFile(
    join(runtimeRoot, "licenses/sources.lock.json"),
    1024 * 1024,
    "PDF native source lock",
  );
  const buildLockBytes = await readBoundedRegularFile(
    join(nativeBuildRoot, "source-lock.json"),
    1024 * 1024,
    "PDF build source lock",
  );
  if (!lockBytes.equals(buildLockBytes))
    throw new TypeError("PDF runtime source lock is not bound to build");
  const source = validatePdfSourceLock(JSON.parse(lockBytes));
  const occurrences = [];
  const properties = [{ name: "hereisit:source-archive:sha256", value: source.sha256 }];
  for (const path of ["bin/qpdf", "lib/libqpdf.so.30"]) {
    const resolvedPath = await realpath(join(runtimeRoot, "usr/local", path));
    if (!resolvedPath.startsWith(`${runtimeRoot}/usr/local/`))
      throw new TypeError("PDF native artifact escapes runtime root");
    const bytes = await readBoundedRegularFile(
      resolvedPath,
      128 * 1024 * 1024,
      "PDF native artifact",
    );
    const buildPath = await realpath(join(nativeBuildRoot, path));
    if (!buildPath.startsWith(`${nativeBuildRoot}${sep}`))
      throw new TypeError("PDF native artifact escapes build root");
    const buildBytes = await readBoundedRegularFile(
      buildPath,
      128 * 1024 * 1024,
      "PDF build artifact",
    );
    if (!bytes.equals(buildBytes))
      throw new TypeError("PDF runtime artifact is not bound to build");
    const location = `/${relative(runtimeRoot, resolvedPath)}`;
    occurrences.push({ location });
    properties.push({ name: `hereisit:runtime-sha256:${location}`, value: sha256Bytes(bytes) });
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      properties: [{ name: "hereisit:source-lock:sha256", value: sha256Bytes(lockBytes) }],
    },
    components: [
      {
        "bom-ref": `native:qpdf@${source.sha256}`,
        type: "library",
        name: source.name,
        version: source.version,
        purl: `pkg:generic/qpdf@${source.version}`,
        licenses: [{ expression: source.license }],
        externalReferences: [
          {
            type: "distribution",
            url: source.url,
            hashes: [{ alg: "SHA-256", content: source.sha256 }],
          },
        ],
        evidence: { occurrences },
        properties,
      },
    ],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) throw new TypeError("runtime and build roots are required");
    const root = resolve(process.argv[2]);
    await writeCanonicalJsonAtomic(
      join(root, "build-metadata/native.cdx.json"),
      await createPdfNativeSbom(root, process.argv[3]),
      { refuseOverwrite: true },
    );
  } catch {
    process.stderr.write("PDF native SBOM generation failed\n");
    process.exitCode = 1;
  }
}
