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

  it("keeps production processing disabled and isolated", () => {
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
      "--account-daily-weighted-unit-limit 0",
      "--anonymous-daily-weighted-unit-limit 0",
      "--network-daily-weighted-unit-limit 0",
      "--rollout-percent 0",
    ]) {
      expect(workflow).toContain(flag);
    }
    expect(workflow).toContain("--maintainer-session-hashes-json '[]'");
    expect(workflow).toContain('--queue "$QUEUE_NAME" --expected paused');
    expect(workflow).toContain('--queue "$DLQ_NAME" --expected paused');
    expect(workflow).not.toContain("queues resume-delivery");
    expect(workflow).not.toContain("wrangler pages deploy");
  });

  it("provisions, attests, and smoke-checks before publishing sanitized evidence", () => {
    const provision = workflow.indexOf("node scripts/ensure-cloudflare-processing-resources.mjs");
    const migrations = workflow.indexOf("wrangler d1 migrations apply");
    const putSecrets = workflow.indexOf("wrangler secret put");
    const attestation = workflow.indexOf("node scripts/apply-worker-version-attestations.mjs");
    const queueCheck = workflow.indexOf("node scripts/verify-queue-delivery-state.mjs");
    const smoke = workflow.indexOf("SERVER_PROCESSING_DISABLED");
    const upload = workflow.indexOf("actions/upload-artifact@");

    expect(provision).toBeGreaterThanOrEqual(0);
    expect(migrations).toBeGreaterThan(provision);
    expect(putSecrets).toBeGreaterThan(migrations);
    expect(attestation).toBeGreaterThan(putSecrets);
    expect(queueCheck).toBeGreaterThan(attestation);
    expect(smoke).toBeGreaterThan(queueCheck);
    expect(upload).toBeGreaterThan(smoke);
    expect(workflow).toContain(
      `processing-production-bootstrap-\${{ github.event.workflow_run.head_sha }}`,
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
