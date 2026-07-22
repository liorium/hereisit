import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/processing-staging.yml", "utf8");

function job(name: string) {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start, `${name} job is missing`).toBeGreaterThanOrEqual(0);
  const tail = workflow.slice(start + name.length + 4);
  const end = tail.search(/^ {2}[a-z0-9-]+:\s*$/m);
  return end < 0 ? tail : tail.slice(0, end);
}

describe("processing staging workflow phase A", () => {
  it("keeps build and release verification credential-isolated", () => {
    for (const body of [job("build"), job("verify-release")]) {
      expect(body).not.toContain("environment: processing-staging");
      expect(body).not.toContain("secrets.");
      expect(body).toContain("github.repository == 'liorium/hereisit'");
      expect(body).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it("builds one linux amd64 image and every candidate security input", () => {
    const build = job("build");
    expect(build.match(/docker buildx build/g)).toHaveLength(1);
    expect(build).toContain("--platform linux/amd64");
    expect(build).toContain("type=oci,dest=.artifacts/build/image-engine-linux-amd64.oci.tar");
    expect(build).toContain(
      "type=docker,dest=.artifacts/build/image-engine-linux-amd64.docker.tar",
    );
    expect(build.match(/security-sbom-[a-z-]+\.cdx\.json/g)?.length).toBeGreaterThanOrEqual(10);
    expect(build.match(/security-trivy-[a-z-]+\.json/g)?.length).toBeGreaterThanOrEqual(10);
    expect(build).toContain("security-image-engine-license-gate.json");
    expect(build).toContain("security-application-supply-chain-gate.json");
    expect(build).toContain("security-vulnerability-gate.json");
    expect(build.match(/rm -rf apps\/web\/\.next apps\/web\/out/g)).toHaveLength(2);
    expect(build).toContain("--required-state built");
  });

  it("uses genuine pinned scanner identities without rewriting reports", () => {
    const build = job("build");
    expect(workflow).toContain("ghcr.io/anchore/syft@sha256:");
    expect(workflow).toContain("ghcr.io/aquasecurity/trivy@sha256:");
    expect(build).toContain("docker buildx imagetools inspect");
    expect(build).toContain('TRIVY_DB_DIGEST="$(');
    expect(build).toContain('"hereisit-engine:sha256-$ENGINE_CONFIG_SHA256"');
    expect(build).toContain("image --image-src docker");
    expect(build).not.toContain("report.ArtifactName");
    expect(build).not.toContain("report.Trivy");
  });

  it("materializes and independently verifies the exact finalized release", () => {
    const verify = job("verify-release");
    expect(verify).toContain('--pattern "candidate-v1--$RELEASE_ID--*"');
    expect(verify).toContain('--pattern "evidence-v1--$RELEASE_ID--*"');
    expect(verify).toContain('git cat-file -t "$RELEASE_TAG"');
    expect(verify).toContain('git rev-parse "$RELEASE_TAG^{commit}"');
    expect(verify).toContain("node scripts/materialize-processing-release-candidate.mjs");
    expect(verify).toContain("node scripts/resolve-github-release-assets.mjs");
    expect(verify).toContain("--required-state finalized");
    expect(verify).toContain("node scripts/verify-processing-release-report.mjs");
    expect(verify).toContain("node scripts/processing-evidence-signature.mjs");
    expect(verify).toContain("--mode verify");
    expect(workflow).not.toContain("--mode sign");
    expect(workflow).not.toContain("--private-key");
  });

  it("publishes only the verified candidate for seven days", () => {
    const verify = job("verify-release");
    expect(verify).toContain("path: .artifacts/candidate");
    expect(verify).toContain("compression-level: 0");
    expect(verify).toContain("if-no-files-found: error");
    expect(verify).toContain("retention-days: 7");
    expect(verify).toMatch(/artifact_digest: \$\{\{ steps\.publish\.outputs\.artifact-digest \}\}/);
  });
});
