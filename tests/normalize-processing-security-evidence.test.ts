import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeProcessingSecurityEvidence } from "../scripts/normalize-processing-security-evidence.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("processing security evidence normalization", () => {
  it("binds actual scanner evidence to the reviewed artifact identity without dropping results", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-security-evidence-"));
    roots.push(root);
    const sbomInput = join(root, "sbom.raw.json");
    const trivyInput = join(root, "trivy.raw.json");
    const sbomOutput = join(root, "sbom.json");
    const trivyOutput = join(root, "trivy.json");
    await writeFile(
      sbomInput,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: { component: { type: "container", name: "hereisit-pdf-engine:exact" } },
        components: [{ name: "qpdf", version: "12.2.0" }],
      }),
    );
    await writeFile(
      trivyInput,
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "hereisit-pdf-engine:exact",
        ArtifactType: "container_image",
        Metadata: { ImageID: `sha256:${"a".repeat(64)}`, RepoTags: ["hereisit-pdf-engine:exact"] },
        Results: [{ Target: "debian", Vulnerabilities: [{ VulnerabilityID: "CVE-X" }] }],
      }),
    );
    const hash = "a".repeat(64);
    await normalizeProcessingSecurityEvidence({
      scope: "pdf-engine",
      artifactSha256: hash,
      expectedScannerArtifact: "hereisit-pdf-engine:exact",
      sbomInput,
      sbomOutput,
      trivyInput,
      trivyOutput,
    });
    const sbom = JSON.parse(await readFile(sbomOutput, "utf8"));
    const trivy = JSON.parse(await readFile(trivyOutput, "utf8"));
    expect(sbom.metadata.component).toEqual({
      type: "container",
      name: "hereisit-pdf-engine:exact",
    });
    expect(sbom.metadata.properties).toContainEqual({
      name: "hereisit:artifact:sha256",
      value: hash,
    });
    expect(sbom.components).toEqual([{ name: "qpdf", version: "12.2.0" }]);
    expect(trivy).toMatchObject({
      ArtifactName: "hereisit-pdf-engine:exact",
      ArtifactType: "container_image",
      Metadata: {
        ImageID: `sha256:${hash}`,
        RepoTags: ["hereisit-pdf-engine:exact"],
      },
      HereIsItArtifactSha256: hash,
    });
    expect(trivy.Results[0].Vulnerabilities).toHaveLength(1);
  });

  it("rejects a raw scanner identity that is not the independently computed artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-security-miswired-"));
    roots.push(root);
    const sbomInput = join(root, "sbom.raw.json");
    const trivyInput = join(root, "trivy.raw.json");
    await writeFile(
      sbomInput,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: { component: { type: "container", name: "wrong-image" } },
      }),
    );
    await writeFile(
      trivyInput,
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "wrong-image",
        ArtifactType: "container_image",
        Metadata: { ImageID: `sha256:${"b".repeat(64)}`, RepoTags: ["wrong-image"] },
        Results: [],
      }),
    );
    await expect(
      normalizeProcessingSecurityEvidence({
        scope: "pdf-engine",
        artifactSha256: "a".repeat(64),
        expectedScannerArtifact: "hereisit-pdf-engine:exact",
        sbomInput,
        sbomOutput: join(root, "sbom.json"),
        trivyInput,
        trivyOutput: join(root, "trivy.json"),
      }),
    ).rejects.toThrow(/identity|artifact|miswired/i);
  });

  it("rejects a miswired SBOM even when Trivy scanned the expected artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-sbom-miswired-"));
    roots.push(root);
    const sbomInput = join(root, "sbom.raw.json");
    const trivyInput = join(root, "trivy.raw.json");
    await writeFile(
      sbomInput,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: { component: { type: "container", name: "wrong-image" } },
      }),
    );
    await writeFile(
      trivyInput,
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "hereisit-pdf-engine:exact",
        ArtifactType: "container_image",
        Metadata: {
          ImageID: `sha256:${"a".repeat(64)}`,
          RepoTags: ["hereisit-pdf-engine:exact"],
        },
        Results: [],
      }),
    );
    await expect(
      normalizeProcessingSecurityEvidence({
        scope: "pdf-engine",
        artifactSha256: "a".repeat(64),
        expectedScannerArtifact: "hereisit-pdf-engine:exact",
        sbomInput,
        sbomOutput: join(root, "sbom.json"),
        trivyInput,
        trivyOutput: join(root, "trivy.json"),
      }),
    ).rejects.toThrow(/SBOM|identity|miswired/i);
  });

  it("normalizes Trivy's omitted empty result while rejecting explicit null", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-security-empty-"));
    roots.push(root);
    const sbomInput = join(root, "sbom.raw.json");
    const trivyInput = join(root, "trivy.raw.json");
    await writeFile(
      sbomInput,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: { component: { type: "file", name: "/repo/web" } },
      }),
    );
    const report = {
      SchemaVersion: 2,
      ArtifactName: "/repo/web",
      ArtifactType: "filesystem",
    };
    await writeFile(trivyInput, JSON.stringify(report));
    const trivyOutput = join(root, "trivy.json");
    await normalizeProcessingSecurityEvidence({
      scope: "web-staging",
      artifactSha256: "a".repeat(64),
      expectedScannerArtifact: "/repo/web",
      sbomInput,
      sbomOutput: join(root, "sbom.json"),
      trivyInput,
      trivyOutput,
    });
    expect(JSON.parse(await readFile(trivyOutput, "utf8")).Results).toEqual([]);

    await writeFile(trivyInput, JSON.stringify({ ...report, Results: null }));
    await expect(
      normalizeProcessingSecurityEvidence({
        scope: "web-staging",
        artifactSha256: "a".repeat(64),
        expectedScannerArtifact: "/repo/web",
        sbomInput,
        sbomOutput: join(root, "sbom-null.json"),
        trivyInput,
        trivyOutput: join(root, "trivy-null.json"),
      }),
    ).rejects.toThrow(/identity/i);
  });
});
