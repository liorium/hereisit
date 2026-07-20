import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../scripts/image-lab-common.mjs";
import {
  signCanonicalProcessingEvidence,
  verifyCanonicalProcessingEvidenceSignature,
} from "../scripts/processing-evidence-signature.mjs";

const temporaryRoots: string[] = [];

async function fixture(type: "ed25519" | "rsa" = "ed25519") {
  const root = await mkdtemp(join(tmpdir(), "hereisit-evidence-signature-"));
  temporaryRoots.push(root);
  const pair =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  const bundlePath = join(root, "evidence.json");
  const signaturePath = join(root, "evidence.sig");
  await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }), {
    mode: 0o644,
  });
  await writeFile(
    bundlePath,
    canonicalJson({ schema: "hereisit-processing-evidence@1", version: 1, passed: true }),
  );
  return { root, privateKeyPath, publicKeyPath, bundlePath, signaturePath };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing evidence Ed25519 signatures", () => {
  it("writes one detached signature and verifies the exact canonical JSON bytes", async () => {
    const value = await fixture();
    const signed = await signCanonicalProcessingEvidence({
      ...value,
      repositoryRoot: resolve("."),
    });

    expect(signed).toMatchObject({ bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await readFile(value.signaturePath)).byteLength).toBe(64);
    expect((await lstat(value.signaturePath)).mode & 0o777).toBe(0o600);
    await expect(
      verifyCanonicalProcessingEvidenceSignature({
        bundlePath: value.bundlePath,
        signaturePath: value.signaturePath,
        publicKeyPath: value.publicKeyPath,
      }),
    ).resolves.toEqual(signed);
  });

  it("rejects mutation, non-canonical JSON, wrong key type, and overwrites", async () => {
    const value = await fixture();
    await signCanonicalProcessingEvidence({ ...value, repositoryRoot: resolve(".") });
    await expect(
      signCanonicalProcessingEvidence({ ...value, repositoryRoot: resolve(".") }),
    ).rejects.toThrow(/exist|overwrite/i);
    await writeFile(
      value.bundlePath,
      canonicalJson({ schema: "hereisit-processing-evidence@1", version: 1, passed: false }),
    );
    await expect(
      verifyCanonicalProcessingEvidenceSignature({
        bundlePath: value.bundlePath,
        signaturePath: value.signaturePath,
        publicKeyPath: value.publicKeyPath,
      }),
    ).rejects.toThrow(/signature/i);
    await writeFile(value.bundlePath, '{"version":1, "schema":"hereisit-processing-evidence@1"}\n');
    await expect(
      verifyCanonicalProcessingEvidenceSignature({
        bundlePath: value.bundlePath,
        signaturePath: value.signaturePath,
        publicKeyPath: value.publicKeyPath,
      }),
    ).rejects.toThrow(/canonical|signature/i);

    const rsa = await fixture("rsa");
    await expect(
      signCanonicalProcessingEvidence({ ...rsa, repositoryRoot: resolve(".") }),
    ).rejects.toThrow(/Ed25519/i);
  });

  it("refuses to sign canonical JSON outside the processing evidence schema", async () => {
    const value = await fixture();
    await writeFile(value.bundlePath, canonicalJson({ schema: "other@1", version: 1 }));

    await expect(
      signCanonicalProcessingEvidence({ ...value, repositoryRoot: resolve(".") }),
    ).rejects.toThrow(/schema|version/i);
    await expect(lstat(value.signaturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an external mode-0600 regular private key without symbolic indirection", async () => {
    const value = await fixture();
    await chmod(value.privateKeyPath, 0o640);
    await expect(
      signCanonicalProcessingEvidence({ ...value, repositoryRoot: resolve(".") }),
    ).rejects.toThrow(/0600|permission/i);

    await chmod(value.privateKeyPath, 0o600);
    await expect(
      signCanonicalProcessingEvidence({ ...value, repositoryRoot: value.root }),
    ).rejects.toThrow(/outside.*repository/i);
    const linked = join(value.root, "linked-private.pem");
    await symlink(value.privateKeyPath, linked);
    await expect(
      signCanonicalProcessingEvidence({
        ...value,
        privateKeyPath: linked,
        repositoryRoot: resolve("."),
      }),
    ).rejects.toThrow(/symbolic/i);
  });
});
