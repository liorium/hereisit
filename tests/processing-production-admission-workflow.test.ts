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
      `PRODUCTION_RUN_ATTEMPT: \${{ github.event.workflow_run.run_attempt }}`,
    );
    expect(workflow).toContain(
      'test "$(cat .artifacts/canary/source-sha.txt)" = "$EXPECTED_HEAD_SHA"',
    );
    expect(workflow).toContain(
      `processing-production-canary-\${{ github.event.workflow_run.head_sha }}`,
    );
    expect(workflow).toContain(".artifacts/canary/resources-production.json");
    expect(workflow).toContain("wrangler deployments status");
    expect(workflow).toContain("--before-deployment .artifacts/runtime/deployment-before.json");
    expect(workflow).toContain("--after-deployment .artifacts/runtime/deployment-after.json");
    expect(workflow).not.toContain("node scripts/ensure-cloudflare-processing-resources.mjs");
  });

  it("rebuilds and validates the Worker exactly like the production canary", () => {
    expect(workflow).toContain("pnpm --filter @hereisit/api-worker exec wrangler deploy \\");
    expect(workflow).toContain("--config wrangler.local.jsonc \\");
    expect(workflow).toContain(
      'pnpm exec wrangler deploy "$WORKER_MODULE" --config "$WRANGLER_CONFIG" \\',
    );
    expect(workflow).toContain("--no-bundle --containers-rollout none --dry-run");
    expect(
      workflow.match(/cp \.artifacts\/build\/api-worker-bundle\/index\.js "\$WORKER_MODULE"/gu),
    ).toHaveLength(1);
  });

  it("fixes public rollout, cost ceilings, quotas, and namespaces in source", () => {
    expect(workflow).toContain(`ALERT_DESTINATION_ADDRESS: \${{ vars.ALERT_DESTINATION_ADDRESS }}`);
    expect(workflow).toContain('CANARY_DAILY_WEIGHTED_UNIT_LIMIT: "5000000000"');
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
      "--job-read-rate-limit-namespace-id 22003",
      "--result-download-rate-limit-namespace-id 22004",
      "--policy-rate-limit-namespace-id 22005",
      "--job-api-network-rate-limit-namespace-id 22006",
      "--product-analytics-rate-limit-namespace-id 22007",
    ]) {
      expect(workflow).toContain(value);
    }
    expect(workflow).toContain(
      `network_rate_limit_namespace_id="\${PRODUCTION_RUN_ID}\${PRODUCTION_RUN_ATTEMPT}"`,
    );
    expect(workflow).toContain("network_rate_limit_namespace_id=22002");
    expect(workflow).toContain(
      '--network-rate-limit-namespace-id "$network_rate_limit_namespace_id"',
    );
    expect(workflow).not.toMatch(/rollout.*\$\{\{\s*inputs\./u);
    expect(workflow).not.toMatch(/cost.*\$\{\{\s*inputs\./u);
  });

  it("uses only the custom production endpoints and exact legacy browser allowlist", () => {
    expect(workflow).toContain("PRODUCTION_API_ORIGIN: https://api.hereisit.app");
    expect(workflow).toContain("PRODUCTION_PAGES_ORIGIN: https://hereisit.app");
    expect(workflow).toContain("LEGACY_PRODUCTION_PAGES_ORIGIN: https://hereisit.pages.dev");
    expect(workflow).not.toContain("hereisit-processing-production.liorium.workers.dev");
    expect(workflow.match(/--app-origin "\$PRODUCTION_PAGES_ORIGIN"/g)).toHaveLength(1);
    expect(workflow.match(/--app-origin "\$LEGACY_PRODUCTION_PAGES_ORIGIN"/g)).toHaveLength(1);
  });

  it("verifies, pauses, attests, resumes, and smokes in fail-closed order", () => {
    const bind = workflow.indexOf("Bind the exact successful production canary");
    const activeDeployment = workflow.indexOf("verifyActiveWorkerDeployment");
    const state = workflow.indexOf("verify-processing-admission-state.mjs \\");
    const arm = workflow.indexOf("Arm fail-closed mutation recovery");
    const pause = workflow.indexOf('queues pause-delivery "$QUEUE_NAME"');
    const deploy = workflow.indexOf('wrangler deploy "$WORKER_MODULE"', pause);
    const finalize = workflow.indexOf("--mode finalize-admission");
    const apply = workflow.indexOf("apply-worker-version-attestations.mjs");
    const policy = workflow.indexOf("hereisit-processing-production-public-policy-smoke@1");
    const resume = workflow.indexOf('queues resume-delivery "$QUEUE_NAME"');
    const smoke = workflow.indexOf("runProcessingPublicSmokeCli");

    expect(bind).toBeGreaterThanOrEqual(0);
    expect(activeDeployment).toBeGreaterThan(bind);
    expect(state).toBeGreaterThan(activeDeployment);
    expect(arm).toBeGreaterThan(state);
    expect(pause).toBeGreaterThan(arm);
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
    expect(workflow).toContain(
      "if: always() && steps.mutation.outputs.attempted == 'true' && (failure() || cancelled())",
    );
    expect(
      workflow.slice(workflow.indexOf("  promote:"), workflow.indexOf("  disable:")),
    ).not.toContain("timeout-minutes:");
    expect(workflow).toContain('queues pause-delivery "$QUEUE_NAME"');
    expect(workflow).toContain("--mode disable");
    expect(workflow).toContain('versions deploy "$CANARY_VERSION_ID@100%"');
    expect(workflow).toContain('body.execution !== "local"');
    expect(workflow).toContain("body.disclosure?.upload !== false");
    expect(workflow).toContain("QUEUE_RECOVERY");
    expect(workflow).toContain("CIRCUIT_RECOVERY");
    expect(workflow).toContain("VERSION_RECOVERY");
    const recovery = workflow.indexOf("Attempt every fail-closed recovery layer");
    expect(workflow.indexOf("CIRCUIT_RECOVERY=0", recovery)).toBeLessThan(
      workflow.indexOf("QUEUE_RECOVERY=0", recovery),
    );
  });

  it("opens the manual circuit even when either Queue operation fails", () => {
    const disableJob = workflow.indexOf("name: Disable public processing");
    const circuit = workflow.indexOf("--mode disable-current", disableJob);
    const primary = workflow.indexOf('queues pause-delivery "$QUEUE_NAME"', disableJob);
    const dlq = workflow.indexOf('queues pause-delivery "$DLQ_NAME"', disableJob);
    expect(circuit).toBeGreaterThan(disableJob);
    expect(primary).toBeGreaterThan(circuit);
    expect(dlq).toBeGreaterThan(primary);
    expect(workflow.slice(disableJob)).toContain("set +e");
    expect(workflow.slice(disableJob)).toContain("CIRCUIT_DISABLE");
    expect(workflow.slice(disableJob)).toContain("QUEUE_DISABLE");
    expect(workflow.slice(disableJob)).toContain('test "$CIRCUIT_DISABLE" -eq 0');
    expect(workflow.slice(disableJob)).toContain('test "$QUEUE_DISABLE" -eq 0');
  });

  it("offers only protected main-ref disable and publishes sanitized evidence", () => {
    expect(workflow).toContain("operation:");
    expect(workflow).toContain("options: [disable]");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).toContain("wrangler d1 list --json");
    expect(workflow).toContain("--mode disable-current");
    expect(workflow).not.toContain("gh run download");
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
