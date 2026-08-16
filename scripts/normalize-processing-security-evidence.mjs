#!/usr/bin/env node

import { basename, resolve } from "node:path";
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
  expectedScannerArtifact,
  sbomInput,
  sbomOutput,
  trivyInput,
  trivyOutput,
}) {
  if (!scopes.has(scope)) throw new TypeError("security evidence scope is invalid");
  assertSha256(artifactSha256, "security evidence artifact hash");
  if (typeof expectedScannerArtifact !== "string" || expectedScannerArtifact.length < 1)
    throw new TypeError("expected scanner artifact identity is required");
  const identity = `hereisit-${scope}:sha256-${artifactSha256}`;

  const sbom = assertObject(await readJson(sbomInput, "raw SBOM"), "raw SBOM");
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1) {
    throw new TypeError("raw SBOM identity is invalid");
  }
  const metadata = assertObject(sbom.metadata, "raw SBOM metadata");
  const component = assertObject(metadata.component, "raw SBOM source");
  if (
    component.name !== expectedScannerArtifact &&
    component.name !== basename(expectedScannerArtifact)
  )
    throw new TypeError("raw SBOM scanner artifact identity is miswired");
  const properties = metadata.properties ?? [];
  if (!Array.isArray(properties)) throw new TypeError("raw SBOM properties are invalid");
  metadata.properties = [
    ...properties,
    { name: "hereisit:artifact:sha256", value: artifactSha256 },
  ];

  const trivy = assertObject(
    await readJson(trivyInput, "raw vulnerability report"),
    "raw vulnerability report",
  );
  if (trivy.SchemaVersion !== 2 || (trivy.Results !== undefined && !Array.isArray(trivy.Results))) {
    throw new TypeError("raw vulnerability report identity is invalid");
  }
  trivy.Results ??= [];
  const container = scope === "engine" || scope === "pdf-engine";
  if (
    trivy.ArtifactName !== expectedScannerArtifact ||
    trivy.ArtifactType !== (container ? "container_image" : "filesystem")
  )
    throw new TypeError("raw Trivy scanner artifact identity is miswired");
  if (container) {
    const rawMetadata = assertObject(trivy.Metadata, "raw Trivy image metadata");
    if (rawMetadata.ImageID !== `sha256:${artifactSha256}`)
      throw new TypeError("raw Trivy image digest is miswired");
  }
  trivy.HereIsItArtifactSha256 = artifactSha256;

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
    [
      "scope",
      "artifact-sha256",
      "expected-scanner-artifact",
      "sbom-input",
      "sbom-output",
      "trivy-input",
      "trivy-output",
    ],
    "security evidence normalization arguments",
  );
  const result = await normalizeProcessingSecurityEvidence({
    scope: args.scope,
    artifactSha256: args["artifact-sha256"],
    expectedScannerArtifact: args["expected-scanner-artifact"],
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
