import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/processing-image-admission.yml", "utf8");

describe("deployed image canary admission workflow", () => {
  it("passes the image class to both container discovery and verification", () => {
    const commands = [
      ...workflow
        .replace(/\\\n\s*/g, " ")
        .matchAll(/node scripts\/resolve-cloudflare-container-application\.mjs ([^\n]+)/g),
    ].map((match) => match[1]);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("--mode discover");
    expect(commands[1]).toContain("--mode verify");
    for (const command of commands) {
      expect(command).toContain("--container-class-name ImageEngineContainer");
    }
  });

  it("verifies signed release and deployment authority before binding immutable admission inputs", () => {
    const mutation = workflow.indexOf("Arm fail-closed mutation recovery");
    const preflight = workflow.slice(0, mutation);
    expect(preflight).toContain("node scripts/verify-processing-deployment-authority.mjs");
    expect(preflight).toContain("node scripts/verify-processing-deployment-report.mjs");
    expect(preflight).toContain("--candidate-root .artifacts/canary/authority");
    expect(preflight).toContain(
      '--evidence-signature ".artifacts/canary/authority/evidence-v1--$RELEASE_ID--processing-evidence.sig"',
    );
    expect(preflight).toContain("--signature .artifacts/canary/processing-deployment-report.sig");
    expect(preflight).toContain("--public-key .artifacts/canary/authority/evidence-public.pem");
    expect(preflight).toContain("--gate .artifacts/canary/gate-results.json");
    expect(preflight).toContain("--image-canary .artifacts/canary/canary-smoke.json");
    expect(preflight).not.toContain('exact(gate, ["verified"]');
    expect(preflight).toContain('cp .artifacts/canary/authority/api-worker.mjs "$WORKER_MODULE"');
    expect(preflight).toContain(
      "cp .artifacts/canary/authority/live-cost-model.json .artifacts/runtime/live-cost-model.json",
    );
    expect(preflight).toContain(
      "--manifest .artifacts/canary/authority/processing-candidate.json --field providerUsage.schemaSha256",
    );
    expect(preflight).not.toContain("create-live-cost-model.mjs");
    expect(preflight).not.toContain("pnpm --filter @hereisit/web build");
    expect(preflight).not.toContain("wrangler.local.jsonc");
    expect(preflight).toContain("JSON.stringify([...new Set(configuredHashes)].sort())");
    expect(workflow).not.toContain("SOURCE_SHA256");
    expect(workflow).not.toContain("--release-report .artifacts/admission/source-sha.txt");
    expect(workflow).toContain(
      "--release-report .artifacts/canary/authority/processing-release-report.json",
    );
    expect(workflow).toContain(
      'hash(".artifacts/canary/authority/processing-release-report.json") !== canary.releaseReportSha256',
    );
    expect(workflow.match(/--release-report-sha256 "\$REPORT_SHA256"/g)).toHaveLength(2);
    expect(workflow.match(/--expected-release-report-sha256 "\$REPORT_SHA256"/g)).toHaveLength(4);
  });
  it("binds an explicit immutable production artifact before any mutation", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("source_sha:");
    expect(workflow).toContain("production_run_id:");
    expect(workflow).toContain("production_run_attempt:");
    expect(workflow).toContain("ref: $" + "{{ inputs.source_sha }}");
    expect(workflow).toContain("name: processing-production-canary-$" + "{{ inputs.source_sha }}");
    expect(workflow).toContain("run-id: $" + "{{ inputs.production_run_id }}");
    expect(workflow).toContain("if test -d .artifacts/canary/deployment; then");
    expect(workflow).toContain("cp -a .artifacts/canary/deployment/. .artifacts/canary/");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD_SHA"');
    expect(workflow).toContain(
      'test "$(cat .artifacts/canary/source-sha.txt)" = "$EXPECTED_HEAD_SHA"',
    );
    expect(workflow).toContain("rebuilt canary artifacts do not match");
    const materialize = workflow.indexOf("Materialize current admission control plane");
    const restore = workflow.indexOf("Restore and verify the exact local canary before admission");
    expect(materialize).toBeGreaterThan(0);
    expect(materialize).toBeLessThan(restore);
    expect(workflow.slice(materialize, restore)).toContain(
      'git show "${' + 'GITHUB_SHA}:scripts/processing-admission-rollback-state.mjs"',
    );
    expect(workflow.slice(materialize, restore)).toContain(
      "scripts/.processing-admission-rollback-state.mjs",
    );
    expect(workflow.slice(materialize, restore)).toContain(
      'git show "${' + 'GITHUB_SHA}:scripts/verify-worker-version-chain.mjs"',
    );
    expect(workflow.slice(materialize, restore)).toContain(
      "scripts/.verify-worker-version-chain.mjs",
    );
    expect(workflow.slice(materialize, restore)).toContain(
      'git show "${' + 'GITHUB_SHA}:scripts/rotate-staging-accounting-epoch.mjs"',
    );
    expect(workflow.slice(materialize, restore)).toContain(
      "scripts/.rotate-staging-accounting-epoch.mjs",
    );
    expect(workflow.slice(materialize, restore)).toContain(
      'git show "${' + 'GITHUB_SHA}:scripts/smoke-image-compress-server.mjs"',
    );
    expect(workflow.slice(materialize, restore)).toContain(
      "scripts/.smoke-image-compress-server.mjs",
    );
    expect(workflow).toContain("node scripts/.verify-worker-version-chain.mjs \\");
    expect(workflow).toContain('from "./scripts/.smoke-image-compress-server.mjs"');
    expect(workflow).toContain("verifyActiveWorkerDeployment");
    expect(workflow).toContain("--mode verify");
    expect(workflow).toContain('--expected-version-id "$CANARY_VERSION_ID"');
  });

  it("changes only the image admission state under the existing cost ceilings", () => {
    const mutation = workflow.indexOf("Arm fail-closed mutation recovery");
    const pause = workflow.indexOf("Pause and verify both queues before mutation");
    const deploy = workflow.indexOf("Deploy and attest the public Worker version");
    const resume = workflow.indexOf("Resume only primary delivery");
    expect(mutation).toBeGreaterThan(0);
    expect(mutation).toBeLessThan(pause);
    expect(pause).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(resume);
    expect(workflow).toContain("--rollout-percent 100");
    expect(workflow).toContain("--max-projected-monthly-cost-microusd 5000000");
    expect(workflow).toContain("--max-live-cost-per-1000-microusd 500000");
    expect(workflow).toContain('body.execution !== "local"');
    expect(workflow).toContain("runProcessingPublicSmokeCli");
    expect(workflow).toContain(
      'error instanceof Error ? error.message : "processing production public smoke failed"',
    );
    expect(workflow).not.toMatch(/PDF_|pdf-|PdfEngine|hereisit-pdf/u);
    expect(workflow).not.toMatch(
      /containers push|d1 migrations apply|ensure-cloudflare-processing-resources/u,
    );
  });

  it("restores a drifted canary only after fail-closed recovery is armed", () => {
    const discover = workflow.indexOf(
      "Discover production resources and reconstruct the exact rollout pair",
    );
    const mutation = workflow.indexOf("Arm fail-closed mutation recovery");
    const restore = workflow.indexOf("Restore and verify the exact local canary before admission");
    const rearm = workflow.indexOf("Rearm stale unsealed cost accounting once");
    const pause = workflow.indexOf("Pause and verify both queues before mutation");
    expect(discover).toBeGreaterThan(0);
    expect(discover).toBeLessThan(mutation);
    expect(mutation).toBeLessThan(rearm);
    expect(rearm).toBeLessThan(restore);
    expect(mutation).toBeLessThan(restore);
    expect(restore).toBeLessThan(pause);
    const restoreStep = workflow.slice(restore, pause);
    expect(restoreStep).toContain('wrangler versions deploy "$CANARY_VERSION_ID@100%"');
    expect(workflow.slice(discover, mutation)).toContain("canary-rollback.json");
    expect(restoreStep).toContain("processing-admission-rollback-state.mjs");
    expect(restoreStep).toContain("--mode restore");
    expect(restoreStep).toContain(".artifacts/runtime/canary-rollback.json");
    expect(restoreStep).toContain("verify-processing-admission-state.mjs");
    expect(restoreStep).toContain('--expected-release-report-sha256 "$REPORT_SHA256"');
    expect(restoreStep).toContain("verifyActiveWorkerDeployment");
    expect(restoreStep).toContain('body.execution === "local"');
    expect(restoreStep).toContain("body.disclosure?.upload === false");
    expect(workflow.slice(discover, mutation)).not.toContain(
      "verify-processing-admission-state.mjs",
    );
    expect(workflow.slice(rearm, restore)).toContain(
      "node scripts/.rotate-staging-accounting-epoch.mjs",
    );
    expect(workflow.slice(rearm, restore)).toContain("--mode public-admission-rearm");
  });

  it("fails closed on failure or cancellation before reporting success", () => {
    expect(workflow).toContain(
      "if: always() && steps.mutation.outputs.attempted == 'true' && (failure() || cancelled())",
    );
    expect(workflow).toContain("--mode disable-current");
    expect(workflow).toContain('wrangler queues pause-delivery "$QUEUE_NAME"');
    expect(workflow).toContain('wrangler versions deploy "$CANARY_VERSION_ID@100%"');
    expect(workflow).toContain('body.execution !== "local"');
    expect(workflow).toContain('test "$QUEUE_RECOVERY" -eq 0');
    expect(workflow).toContain('test "$CIRCUIT_RECOVERY" -eq 0');
    expect(workflow).toContain('test "$VERSION_RECOVERY" -eq 0');
    expect(workflow).toContain('test "$POLICY_RECOVERY" -eq 0');
    const recovery = workflow.indexOf("Attempt every fail-closed recovery layer");
    const upload = workflow.indexOf("actions/upload-artifact", recovery);
    const recoveryStep = workflow.slice(recovery, upload);
    expect(recoveryStep.indexOf("processing-admission-rollback-state.mjs")).toBeGreaterThan(0);
    expect(recoveryStep.indexOf("processing-admission-rollback-state.mjs")).toBeLessThan(
      recoveryStep.indexOf("--mode disable-current"),
    );
  });
});
