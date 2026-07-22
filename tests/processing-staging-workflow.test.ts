import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/processing-staging.yml";
let workflow = "";

function jobBody(name: string) {
  const header = `  ${name}:\n`;
  const start = workflow.indexOf(header);
  expect(start, `${name} job is missing`).toBeGreaterThanOrEqual(0);
  const tail = workflow.slice(start + header.length);
  const nextJob = tail.search(/^ {2}[a-z0-9-]+:\s*$/m);
  return nextJob < 0 ? tail : tail.slice(0, nextJob);
}

function actionStep(job: string, action: string) {
  const start = job.indexOf(`- uses: ${action}`);
  expect(start, `${action} step is missing`).toBeGreaterThanOrEqual(0);
  const tail = job.slice(start);
  const nextStep = tail.slice(1).search(/^ {6}- /m);
  return nextStep < 0 ? tail : tail.slice(0, nextStep + 1);
}

function expectMainRepositoryGate(job: string, mode: "build" | "deploy") {
  expect(job).toContain(`inputs.mode == '${mode}'`);
  expect(job).toContain("github.repository == 'liorium/hereisit'");
  expect(job).toContain("github.ref == 'refs/heads/main'");
}

beforeAll(() => {
  expect(existsSync(workflowPath), `${workflowPath} must be checked in`).toBe(true);
  workflow = readFileSync(workflowPath, "utf8");
});

