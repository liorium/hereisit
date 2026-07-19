import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/apply-processing-staging-attestation.yml";

function workflowText() {
  return readFileSync(workflowPath, "utf8");
}

describe("processing staging attestation workflow", () => {
  it("is checked in as a reusable protected deployment gate", () => {
    expect(existsSync(workflowPath)).toBe(true);
    expect(workflowText()).toContain("workflow_call:");
  });

  it("enforces a protected, least-privilege, hash-bound migration and attestation sequence", () => {
    const workflow = workflowText();
    for (const input of [
      "artifact_name",
      "attestation_sha256",
      "wrangler_config_sha256",
      "database_name",
      "database_id",
    ]) {
      expect(workflow).toContain(`      ${input}:\n        required: true\n        type: string`);
    }
    for (const secret of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_D1_API_TOKEN"]) {
      expect(workflow).toContain(`      ${secret}:\n        required: true`);
    }
    expect(workflow).not.toContain("      CLOUDFLARE_ACCOUNT_ID:\n        required: true");
    expect(
      workflow.match(/CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/g),
    ).toHaveLength(2);
    expect(workflow).toContain("permissions:\n  actions: read\n  contents: read");
    expect(workflow).toContain("environment: processing-staging");
    expect(workflow).toContain(
      "if: github.repository == 'liorium/hereisit' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|workflow_dispatch):/m);

    const actionReferences = [...workflow.matchAll(/^\s+- uses: ([^\s]+)(?:\s+#.*)?$/gm)].map(
      (match) => match[1],
    );
    expect(actionReferences).toEqual([
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    ]);

    const verifyIndex = workflow.indexOf("node scripts/verify-deployment-gate-artifacts.mjs");
    const migrateIndex = workflow.indexOf("pnpm exec wrangler d1 migrations apply");
    const applyIndex = workflow.indexOf("node scripts/apply-worker-version-attestations.mjs");
    expect(verifyIndex).toBeGreaterThan(0);
    expect(migrateIndex).toBeGreaterThan(verifyIndex);
    expect(applyIndex).toBeGreaterThan(migrateIndex);
    expect(workflow).toContain('pnpm exec wrangler d1 migrations apply "$D1_NAME" \\');
    expect(workflow).toContain('--config "$WRANGLER_CONFIG" \\');
    expect(workflow).toContain("--remote");

    const runBlocks = [...workflow.matchAll(/run: \|\n((?: {8}.*(?:\n|$))*)/g)].map(
      (match) => match[1],
    );
    expect(runBlocks).toHaveLength(3);
    for (const block of runBlocks) {
      expect(block).not.toContain("${{ secrets.");
      expect(block).not.toContain("${{ inputs.");
    }
  });
});
