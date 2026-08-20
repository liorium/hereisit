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
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("group: processing-staging");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(deploy).toContain("github.repository == 'liorium/hereisit'");
    expect(deploy).not.toContain("PROCESSING_HOSTED_REVIEWS_READY");
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
    expect(install).toBeLessThan(verifySource);
    expect(validateEnvironment).toBeGreaterThan(install);
    expect(firstCloudflareMutation).toBeGreaterThan(validateEnvironment);
  });

  it("downloads the automatic exact-SHA CI release authority without a manual release", () => {
    expect(workflow).toContain(
      `processing-release-authority-\${{ github.event.workflow_run.head_sha }}`,
    );
    expect(workflow).toContain("verify-processing-deployment-authority.mjs");
    expect(workflow).not.toContain("gh release");
    expect(workflow).toContain("actions/download-artifact@");
  });

  it("builds and deploys one immutable rollout-zero staging source", () => {
    const deploy = jobBody("deploy");
    const bindAuthority = deploy.indexOf("verify-processing-deployment-authority.mjs");
    const bindImage = deploy.indexOf("image-engine-linux-amd64.docker.tar");
    const bindWorker = deploy.indexOf('cp .artifacts/authority/api-worker.mjs "$WORKER_MODULE"');
    const bindWeb = deploy.indexOf("verify-and-extract-tree-archive.mjs");
    const pushImage = deploy.indexOf("wrangler containers push");
    const resolveDigest = deploy.indexOf("node scripts/resolve-cloudflare-image-digest.mjs");
    const provision = deploy.indexOf("node scripts/ensure-cloudflare-processing-resources.mjs");
    const migrations = deploy.indexOf("wrangler d1 migrations apply");
    const putSecret = deploy.indexOf("wrangler secret put");
    const verifySecrets = deploy.indexOf("node scripts/verify-worker-secret-list.mjs");
    const deployPages = deploy.indexOf("wrangler pages deploy");
    const verifyPages = deploy.indexOf("node scripts/verify-pages-alias.mjs");

    expect(bindAuthority).toBeGreaterThanOrEqual(0);
    expect(bindImage).toBeGreaterThan(bindAuthority);
    expect(bindWorker).toBeGreaterThan(bindAuthority);
    expect(bindWeb).toBeGreaterThan(bindWorker);
    expect(pushImage).toBeGreaterThan(bindWeb);
    expect(resolveDigest).toBeGreaterThan(pushImage);
    expect(provision).toBeGreaterThan(resolveDigest);
    expect(migrations).toBeGreaterThan(provision);
    expect(putSecret).toBeGreaterThan(migrations);
    expect(verifySecrets).toBeGreaterThan(putSecret);
    expect(deployPages).toBeGreaterThan(verifySecrets);
    expect(verifyPages).toBeGreaterThan(deployPages);
    expect(deploy).toContain("--rollout-percent 0");
    expect(deploy).not.toMatch(/--rollout-percent (?!0\b)\d+/);
    expect(deploy).toContain(`IMAGE_CONFIG_HEX="\${LOCAL_IMAGE_CONFIG_DIGEST#sha256:}"`);
    expect(deploy).toContain(
      'REGISTRY_IMAGE_TAG="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/hereisit-image-engine:$EXPECTED_HEAD_SHA-$IMAGE_CONFIG_HEX"',
    );
    expect(deploy).not.toContain("docker buildx build");
    expect(deploy).toContain('--engine-image "$ENGINE_IMAGE"');
    expect(deploy).toContain(`LOGPUSH_STATUS_TOKEN: \${{ secrets.STAGING_LOGPUSH_STATUS_TOKEN }}`);
  });

  it("binds the staging product dataset without provisioning a separate resource", () => {
    expect(workflow).toContain("PRODUCT_ANALYTICS_DATASET_NAME: hereisit_product_usage_staging");
    expect(workflow).toContain(
      '--product-analytics-dataset-name "$PRODUCT_ANALYTICS_DATASET_NAME"',
    );
    expect(workflow).toContain("--product-analytics-rate-limit-namespace-id 21007");
    expect(workflow.match(/--product-analytics-dataset-name/g)).toHaveLength(1);
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
    const cleanup = deploy.indexOf('restore_queue image-primary "$QUEUE_NAME"', cleanupStep);

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
    expect(deploy).toContain("(failure() || cancelled())");
    expect(deploy).not.toContain('queues resume-delivery "$DLQ_NAME"');
    expect(deploy.slice(cleanupStep)).toContain('--expected "$expected"');
  });

  it("rotates staging cost accounting after attestation while rollout and queues remain closed", () => {
    const deploy = jobBody("deploy");
    const attestation = deploy.indexOf("node scripts/apply-worker-version-attestations.mjs");
    const rotation = deploy.indexOf("node scripts/rotate-staging-accounting-epoch.mjs");
    const deployPages = deploy.indexOf("wrangler pages deploy");
    const resume = deploy.indexOf('wrangler queues resume-delivery "$QUEUE_NAME"');

    expect(rotation).toBeGreaterThan(attestation);
    expect(deployPages).toBeGreaterThan(rotation);
    expect(resume).toBeGreaterThan(rotation);
    expect(deploy.slice(attestation, rotation)).toContain(
      `CLOUDFLARE_D1_API_TOKEN: \${{ secrets.CLOUDFLARE_D1_API_TOKEN }}`,
    );
    expect(deploy.slice(rotation, deployPages)).toContain(
      '--release-report-sha256 "$REPORT_SHA256"',
    );
  });

  it("treats only Cloudflare's missing Worker code as an empty first-deploy snapshot", () => {
    const deploy = jobBody("deploy");

    expect(deploy).toContain(
      'if ! pnpm exec wrangler versions list --config "$WRANGLER_CONFIG" --json',
    );
    expect(deploy).toContain("grep -Fq '[code: 10007]'");
    expect(deploy).toContain("printf '[]\\n' > .artifacts/runtime/versions-before.json");
  });

  it("reconciles a failed bootstrap attempt to the D1-attested Worker before retrying", () => {
    const deploy = jobBody("deploy");
    const attested = deploy.indexOf("--attestation-only");
    const reconcile = deploy.indexOf('versions deploy "$ATTESTED_ACTIVE_VERSION_ID@100%"');
    const deploymentSnapshot = deploy.indexOf("> .artifacts/runtime/deployment-before.json");
    const strictResolution = deploy.indexOf(
      'PREVIOUS_ACTIVE_VERSION_ID="$(node scripts/resolve-previous-active-worker-version.mjs',
    );
    const bootstrap = deploy.indexOf(".artifacts/runtime/bootstrap-deploy.ndjson");

    expect(attested).toBeGreaterThanOrEqual(0);
    expect(reconcile).toBeGreaterThan(attested);
    expect(deploymentSnapshot).toBeGreaterThan(reconcile);
    expect(strictResolution).toBeGreaterThan(deploymentSnapshot);
    expect(bootstrap).toBeGreaterThan(strictResolution);
  });

  it("discovers the exact Container app and verifies its current configuration", () => {
    const deploy = jobBody("deploy");
    const discover = deploy.indexOf("--mode discover");
    const info = deploy.indexOf('containers info "$STAGING_CONTAINER_APPLICATION_ID"');
    const verify = deploy.indexOf("--mode verify");

    expect(discover).toBeGreaterThanOrEqual(0);
    expect(info).toBeGreaterThan(discover);
    expect(verify).toBeGreaterThan(info);
    expect(deploy).toContain("for attempt in {1..90}; do");
    expect(deploy).toContain("if (( attempt == 90 )); then");
    expect(deploy).toContain("sleep 10");
    expect(deploy).toContain('--application-id "$STAGING_CONTAINER_APPLICATION_ID"');
    expect(deploy).toContain('--engine-image "$ENGINE_IMAGE"');
  });

  it("waits for the build-specific Container tag to expose the pushed manifest", () => {
    const deploy = jobBody("deploy");
    const push = deploy.indexOf("wrangler containers push");
    const retry = deploy.indexOf("for attempt in {1..30}; do", push);
    const inspect = deploy.indexOf("docker manifest inspect", retry);
    const resolve = deploy.indexOf("node scripts/resolve-cloudflare-image-digest.mjs", inspect);
    const retryBody = deploy.slice(retry, deploy.indexOf('echo "ENGINE_IMAGE=', resolve));

    expect(retry).toBeGreaterThan(push);
    expect(inspect).toBeGreaterThan(retry);
    expect(resolve).toBeGreaterThan(inspect);
    expect(retryBody).toContain("if (( attempt == 30 )); then");
    expect(retryBody).toContain("sleep 5");
  });

  it("uploads only sanitized deployment evidence", () => {
    const upload = actionStep(jobBody("deploy"), "actions/upload-artifact@");
    const paths = [...upload.matchAll(/^\s+(.artifacts\/deployment\/[^\s]+)$/gm)].map(
      ([, path]) => path,
    );

    expect(paths).toEqual([
      ".artifacts/deployment/source-sha.txt",
      ".artifacts/deployment/release-authority.json",
      ".artifacts/deployment/processing-candidate.json",
      ".artifacts/deployment/processing-release-report.json",
      ".artifacts/deployment/evidence-public.pem",
      ".artifacts/deployment/cloudflare-image-digest.txt",
      ".artifacts/deployment/cloudflare-pdf-image-digest.txt",
      ".artifacts/deployment/worker-version.json",
      ".artifacts/deployment/gate-results.json",
      ".artifacts/deployment/smoke-result.json",
      ".artifacts/deployment/pdf-smoke-result.json",
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
