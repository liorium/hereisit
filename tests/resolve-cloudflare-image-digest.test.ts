import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  candidateIdentityFromManifest,
  resolveCloudflareImageDigest,
  resolveCloudflareImageDigestFromConfig,
} from "../scripts/resolve-cloudflare-image-digest.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const imageRef = `registry.cloudflare.com/${accountId}/hereisit-image-engine:${"a".repeat(40)}`;
const pdfImageRef = `registry.cloudflare.com/${accountId}/hereisit-pdf-engine:${"a".repeat(40)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;
const configDigest = `sha256:${"c".repeat(64)}`;
const buildSpecificImageRef = `${imageRef}-${configDigest.slice("sha256:".length)}`;
const distributionLayerDigests = [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`];
const diffIds = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
const candidateIdentity = { configDigest, distributionLayerDigests };

function artifact(path: string, sha256: string) {
  return { path, sizeBytes: 1, sha256 };
}

function securityAssets() {
  const scoped = (prefix: string, suffix: string) => ({
    engine: artifact(`${prefix}engine${suffix}`, "1".repeat(64)),
    webStaging: artifact(`${prefix}web-staging${suffix}`, "2".repeat(64)),
    webProduction: artifact(`${prefix}web-production${suffix}`, "3".repeat(64)),
    worker: artifact(`${prefix}worker${suffix}`, "4".repeat(64)),
    lockfile: artifact(`${prefix}lockfile${suffix}`, "5".repeat(64)),
  });
  return {
    gates: {
      imageEngine: artifact("security-image-engine-license-gate.json", "6".repeat(64)),
      applicationSupplyChain: artifact(
        "security-application-supply-chain-gate.json",
        "7".repeat(64),
      ),
      vulnerability: artifact("security-vulnerability-gate.json", "8".repeat(64)),
    },
    sboms: scoped("security-sbom-", ".cdx.json"),
    vulnerabilityReports: scoped("security-trivy-", ".json"),
  };
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
    processingApiOrigin: "https://api.hereisit.app",
  };
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha,
    engine: {
      loadedImage: `hereisit-image-engine:${gitSha}`,
      oci: { ...candidateIdentity, diffIds },
      docker: { configDigest, diffIds },
    },
    web: { staging, production },
    security: { trivyDbDigest: `sha256:${"5".repeat(64)}` },
    providerUsage: { schemaSha256: "6".repeat(64) },
    releaseInputs: { sha256: "d".repeat(64) },
    costModel: { sha256: "e".repeat(64) },
    releaseAssets: {
      report: artifact("processing-release-report.json", "7".repeat(64)),
      engine: {
        oci: artifact("image-engine-linux-amd64.oci.tar", "8".repeat(64)),
        docker: artifact("image-engine-linux-amd64.docker.tar", "9".repeat(64)),
      },
      worker: artifact("api-worker.mjs", "a".repeat(64)),
      releaseInputs: artifact("processing-release-inputs.json", "d".repeat(64)),
      costModel: artifact("live-cost-model.json", "e".repeat(64)),
      web: {
        staging: { path: "web-staging.tar", sizeBytes: 1, ...staging },
        production: { path: "web-production.tar", sizeBytes: 1, ...production },
      },
      security: securityAssets(),
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
  layers = distributionLayerDigests,
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

  it("binds a direct deployment to its local Docker config digest", () => {
    expect(
      resolveCloudflareImageDigestFromConfig({
        manifest: descriptor(),
        imageRef,
        accountId,
        expectedConfigDigest: configDigest,
      }),
    ).toBe(`registry.cloudflare.com/${accountId}/hereisit-image-engine@${manifestDigest}`);

    expect(() =>
      resolveCloudflareImageDigestFromConfig({
        manifest: descriptor(),
        imageRef,
        accountId,
        expectedConfigDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).toThrow(/config/i);
  });

  it("resolves the PDF engine repository without accepting it as an image candidate", () => {
    const pdfManifest = descriptor({ ref: pdfImageRef });
    expect(
      resolveCloudflareImageDigestFromConfig({
        manifest: pdfManifest,
        imageRef: pdfImageRef,
        accountId,
        expectedConfigDigest: configDigest,
      }),
    ).toBe(`registry.cloudflare.com/${accountId}/hereisit-pdf-engine@${manifestDigest}`);
    expect(() =>
      resolveCloudflareImageDigest({
        manifest: pdfManifest,
        imageRef: pdfImageRef,
        accountId,
        candidateIdentity,
      }),
    ).toThrow(/repository/i);
  });

  it("binds a build-specific tag suffix to the same local config digest", () => {
    expect(
      resolveCloudflareImageDigestFromConfig({
        manifest: descriptor({ ref: buildSpecificImageRef }),
        imageRef: buildSpecificImageRef,
        accountId,
        expectedConfigDigest: configDigest,
      }),
    ).toBe(`registry.cloudflare.com/${accountId}/hereisit-image-engine@${manifestDigest}`);

    expect(() =>
      resolveCloudflareImageDigestFromConfig({
        manifest: descriptor({ ref: buildSpecificImageRef }),
        imageRef: buildSpecificImageRef,
        accountId,
        expectedConfigDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).toThrow(/tag config/i);
  });

  it("accepts the tag-only Ref Docker returns for a single manifest", () => {
    const manifest = descriptor({ ref: imageRef });

    expect(resolveCloudflareImageDigest({ manifest, imageRef, accountId, candidateIdentity })).toBe(
      `registry.cloudflare.com/${accountId}/hereisit-image-engine@${manifestDigest}`,
    );
    expect(
      resolveCloudflareImageDigestFromConfig({
        manifest,
        imageRef,
        accountId,
        expectedConfigDigest: configDigest,
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
      descriptor({ layers: [...distributionLayerDigests].reverse() }),
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