describe("processing staging workflow", () => {
  it("is manual, main-only, repository-bound, and exposes only build/deploy modes", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("type: choice");
    expect(workflow).toMatch(/options:\s*(?:\[build,\s*deploy\]|\n\s+- build\n\s+- deploy)/);
    expect(workflow).toContain("permissions:\n  actions: read\n  contents: read");
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule):/m);

    expectMainRepositoryGate(jobBody("build"), "build");
    expectMainRepositoryGate(jobBody("verify-release"), "deploy");
    expectMainRepositoryGate(jobBody("deploy"), "deploy");
  });

  it("keeps build and release verification outside the protected Cloudflare environment", () => {
    const build = jobBody("build");
    const verify = jobBody("verify-release");
    const deploy = jobBody("deploy");

    expect(build).not.toContain("environment: processing-staging");
    expect(build).not.toContain("secrets.");
    expect(verify).not.toContain("environment: processing-staging");
    expect(verify).not.toContain("secrets.CLOUDFLARE");
    expect(workflow.indexOf("  verify-release:\n")).toBeLessThan(workflow.indexOf("  deploy:\n"));
    expect(deploy).toContain("needs: verify-release");
    expect(deploy).toContain("environment: processing-staging");
    expect(deploy.slice(0, deploy.indexOf("    steps:"))).not.toContain("secrets.");
  });

  it("binds same-run artifact bytes through native and independent exact-ID downloads", () => {
    const deploy = jobBody("deploy");
    const native = actionStep(deploy, "actions/download-artifact@");
    const independent = deploy.indexOf("node scripts/download-and-verify-github-artifact.mjs");

    expect(native).toContain(`artifact-ids: \${{ needs.verify-release.outputs.artifact_id }}`);
    expect(native).toContain("path: .artifacts/native-download");
    expect(independent).toBeGreaterThan(deploy.indexOf("actions/download-artifact@"));
    expect(deploy).toContain('[[ "$ARTIFACT_DIGEST" =~ ^([0-9a-f]{64})$ ]]');
    expect(deploy).not.toContain('ARTIFACT_DIGEST" =~ ^sha256:');
    for (const binding of [
      '--repo "$GITHUB_REPOSITORY"',
      '--run-id "$GITHUB_RUN_ID"',
      '--expected-head-sha "$GITHUB_SHA"',
      '--expected-artifact-id "$ARTIFACT_ID"',
      "--allow-in-progress true",
      "--output-dir .artifacts/candidate",
    ]) {
      expect(deploy.slice(independent)).toContain(binding);
    }
  });

  it("resolves and verifies the complete finalized signed release before mutation", () => {
    const verify = jobBody("verify-release");
    const candidate = verify.indexOf("node scripts/verify-processing-candidate.mjs");
    const report = verify.indexOf("node scripts/verify-processing-release-report.mjs");
    const signature = verify.indexOf("node scripts/processing-evidence-signature.mjs");

    expect(verify).toContain("node scripts/resolve-github-release-assets.mjs");
    expect(candidate).toBeGreaterThanOrEqual(0);
    expect(verify.slice(candidate)).toContain("--required-state finalized");
    expect(report).toBeGreaterThan(candidate);
    expect(signature).toBeGreaterThan(report);
    expect(verify.slice(signature)).toContain("--mode verify");
    expect(verify.slice(signature)).toContain("processing-evidence.sig");
    expect(verify.slice(signature)).toContain(
      "docs/deployment/processing-evidence-ed25519-public.pem",
    );

    for (const asset of [
      "security-image-engine-license-gate.json",
      "security-application-supply-chain-gate.json",
      "security-vulnerability-gate.json",
      "security-sbom-engine.cdx.json",
      "security-sbom-web-staging.cdx.json",
      "security-sbom-web-production.cdx.json",
      "security-sbom-worker.cdx.json",
      "security-sbom-lockfile.cdx.json",
      "security-trivy-engine.json",
      "security-trivy-web-staging.json",
      "security-trivy-web-production.json",
      "security-trivy-worker.json",
      "security-trivy-lockfile.json",
    ]) {
      expect(verify).toContain(asset);
    }

    expect(workflow).not.toContain("--mode sign");
    expect(workflow).not.toContain("--private-key");
    expect(workflow).not.toMatch(/PRIVATE(?:_|-)KEY/);
  });

  it("deploys at zero rollout and resumes only the primary queue after attestation", () => {
    const deploy = jobBody("deploy");
    const resolveDigest = deploy.indexOf("node scripts/resolve-cloudflare-image-digest.mjs");
    const provision = deploy.indexOf("node scripts/ensure-cloudflare-processing-resources.mjs");
    const deployments = [...deploy.matchAll(/pnpm exec wrangler deploy/g)];
    const finalDeployment = deploy.lastIndexOf("pnpm exec wrangler deploy");
    const secretVerification = deploy.indexOf("node scripts/verify-worker-secret-list.mjs");
    const versionAttestation = deploy.lastIndexOf("node scripts/verify-worker-version-chain.mjs");
    const attestationApplication = deploy.indexOf(
      "node scripts/apply-worker-version-attestations.mjs",
    );
    const resumePrimary = deploy.indexOf('pnpm exec wrangler queues resume-delivery "$QUEUE_NAME"');
    const verifyPrimary = deploy.indexOf('--queue "$QUEUE_NAME" --expected resumed');
    const verifyDlq = deploy.indexOf('--queue "$DLQ_NAME" --expected paused');
    const resumeCommands = [
      ...workflow.matchAll(/^\s*pnpm exec wrangler queues resume-delivery .+$/gm),
    ].map(([command]) => command.trim());

    expect(resolveDigest).toBeGreaterThanOrEqual(0);
    expect(provision).toBeGreaterThan(resolveDigest);
    expect(deploy).toContain(".artifacts/deployment/cloudflare-image-digest.txt");
    expect(deploy).toContain('--engine-image "$ENGINE_IMAGE"');
    expect(deploy).toContain("generate_config bootstrap");
    expect(deploy).toContain("generate_config active");
    expect(deploy).toContain("--rollout-percent 0");
    expect(deploy).not.toMatch(/--rollout-percent (?!0\b)\d+/);
    expect(deployments.length).toBeGreaterThanOrEqual(2);
    expect(secretVerification).toBeGreaterThanOrEqual(0);
    expect(versionAttestation).toBeGreaterThan(finalDeployment);
    expect(attestationApplication).toBeGreaterThan(versionAttestation);
    expect(resumePrimary).toBeGreaterThan(finalDeployment);
    expect(resumePrimary).toBeGreaterThan(secretVerification);
    expect(resumePrimary).toBeGreaterThan(attestationApplication);
    expect(verifyPrimary).toBeGreaterThan(resumePrimary);
    expect(verifyDlq).toBeGreaterThan(resumePrimary);
    expect(resumeCommands).toEqual(['pnpm exec wrangler queues resume-delivery "$QUEUE_NAME"']);
    expect(workflow).not.toContain('queues resume-delivery "$DLQ_NAME"');
  });

  it("runs the authenticated staging smoke after both queue-state verifications", () => {
    const deploy = jobBody("deploy");
    const verifyPrimary = deploy.indexOf('--queue "$QUEUE_NAME" --expected resumed');
    const verifyDlq = deploy.indexOf('--queue "$DLQ_NAME" --expected paused');
    const smoke = deploy.indexOf("node scripts/smoke-image-compress-server.mjs");

    expect(smoke).toBeGreaterThan(verifyPrimary);
    expect(smoke).toBeGreaterThan(verifyDlq);
    expect(deploy).toContain(
      `STAGING_MAINTAINER_SESSION_ID: \${{ secrets.STAGING_MAINTAINER_SESSION_ID }}`,
    );
    expect(deploy.slice(smoke)).toContain("--output .artifacts/deployment/smoke-result.json");
  });

  it("resolves D1 active state and keeps all mutation gates ahead of primary resume", () => {
    const deploy = jobBody("deploy");
    const migrations = deploy.indexOf("wrangler d1 migrations apply");
    const versionsBefore = deploy.indexOf("versions-before.json");
    const previous = deploy.indexOf("resolve-previous-active-worker-version.mjs");
    const bootstrap = deploy.indexOf("bootstrap-deploy.ndjson");
    const pages = deploy.indexOf("node scripts/verify-pages-alias.mjs");
    const gate = deploy.indexOf("node scripts/verify-deployment-gate-artifacts.mjs");
    const playwright = deploy.indexOf("pnpm exec playwright install --with-deps chromium");
    const resume = deploy.indexOf('pnpm exec wrangler queues resume-delivery "$QUEUE_NAME"');

    expect(versionsBefore).toBeGreaterThan(migrations);
    expect(previous).toBeGreaterThan(versionsBefore);
    expect(bootstrap).toBeGreaterThan(previous);
    expect(pages).toBeGreaterThan(bootstrap);
    expect(gate).toBeGreaterThan(pages);
    expect(playwright).toBeGreaterThan(gate);
    expect(resume).toBeGreaterThan(playwright);
    expect(deploy).not.toContain("STAGING_PREVIOUS_ACTIVE_VERSION_ID");
  });

  it("arms fail-safe cleanup before resume and makes cleanup the terminal step", () => {
    const deploy = jobBody("deploy");
    const arm = deploy.indexOf("id: resume-attempt");
    const resume = deploy.indexOf('pnpm exec wrangler queues resume-delivery "$QUEUE_NAME"');
    const upload = deploy.indexOf("actions/upload-artifact@");
    const cleanupStep = deploy.indexOf(
      "      - name: Re-pause and verify both queues after any failed delivery attempt",
    );
    const cleanup = deploy.indexOf('pnpm exec wrangler queues pause-delivery "$QUEUE_NAME"');

    expect(arm).toBeGreaterThanOrEqual(0);
    expect(deploy).toContain("id: resume-primary");
    expect(deploy.slice(arm, resume)).toContain('run: echo "attempted=true" >> "$GITHUB_OUTPUT"');
    expect(resume).toBeGreaterThan(arm);
    expect(upload).toBeGreaterThan(resume);
    expect(cleanupStep).toBeGreaterThan(upload);
    expect(cleanup).toBeGreaterThan(cleanupStep);
    expect(deploy.slice(cleanupStep + 1)).not.toMatch(/^ {6}- /m);
    expect(deploy).toContain("if: failure() && steps.resume-attempt.outputs.attempted == 'true'");
    expect(deploy).not.toContain("steps.resume-primary.outcome");
    expect(deploy.slice(cleanup)).toContain('--queue "$QUEUE_NAME" --expected paused');
    expect(deploy.slice(cleanup)).toContain('--queue "$DLQ_NAME" --expected paused');
  });

  it("publishes only sanitized deployment evidence for seven days", () => {
    const upload = actionStep(jobBody("deploy"), "actions/upload-artifact@");
    const paths = [...upload.matchAll(/^\s+(.artifacts\/deployment\/[^\s]+)$/gm)].map(
      ([, path]) => path,
    );

    expect(paths).toEqual([
      ".artifacts/deployment/processing-candidate-identity.json",
      ".artifacts/deployment/cloudflare-image-digest.txt",
      ".artifacts/deployment/worker-version.json",
      ".artifacts/deployment/gate-results.json",
      ".artifacts/deployment/smoke-result.json",
    ]);
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("retention-days: 7");
    expect(upload).not.toContain(".artifacts/candidate");
    expect(upload).not.toContain("processing-evidence");
  });

  it("pins every action and prevents checkout credential persistence", () => {
    const actionReferences = [...workflow.matchAll(/^\s+- uses: ([^\s#]+)/gm)].map(
      ([, reference]) => reference,
    );

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }
    for (const action of [
      "actions/checkout@",
      "pnpm/action-setup@",
      "actions/setup-node@",
      "docker/setup-buildx-action@",
      "actions/upload-artifact@",
      "actions/download-artifact@",
    ]) {
      expect(actionReferences.some((reference) => reference.startsWith(action))).toBe(true);
    }
    for (const name of ["build", "verify-release", "deploy"]) {
      const job = jobBody(name);
      expect(job).toContain("actions/checkout@");
      expect(job).toContain("persist-credentials: false");
    }
  });
});
