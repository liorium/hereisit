import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/processing-production.yml";
let workflow = "";

beforeAll(() => {
  expect(existsSync(workflowPath), `${workflowPath} must be checked in`).toBe(true);
  workflow = readFileSync(workflowPath, "utf8");
});

describe("processing production workflow", () => {
  it("deploys only the exact successful main staging run behind the production environment", () => {
    expect(workflow).toContain('workflows: ["Processing staging"]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain("environment: processing-production");
    expect(workflow).toContain(`run-id: \${{ github.event.workflow_run.id }}`);
    expect(workflow).toContain(`ref: \${{ github.event.workflow_run.head_sha }}`);
    expect(workflow).toContain(
      'test "$(cat .artifacts/staging/source-sha.txt)" = "$EXPECTED_HEAD_SHA"',
    );
  });

  it("uses a separate Ubuntu network for the production browser canary", () => {
    expect(workflow.match(/runs-on: macos-15-intel/g)).toHaveLength(1);
    expect(workflow).toContain("name: Run production canary from a clean browser runner");
    expect(workflow).toContain("needs: deploy");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain(
      `processing-production-canary-preflight-\${{ github.event.workflow_run.head_sha }}`,
    );
    expect(workflow).toContain("pnpm exec playwright install chromium");
    expect(workflow).not.toContain("playwright install --with-deps");
    expect(workflow).not.toContain("sha256sum");
  });

  it("lets the provider clock settle before final version attestation", () => {
    const finalSnapshot = workflow.indexOf("> .artifacts/runtime/versions-after-final.json");
    const clockBoundary = workflow.indexOf("sleep 10", finalSnapshot);
    const finalAttestation = workflow.indexOf(
      "node scripts/verify-worker-version-chain.mjs \\",
      finalSnapshot,
    );

    expect(finalSnapshot).toBeGreaterThanOrEqual(0);
    expect(clockBoundary).toBeGreaterThan(finalSnapshot);
    expect(finalAttestation).toBeGreaterThan(clockBoundary);
  });

  it("reconciles and restores the D1-attested Worker around canary mutation", () => {
    const attested = workflow.indexOf("--attestation-only");
    const reconcile = workflow.indexOf('versions deploy "$ATTESTED_ACTIVE_VERSION_ID@100%"');
    const deploymentSnapshot = workflow.indexOf("> .artifacts/runtime/deployment-before.json");
    const strictResolution = workflow.indexOf(
      'PREVIOUS_ACTIVE_VERSION_ID="$(node scripts/resolve-previous-active-worker-version.mjs',
    );
    const arm = workflow.indexOf('echo "attempted=true" >> "$GITHUB_OUTPUT"');
    const bootstrap = workflow.indexOf(".artifacts/runtime/bootstrap-deploy.ndjson");
    const cleanup = workflow.indexOf("Restore the D1-attested Worker after failed canary mutation");

    expect(attested).toBeGreaterThanOrEqual(0);
    expect(reconcile).toBeGreaterThan(attested);
    expect(deploymentSnapshot).toBeGreaterThan(reconcile);
    expect(strictResolution).toBeGreaterThan(deploymentSnapshot);
    expect(arm).toBeGreaterThan(strictResolution);
    expect(bootstrap).toBeGreaterThan(arm);
    expect(cleanup).toBeGreaterThan(bootstrap);
    expect(workflow).toContain(
      "if: always() && steps.worker-mutation.outputs.attempted == 'true' && (failure() || cancelled())",
    );
    expect(workflow).toContain(
      'RESTORE_VERSION_ID="$(node scripts/resolve-previous-active-worker-version.mjs',
    );
    expect(workflow).toContain('versions deploy "$RESTORE_VERSION_ID@100%"');
    expect(workflow).toContain(
      'verifyActiveWorkerDeployment(deployment, process.argv[2], "restored Worker")',
    );
  });

  it("keeps production isolated and admits only the maintainer canary", () => {
    for (const value of [
      "hereisit-processing-production",
      "hereisit-processing-usage-production",
      "hereisit_processing_usage_production",
      "hereisit-image-jobs-production",
      "hereisit-image-jobs-dlq-production",
    ]) {
      expect(workflow).toContain(value);
    }
    for (const flag of [
      '--account-daily-weighted-unit-limit "$daily_limit"',
      '--anonymous-daily-weighted-unit-limit "$daily_limit"',
      '--network-daily-weighted-unit-limit "$daily_limit"',
      "--rollout-percent 0",
    ]) {
      expect(workflow).toContain(flag);
    }
    expect(workflow).toContain('CANARY_DAILY_WEIGHTED_UNIT_LIMIT: "5000000000"');
    expect(workflow).toContain("local daily_limit=0");
    expect(workflow).toContain("Verify public production policy remains local");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("local maintainer_hashes='[]'");
    expect(workflow).toContain('if [[ "$1" == active ]]');
    expect(workflow).toContain('daily_limit="$CANARY_DAILY_WEIGHTED_UNIT_LIMIT"');
    expect(workflow).toContain("Bind isolated canary rate-limit namespace");
    expect(workflow).not.toContain("randomUUID()");
    expect(workflow).toContain("::add-mask::");
    expect(workflow).toContain("PRODUCTION_CANARY_MAINTAINER_HASHES_JSON");
    expect(workflow).toContain("PRODUCTION_CANARY_NETWORK_RATE_LIMIT_NAMESPACE_ID");
    expect(workflow).toContain('maintainer_hashes="$PRODUCTION_CANARY_MAINTAINER_HASHES_JSON"');
    expect(workflow).toContain(
      '--network-rate-limit-namespace-id "$PRODUCTION_CANARY_NETWORK_RATE_LIMIT_NAMESPACE_ID"',
    );
    expect(workflow).toContain(
      `PRODUCTION_MAINTAINER_SESSION_ID: \${{ secrets.PRODUCTION_MAINTAINER_SESSION_ID }}`,
    );
    expect(workflow).toContain('--maintainer-session-hashes-json "$maintainer_hashes"');
    expect(workflow).toContain('--queue "$QUEUE_NAME" --expected paused');
    expect(workflow).toContain('--queue "$DLQ_NAME" --expected paused');
    expect(workflow).toContain('queues resume-delivery "$QUEUE_NAME"');
    expect(workflow).not.toContain('queues resume-delivery "$DLQ_NAME"');
    expect(workflow).toContain('queues pause-delivery "$QUEUE_NAME"');
    expect(workflow).toContain("if: failure() && steps.resume-attempt.outputs.attempted == 'true'");
    expect(workflow).toContain('NEXT_PUBLIC_PROCESSING_API_ORIGIN="$PRODUCTION_API_ORIGIN"');
    expect(workflow).toContain("PRODUCTION_API_ORIGIN: https://api.hereisit.app");
    expect(workflow.match(/PRODUCTION_PAGES_ORIGIN: https:\/\/hereisit\.app/g)).toHaveLength(2);
    expect(workflow).toContain("LEGACY_PRODUCTION_PAGES_ORIGIN: https://hereisit.pages.dev");
    expect(workflow).not.toContain("hereisit-processing-production.liorium.workers.dev");
    expect(workflow.match(/--app-origin "\$PRODUCTION_PAGES_ORIGIN"/g)).toHaveLength(1);
    expect(workflow.match(/--app-origin "\$LEGACY_PRODUCTION_PAGES_ORIGIN"/g)).toHaveLength(1);
    expect(workflow).toContain('--field target --expected-target "$PRODUCTION_API_ORIGIN"');
    expect(workflow).not.toContain("--field targets.0");
    expect(workflow).toContain("wrangler pages deploy apps/web/out");
    expect(workflow).toContain("--branch main");
    expect(workflow).toContain('--stable-url "$LEGACY_PRODUCTION_PAGES_ORIGIN"');
    expect(workflow).toContain("for (let attempt = 1; attempt <= 60; attempt += 1)");
    expect(workflow).toContain("if (attempt < 60) await delay(2_000)");
    expect(workflow).toContain(
      `LOGPUSH_STATUS_TOKEN: \${{ secrets.PRODUCTION_LOGPUSH_STATUS_TOKEN }}`,
    );
  });

  it("binds an isolated production product dataset", () => {
    expect(workflow).toContain("PRODUCT_ANALYTICS_DATASET_NAME: hereisit_product_usage_production");
    expect(workflow).toContain(
      '--product-analytics-dataset-name "$PRODUCT_ANALYTICS_DATASET_NAME"',
    );
    expect(workflow).toContain("--product-analytics-rate-limit-namespace-id 22007");
    expect(workflow.match(/--product-analytics-dataset-name/g)).toHaveLength(1);
  });

  it("provisions, attests, and smoke-checks before publishing sanitized evidence", () => {
    const provision = workflow.indexOf("node scripts/ensure-cloudflare-processing-resources.mjs");
    const migrations = workflow.indexOf("wrangler d1 migrations apply");
    const putSecrets = workflow.indexOf("wrangler secret put");
    const attestation = workflow.indexOf("node scripts/apply-worker-version-attestations.mjs");
    const accountingEpoch = workflow.indexOf("node scripts/rotate-staging-accounting-epoch.mjs");
    const queueCheck = workflow.indexOf("node scripts/verify-queue-delivery-state.mjs");
    const policySmoke = workflow.indexOf("LOCAL_FALLBACK_REQUIRED");
    const pages = workflow.indexOf("wrangler pages deploy apps/web/out");
    const gate = workflow.indexOf("node scripts/verify-deployment-gate-artifacts.mjs");
    const resume = workflow.indexOf('queues resume-delivery "$QUEUE_NAME"');
    const canarySmoke = workflow.indexOf("--output .artifacts/deployment/canary-smoke.json");
    const preflightUpload = workflow.indexOf("actions/upload-artifact@");
    const upload = workflow.lastIndexOf("actions/upload-artifact@");

    expect(provision).toBeGreaterThanOrEqual(0);
    expect(migrations).toBeGreaterThan(provision);
    expect(putSecrets).toBeGreaterThan(migrations);
    expect(attestation).toBeGreaterThan(putSecrets);
    expect(accountingEpoch).toBeGreaterThan(attestation);
    expect(queueCheck).toBeGreaterThan(accountingEpoch);
    expect(policySmoke).toBeGreaterThan(queueCheck);
    expect(pages).toBeGreaterThan(policySmoke);
    expect(gate).toBeGreaterThan(pages);
    expect(resume).toBeGreaterThan(gate);
    expect(canarySmoke).toBeGreaterThan(resume);
    expect(preflightUpload).toBeGreaterThan(gate);
    expect(resume).toBeGreaterThan(preflightUpload);
    expect(upload).toBeGreaterThan(canarySmoke);
    expect(workflow).toContain(
      `processing-production-canary-\${{ github.event.workflow_run.head_sha }}`,
    );
    const uploadedPaths = [...workflow.slice(upload).matchAll(/^\s+(.artifacts\/[^\s]+)$/gm)].map(
      ([, path]) => path,
    );
    expect(uploadedPaths).toEqual([
      ".artifacts/deployment/source-sha.txt",
      ".artifacts/deployment/staging-run-id.txt",
      ".artifacts/deployment/cloudflare-image-digest.txt",
      ".artifacts/deployment/worker-version.json",
      ".artifacts/deployment/gate-results.json",
      ".artifacts/deployment/policy-smoke.json",
      ".artifacts/deployment/canary-smoke.json",
      ".artifacts/deployment/resources-production.json",
    ]);
  });

  it("pins every action", () => {
    const references = [...workflow.matchAll(/^\s+- uses: ([^\s#]+)/gm)].map(
      ([, reference]) => reference,
    );
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
  });
});
