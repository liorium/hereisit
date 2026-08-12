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
        metadata: { component: { type: "file", name: "raw" } },
        components: [{ name: "qpdf", version: "12.2.0" }],
      }),
    );
    await writeFile(
      trivyInput,
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "raw",
        ArtifactType: "image",
        Metadata: {},
        Results: [{ Target: "debian", Vulnerabilities: [{ VulnerabilityID: "CVE-X" }] }],
      }),
    );
    const hash = "a".repeat(64);
    await normalizeProcessingSecurityEvidence({
      scope: "pdf-engine",
      artifactSha256: hash,
      sbomInput,
      sbomOutput,
      trivyInput,
      trivyOutput,
    });
    const sbom = JSON.parse(await readFile(sbomOutput, "utf8"));
    const trivy = JSON.parse(await readFile(trivyOutput, "utf8"));
    expect(sbom.metadata.component).toMatchObject({
      name: `hereisit-pdf-engine:sha256-${hash}`,
      "bom-ref": `hereisit-pdf-engine:sha256-${hash}`,
    });
    expect(sbom.components).toEqual([{ name: "qpdf", version: "12.2.0" }]);
    expect(trivy).toMatchObject({
      ArtifactName: `hereisit-pdf-engine:sha256-${hash}`,
      ArtifactType: "container_image",
      Metadata: {
        ImageID: `sha256:${hash}`,
        RepoTags: [`hereisit-pdf-engine:sha256-${hash}`],
      },
    });
    expect(trivy.Results[0].Vulnerabilities).toHaveLength(1);
  });
});
