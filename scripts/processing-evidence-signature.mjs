import {
  createPrivateKey,
  createPublicKey,
  sign as createSignature,
  verify as verifySignature,
} from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";

const maximumBundleBytes = 8 * 1024 * 1024;
const maximumKeyBytes = 16 * 1024;
const signatureBytes = 64;

async function readCanonicalBundle(path) {
  const bytes = await readBoundedRegularFile(
    resolve(path),
    maximumBundleBytes,
    "processing evidence bundle",
  );
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError("processing evidence bundle is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("processing evidence bundle must be an object");
  }
  if (value.schema === "hereisit-processing-evidence@1" && value.version === 1) {
    // The existing release verifier owns the complete evidence schema. This signer binds bytes.
  } else if (value.schema === "hereisit-processing-deployment-report@1" && value.version === 1) {
    const { validateProcessingDeploymentReport } = await import(
      "./create-processing-deployment-report.mjs"
    );
    validateProcessingDeploymentReport(value);
  } else {
    throw new TypeError("processing evidence bundle schema or version is invalid");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new TypeError("processing evidence bundle is not canonical JSON");
  }
  return bytes;
}

async function assertExternalPrivateKey(privateKeyPath, repositoryRoot) {
  const requestedKey = resolve(privateKeyPath);
  const requestedRepository = resolve(repositoryRoot);
  const [canonicalKey, canonicalRepository] = await Promise.all([
    realpath(requestedKey),
    realpath(requestedRepository),
  ]);
  if (canonicalKey !== requestedKey) {
    throw new TypeError("processing evidence private key must not be symbolic");
  }
  const relation = relative(canonicalRepository, canonicalKey);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  ) {
    throw new TypeError("processing evidence private key must be outside the repository");
  }
  return readBoundedRegularFile(
    canonicalKey,
    maximumKeyBytes,
    "processing evidence private key",
    0o600,
  );
}

function assertEd25519Key(key, label) {
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${label} must be Ed25519`);
  return key;
}

async function writeDetachedSignature(path, bytes) {
  const requested = resolve(path);
  const parent = await realpath(dirname(requested));
  const destination = join(parent, basename(requested));
  if (destination !== requested) throw new TypeError("signature output parent must be canonical");
  const temporary = join(parent, `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, destination);
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error("signature output already exists; overwrite refused");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export async function signCanonicalProcessingEvidence({
  bundlePath,
  signaturePath,
  privateKeyPath,
  repositoryRoot,
}) {
  const [bundle, privateKeyBytes] = await Promise.all([
    readCanonicalBundle(bundlePath),
    assertExternalPrivateKey(privateKeyPath, repositoryRoot),
  ]);
  const privateKey = assertEd25519Key(
    createPrivateKey(privateKeyBytes),
    "processing evidence private key",
  );
  const signature = createSignature(null, bundle, privateKey);
  if (signature.byteLength !== signatureBytes) {
    throw new TypeError("processing evidence signature length is invalid");
  }
  await writeDetachedSignature(signaturePath, signature);
  return {
    bundleSha256: sha256Bytes(bundle),
    signatureSha256: sha256Bytes(signature),
  };
}

export async function verifyCanonicalProcessingEvidenceSignature({
  bundlePath,
  signaturePath,
  publicKeyPath,
}) {
  const [bundle, signature, publicKeyBytes] = await Promise.all([
    readCanonicalBundle(bundlePath),
    readBoundedRegularFile(resolve(signaturePath), signatureBytes, "processing evidence signature"),
    readBoundedRegularFile(
      resolve(publicKeyPath),
      maximumKeyBytes,
      "processing evidence public key",
    ),
  ]);
  if (signature.byteLength !== signatureBytes) {
    throw new TypeError("processing evidence signature length is invalid");
  }
  const publicKey = assertEd25519Key(
    createPublicKey(publicKeyBytes),
    "processing evidence public key",
  );
  if (!verifySignature(null, bundle, publicKey, signature)) {
    throw new TypeError("processing evidence signature is invalid");
  }
  return {
    bundleSha256: sha256Bytes(bundle),
    signatureSha256: sha256Bytes(signature),
  };
}

export async function runProcessingEvidenceSignatureCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  let result;
  if (args.mode === "sign") {
    assertExactKeys(
      args,
      ["mode", "bundle", "signature", "private-key", "repository-root"],
      "evidence signing arguments",
    );
    result = await signCanonicalProcessingEvidence({
      bundlePath: args.bundle,
      signaturePath: args.signature,
      privateKeyPath: args["private-key"],
      repositoryRoot: args["repository-root"],
    });
  } else if (args.mode === "verify") {
    assertExactKeys(
      args,
      ["mode", "bundle", "signature", "public-key"],
      "evidence verification arguments",
    );
    result = await verifyCanonicalProcessingEvidenceSignature({
      bundlePath: args.bundle,
      signaturePath: args.signature,
      publicKeyPath: args["public-key"],
    });
  } else {
    throw new TypeError("evidence signature mode must be sign or verify");
  }
  stdout.write(canonicalJson(result));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingEvidenceSignatureCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error && !("code" in error)
        ? error.message
        : "processing evidence signature failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
