import { describe, expect, it } from "vitest";
import { resolveCloudflareImageDigest } from "../scripts/resolve-cloudflare-image-digest.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const imageRef = `registry.cloudflare.com/${accountId}/hereisit-image-engine:${"a".repeat(40)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;
const configDigest = `sha256:${"c".repeat(64)}`;
const layerDigests = [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`];
const candidateIdentity = { configDigest, layerDigests };

function descriptor({
  digest = manifestDigest,
  os = "linux",
  architecture = "amd64",
  ref = `${imageRef}@${digest}`,
  config = configDigest,
  layers = layerDigests,
} = {}) {
  return {
    Ref: ref,
    Descriptor: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: 123,
      platform: { os, architecture },
    },
    SchemaV2Manifest: {
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: config,
        size: 12,
      },
      layers: layers.map((layerDigest) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layerDigest,
        size: 34,
      })),
    },
  };
}

describe("Cloudflare image digest resolver", () => {
  it("resolves a single exact linux/amd64 registry descriptor", () => {
    expect(
      resolveCloudflareImageDigest({
        manifest: descriptor(),
        imageRef,
        accountId,
        candidateIdentity,
      }),
    ).toBe(`registry.cloudflare.com/${accountId}/hereisit-image-engine@${manifestDigest}`);
  });

  it("selects one runnable image while ignoring unknown-platform attestations", () => {
    const attestationDigest = `sha256:${"f".repeat(64)}`;
    const attestation = descriptor({
      digest: attestationDigest,
      os: "unknown",
      architecture: "unknown",
      ref: `${imageRef}@${attestationDigest}`,
      config: `sha256:${"1".repeat(64)}`,
      layers: [],
    });

    expect(
      resolveCloudflareImageDigest({
        manifest: [attestation, descriptor()],
        imageRef,
        accountId,
        candidateIdentity,
      }),
    ).toContain(`@${manifestDigest}`);
  });

  it.each([
    ["zero amd64", [descriptor({ os: "unknown", architecture: "unknown" })]],
    ["multiple amd64", [descriptor(), descriptor()]],
    ["known foreign platform", [descriptor(), descriptor({ os: "linux", architecture: "arm64" })]],
  ])("rejects %s descriptors", (_label, manifest) => {
    expect(() =>
      resolveCloudflareImageDigest({ manifest, imageRef, accountId, candidateIdentity }),
    ).toThrow(/platform|amd64|descriptor/i);
  });

  it.each([
    ["wrong registry", imageRef.replace("registry.cloudflare.com", "example.com"), accountId],
    ["wrong account", imageRef, "f".repeat(32)],
    ["mutable repository ref", `${imageRef.split(":")[0]}:latest`, accountId],
  ])("rejects %s", (_label, requestedRef, requestedAccount) => {
    expect(() =>
      resolveCloudflareImageDigest({
        manifest: descriptor(),
        imageRef: requestedRef,
        accountId: requestedAccount,
        candidateIdentity,
      }),
    ).toThrow();
  });

  it("rejects selected Ref, digest, config, and ordered-layer mismatches", () => {
    for (const badManifest of [
      descriptor({ ref: `${imageRef}@sha256:${"9".repeat(64)}` }),
      descriptor({ digest: "sha512:bad" }),
      descriptor({ config: `sha256:${"7".repeat(64)}` }),
      descriptor({ layers: [...layerDigests].reverse() }),
    ]) {
      expect(() =>
        resolveCloudflareImageDigest({
          manifest: badManifest,
          imageRef,
          accountId,
          candidateIdentity,
        }),
      ).toThrow();
    }
  });
});
