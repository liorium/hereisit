import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/processing-production-admission.yml";
let workflow = "";

beforeAll(() => {
  expect(existsSync(workflowPath), `${workflowPath} must be checked in`).toBe(true);
  workflow = readFileSync(workflowPath, "utf8");
});

describe("processing production admission workflow", () => {
  it("promotes only the exact successful production canary behind the existing lock", () => {
    expect(workflow).toContain('workflows: ["Processing production"]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain("environment: processing-production");
    expect(workflow).toContain("group: processing-production");
    expect(workflow).toContain(`run-id: \${{ github.event.workflow_run.id }}`);
    expect(workflow).toContain(`ref: \${{ github.event.workflow_run.head_sha }}`);
    expect(workflow).toContain(
      'test "$(cat .artifacts/canary/source-sha.txt)" = "$EXPECTED_HEAD_SHA"',
    );
    expect(workflow).toContain(
      `processing-production-canary-\${{ github.event.workflow_run.head_sha }}`,
    );
  });

  it("fixes public rollout, cost ceilings, quotas, and namespaces in source", () => {
    for (const value of [
      "--rollout-percent 100",
      "--max-projected-monthly-cost-microusd 5000000",
      "--max-live-cost-per-1000-microusd 500000",
      '--account-daily-weighted-unit-limit "$CANARY_DAILY_WEIGHTED_UNIT_LIMIT"',
      '--anonymous-daily-weighted-unit-limit "$CANARY_DAILY_WEIGHTED_UNIT_LIMIT"',
      '--network-daily-weighted-unit-limit "$CANARY_DAILY_WEIGHTED_UNIT_LIMIT"',
      "--account-pending-job-limit 10",
      "--network-pending-job-limit 3",
      "--maximum-queued-age-seconds 600",
      "--session-rate-limit-namespace-id 22001",
      "--network-rate-limit-namespace-id 22002",
      "--job-read-rate-limit-namespace-id 22003",
      "--result-download-rate-limit-namespace-id 22004",
      "--policy-rate-limit-namespace-id 22005",
      "--job-api-network-rate-limit-namespace-id 22006",
      "--product-analytics-rate-limit-namespace-id 22007",
    ]) {
      expect(workflow).toContain(value);
    }
    expect(workflow).not.toMatch(/rollout.*\$\{\{\s*inputs\./u);
    expect(workflow).not.toMatch(/cost.*\$\{\{\s*inputs\./u);
  });

  it("verifies, pauses, attests, resumes, and smokes in fail-closed order", () => {
    const bind = workflow.indexOf("Bind the exact successful production canary");
    const state = workflow.indexOf("verify-processing-admission-state.mjs \\");
    const pause = workflow.indexOf('queues pause-delivery "$QUEUE_NAME"');
    const deploy = workflow.indexOf('wrangler deploy "$WORKER_MODULE"');
    const finalize = workflow.indexOf("--mode finalize-admission");
    const apply = workflow.indexOf("apply-worker-version-attestations.mjs");
    const policy = workflow.indexOf("hereisit-processing-production-public-policy-smoke@1");
    const resume = workflow.indexOf('queues resume-delivery "$QUEUE_NAME"');
    const smoke = workflow.indexOf("runProcessingPublicSmokeCli");

    expect(bind).toBeGreaterThanOrEqual(0);
    expect(state).toBeGreaterThan(bind);
    expect(pause).toBeGreaterThan(state);
    expect(deploy).toBeGreaterThan(pause);
    expect(finalize).toBeGreaterThan(deploy);
    expect(apply).toBeGreaterThan(finalize);
    expect(policy).toBeGreaterThan(apply);
    expect(resume).toBeGreaterThan(policy);
    expect(smoke).toBeGreaterThan(resume);
    expect(workflow).toContain('--queue "$DLQ_NAME" --expected paused');
    expect(workflow).not.toContain('queues resume-delivery "$DLQ_NAME"');
  });

  it("attempts all three recovery layers and verifies effective local policy", () => {
    expect(workflow).toContain("if: failure() && steps.mutation.outputs.attempted == 'true'");
    expect(workflow).toContain('queues pause-delivery "$QUEUE_NAME"');
    expect(workflow).toContain("--mode disable");
    expect(workflow).toContain('versions deploy "$CANARY_VERSION_ID@100%"');
    expect(workflow).toContain('body.execution !== "local"');
    expect(workflow).toContain("body.disclosure?.upload !== false");
    expect(workflow).toContain("QUEUE_RECOVERY");
    expect(workflow).toContain("CIRCUIT_RECOVERY");
    expect(workflow).toContain("VERSION_RECOVERY");
  });

  it("offers only protected main-ref disable and publishes sanitized evidence", () => {
    expect(workflow).toContain("operation:");
    expect(workflow).toContain("options: [disable]");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("retention-days: 7");
    const upload = workflow.indexOf("actions/upload-artifact@");
    const paths = [
      ...workflow.slice(upload).matchAll(/^\s+(.artifacts\/admission\/[^\s]+)$/gm),
    ].map(([, path]) => path);
    expect(paths).toEqual([
      ".artifacts/admission/source-sha.txt",
      ".artifacts/admission/cloudflare-image-digest.txt",
      ".artifacts/admission/transition-attestation.json",
      ".artifacts/admission/gate-result.json",
      ".artifacts/admission/policy-result.json",
      ".artifacts/admission/public-smoke-result.json",
      ".artifacts/admission/recovery-result.json",
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
