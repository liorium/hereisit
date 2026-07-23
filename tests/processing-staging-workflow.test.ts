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

beforeAll(() => {
  expect(existsSync(workflowPath), `${workflowPath} must be checked in`).toBe(true);
  workflow = readFileSync(workflowPath, "utf8");
});

describe("processing staging workflow", () => {
  it("deploys only a successful main push from this repository's CI", () => {
    const deploy = jobBody("deploy");

    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["CI"]');
    expect(workflow).toContain("types: [completed]");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(deploy).toContain("github.repository == 'liorium/hereisit'");
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy).toContain("github.event.workflow_run.event == 'push'");
    expect(deploy).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deploy).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(deploy).toContain("environment: processing-staging");
  });

  it("checks out and verifies the exact successful CI commit before using secrets", () => {
    const deploy = jobBody("deploy");
    const checkout = actionStep(deploy, "actions/checkout@");
    const verifySource = deploy.indexOf('test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD_SHA"');
    const install = deploy.indexOf("pnpm install --frozen-lockfile");
    const validateEnvironment = deploy.indexOf("verify-processing-deployment-environment.mjs");
    const firstCloudflareMutation = deploy.indexOf("wrangler containers push");

    expect(checkout).toContain(`ref: \${{ github.event.workflow_run.head_sha }}`);
    expect(checkout).toContain("persist-credentials: false");
    expect(deploy).toContain(`EXPECTED_HEAD_SHA: \${{ github.event.workflow_run.head_sha }}`);
    expect(verifySource).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(verifySource);
    expect(validateEnvironment).toBeGreaterThan(install);
    expect(firstCloudflareMutation).toBeGreaterThan(validateEnvironment);
  });

  it("removes the manual signed-release ceremony", () => {
    expect(workflow).not.toMatch(
      /processing-evidence|release_tag|release-input|verify-release|PRIVATE(?:_|-)KEY/,
    );
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("actions/download-artifact@");
  });

  it("builds and deploys one immutable rollout-zero staging source", () => {
    const deploy = jobBody("deploy");
    const buildImage = deploy.indexOf("docker buildx build");
    const buildWorker = deploy.indexOf("--dry-run");
    const buildWeb = deploy.indexOf("NEXT_PUBLIC_PROCESSING_API_ORIGIN");
    const createCostModel = deploy.indexOf("node scripts/create-live-cost-model.mjs");
    const pushImage = deploy.indexOf("wrangler containers push");
    const resolveDigest = deploy.indexOf("node scripts/resolve-cloudflare-image-digest.mjs");
    const provision = deploy.indexOf("node scripts/ensure-cloudflare-processing-resources.mjs");
    const migrations = deploy.indexOf("wrangler d1 migrations apply");
    const putSecret = deploy.indexOf("wrangler secret put");
    const verifySecrets = deploy.indexOf("node scripts/verify-worker-secret-list.mjs");
    const deployPages = deploy.indexOf("wrangler pages deploy");
    const verifyPages = deploy.indexOf("node scripts/verify-pages-alias.mjs");

    expect(buildImage).toBeGreaterThanOrEqual(0);
    expect(buildWorker).toBeGreaterThan(buildImage);
    expect(buildWeb).toBeGreaterThan(buildWorker);
    expect(createCostModel).toBeGreaterThan(buildWeb);
    expect(pushImage).toBeGreaterThan(createCostModel);
    expect(resolveDigest).toBeGreaterThan(pushImage);
    expect(provision).toBeGreaterThan(resolveDigest);
    expect(migrations).toBeGreaterThan(provision);
    expect(putSecret).toBeGreaterThan(migrations);
    expect(verifySecrets).toBeGreaterThan(putSecret);
    expect(deployPages).toBeGreaterThan(verifySecrets);
    expect(verifyPages).toBeGreaterThan(deployPages);
    expect(deploy).toContain("--rollout-percent 0");
    expect(deploy).not.toMatch(/--rollout-percent (?!0\b)\d+/);
    expect(deploy).toContain(
      'REGISTRY_IMAGE_TAG="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/hereisit-image-engine:$EXPECTED_HEAD_SHA"',
    );
    expect(deploy).toContain('--engine-image "$ENGINE_IMAGE"');
  });

  it("resumes only the primary queue after deployment checks and fails closed", () => {
    const deploy = jobBody("deploy");
    const verifyPages = deploy.indexOf("node scripts/verify-pages-alias.mjs");
    const arm = deploy.indexOf("id: resume-attempt");
    const resume = deploy.indexOf('wrangler queues resume-delivery "$QUEUE_NAME"');
    const verifyPrimary = deploy.indexOf('--queue "$QUEUE_NAME" --expected resumed');
    const verifyDlq = deploy.indexOf('--queue "$DLQ_NAME" --expected paused');
    const smoke = deploy.indexOf("node scripts/smoke-image-compress-server.mjs");
    const cleanupStep = deploy.indexOf(
      "      - name: Re-pause and verify both queues after any failed delivery attempt",
    );
    const cleanup = deploy.indexOf('wrangler queues pause-delivery "$QUEUE_NAME"');

    expect(arm).toBeGreaterThan(verifyPages);
    expect(resume).toBeGreaterThan(arm);
    expect(verifyPrimary).toBeGreaterThan(resume);
    expect(verifyDlq).toBeGreaterThan(resume);
    expect(smoke).toBeGreaterThan(verifyPrimary);
    expect(smoke).toBeGreaterThan(verifyDlq);
    expect(deploy).toContain(
      `STAGING_MAINTAINER_SESSION_ID: \${{ secrets.STAGING_MAINTAINER_SESSION_ID }}`,
    );
    expect(cleanupStep).toBeGreaterThan(smoke);
    expect(cleanup).toBeGreaterThan(cleanupStep);
    expect(deploy.slice(cleanupStep + 1)).not.toMatch(/^ {6}- /m);
    expect(deploy).toContain("if: failure() && steps.resume-attempt.outputs.attempted == 'true'");
    expect(deploy).not.toContain('queues resume-delivery "$DLQ_NAME"');
    expect(deploy.slice(cleanup)).toContain('--queue "$QUEUE_NAME" --expected paused');
    expect(deploy.slice(cleanup)).toContain('--queue "$DLQ_NAME" --expected paused');
  });

  it("uploads only sanitized deployment evidence", () => {
    const upload = actionStep(jobBody("deploy"), "actions/upload-artifact@");
    const paths = [...upload.matchAll(/^\s+(.artifacts\/deployment\/[^\s]+)$/gm)].map(
      ([, path]) => path,
    );

    expect(paths).toEqual([
      ".artifacts/deployment/source-sha.txt",
      ".artifacts/deployment/cloudflare-image-digest.txt",
      ".artifacts/deployment/worker-version.json",
      ".artifacts/deployment/gate-results.json",
      ".artifacts/deployment/smoke-result.json",
    ]);
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("retention-days: 7");
  });

  it("pins every action", () => {
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
    ]) {
      expect(actionReferences.some((reference) => reference.startsWith(action))).toBe(true);
    }
  });
});
