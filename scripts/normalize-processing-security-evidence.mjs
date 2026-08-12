#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const scopes = new Set([
  "engine",
  "pdf-engine",
  "web-staging",
  "web-production",
  "worker",
  "lockfile",
]);

async function readJson(path, label) {
  const bytes = await readBoundedRegularFile(resolve(path), 8 * 1024 * 1024, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

export async function normalizeProcessingSecurityEvidence({
  scope,
  artifactSha256,
  sbomInput,
  sbomOutput,
  trivyInput,
  trivyOutput,
}) {
  if (!scopes.has(scope)) throw new TypeError("security evidence scope is invalid");
  assertSha256(artifactSha256, "security evidence artifact hash");
  const identity = `hereisit-${scope}:sha256-${artifactSha256}`;

  const sbom = assertObject(await readJson(sbomInput, "raw SBOM"), "raw SBOM");
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1) {
    throw new TypeError("raw SBOM identity is invalid");
  }
  const metadata = assertObject(sbom.metadata, "raw SBOM metadata");
  const component = assertObject(metadata.component, "raw SBOM source");
  metadata.component = { ...component, "bom-ref": identity, name: identity };

  const trivy = assertObject(
    await readJson(trivyInput, "raw vulnerability report"),
    "raw vulnerability report",
  );
  if (trivy.SchemaVersion !== 2 || !Array.isArray(trivy.Results)) {
    throw new TypeError("raw vulnerability report identity is invalid");
  }
  const container = scope === "engine" || scope === "pdf-engine";
  trivy.ArtifactName = identity;
  trivy.ArtifactType = container ? "container_image" : "filesystem";
  trivy.Metadata = container ? { ImageID: `sha256:${artifactSha256}`, RepoTags: [identity] } : {};

  await writeCanonicalJsonAtomic(resolve(sbomOutput), sbom, { refuseOverwrite: true, mode: 0o600 });
  await writeCanonicalJsonAtomic(resolve(trivyOutput), trivy, {
    refuseOverwrite: true,
    mode: 0o600,
  });
  return { artifactSha256, identity, scope };
}

export async function runNormalizeProcessingSecurityEvidenceCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(
    args,
    ["scope", "artifact-sha256", "sbom-input", "sbom-output", "trivy-input", "trivy-output"],
    "security evidence normalization arguments",
  );
  const result = await normalizeProcessingSecurityEvidence({
    scope: args.scope,
    artifactSha256: args["artifact-sha256"],
    sbomInput: args["sbom-input"],
    sbomOutput: args["sbom-output"],
    trivyInput: args["trivy-input"],
    trivyOutput: args["trivy-output"],
  });
  stdout.write(canonicalJson(result));
  return result;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runNormalizeProcessingSecurityEvidenceCli(process.argv.slice(2));
  } catch {
    process.stderr.write("security evidence normalization failed\n");
    process.exitCode = 1;
  }
}
