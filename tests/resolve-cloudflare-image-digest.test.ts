import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  candidateIdentityFromManifest,
  resolveCloudflareImageDigest,
} from "../scripts/resolve-cloudflare-image-digest.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const imageRef = `registry.cloudflare.com/${accountId}/hereisit-image-engine:${"a".repeat(40)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;
const configDigest = `sha256:${"c".repeat(64)}`;
const layerDigests = [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`];
const candidateIdentity = { configDigest, layerDigests };

function artifact(path: string, sha256: string) {
  return { path, sizeBytes: 1, sha256 };
}

function finalizedCandidate() {
  const releaseId = "2026-07-20.1";
  const gitSha = "a".repeat(40);
  const staging = {
    archiveSha256: "1".repeat(64),
    treeSha256: "2".repeat(64),
    processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
  };
  const production = {
    archiveSha256: "3".repeat(64),
    treeSha256: "4".repeat(64),
    processingApiOrigin: "https://hereisit-processing-production.liorium.workers.dev",
  };
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha,
    engine: {
      loadedImage: `hereisit-image-engine:${gitSha}`,
      oci: candidateIdentity,
      docker: candidateIdentity,
    },
    web: { staging, production },
    security: { trivyDbDigest: `sha256:${"5".repeat(64)}` },
    providerUsage: { schemaSha256: "6".repeat(64) },
    releaseAssets: {
      report: artifact("processing-release-report.json", "7".repeat(64)),
      engine: {
        oci: artifact("image-engine-linux-amd64.oci.tar", "8".repeat(64)),
        docker: artifact("image-engine-linux-amd64.docker.tar", "9".repeat(64)),
      },
      worker: artifact("api-worker.mjs", "a".repeat(64)),
      web: {
        staging: { path: "web-staging.tar", sizeBytes: 1, ...staging },
        production: { path: "web-production.tar", sizeBytes: 1, ...production },
      },
      evidence: {
        bundle: artifact(`evidence-v1--${releaseId}--processing-evidence.json`, "b".repeat(64)),
        signature: artifact(`evidence-v1--${releaseId}--processing-evidence.sig`, "c".repeat(64)),
      },
    },
  };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

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
  it("reads the OCI identity only from a fully verified finalized candidate", () => {
    const candidate = finalizedCandidate();
    expect(candidateIdentityFromManifest(candidate)).toEqual(candidateIdentity);

    candidate.engine.loadedImage = "hereisit-image-engine:tampered";
    expect(() => candidateIdentityFromManifest(candidate)).toThrow(/verification/i);
  });

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
