import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  parseCliArguments,
} from "./image-lab-common.mjs";

const artifactLimits = Object.freeze({
  attestation: 64 * 1024,
  config: 2 * 1024 * 1024,
});

async function hashFile(file, maximumBytes, label) {
  if (typeof file !== "string" || file.length === 0) {
    throw new TypeError(`${label} file is required`);
  }
  let handle;
  try {
    handle = await open(file, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError(`${label} input must be a regular file`);
    if (metadata.size > maximumBytes) throw new RangeError(`${label} exceeds the maximum size`);
    const hash = createHash("sha256");
    const buffer = new Uint8Array(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new RangeError(`${label} exceeds the maximum size`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new Error(`${label} input could not be read`);
  } finally {
    await handle?.close();
  }
}

export async function verifyDeploymentGateArtifacts(inputValue) {
  const input = assertObject(inputValue, "deployment gate artifacts");
  assertExactKeys(
    input,
    ["attestationFile", "attestationSha256", "configFile", "configSha256"],
    "deployment gate artifacts",
  );
  const expectedAttestation = assertSha256(input.attestationSha256, "attestation SHA-256");
  const expectedConfig = assertSha256(input.configSha256, "Wrangler config SHA-256");
  const [actualAttestation, actualConfig] = await Promise.all([
    hashFile(input.attestationFile, artifactLimits.attestation, "Worker version attestation"),
    hashFile(input.configFile, artifactLimits.config, "Wrangler config"),
  ]);
  if (actualAttestation !== expectedAttestation) {
    throw new Error("Worker version attestation hash does not match");
  }
  if (actualConfig !== expectedConfig) throw new Error("Wrangler config hash does not match");
  return { verified: true };
}

export async function runDeploymentGateArtifactCli(argv) {
  const args = parseCliArguments(argv);
  const required = ["attestation", "attestation-sha256", "config", "config-sha256"];
  if (Object.keys(args).some((key) => !required.includes(key))) {
    throw new TypeError("unknown deployment gate artifact argument");
  }
  for (const name of required) {
    if (args[name] === undefined) throw new TypeError(`--${name} is required`);
  }
  return verifyDeploymentGateArtifacts({
    attestationFile: resolve(args.attestation),
    attestationSha256: args["attestation-sha256"],
    configFile: resolve(args.config),
    configSha256: args["config-sha256"],
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await runDeploymentGateArtifactCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "deployment gate artifact verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
