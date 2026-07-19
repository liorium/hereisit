import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/processing-staging-preflight.yml";

describe("processing staging preflight workflow", () => {
  it("is a manual, main-only, environment-scoped read-only check", () => {
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("environment: processing-staging");
    expect(workflow).toContain(
      "if: github.repository == 'liorium/hereisit' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain(`CLOUDFLARE_ACCOUNT_ID: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}`);
    expect(workflow).toContain(`ALERT_DESTINATION_ADDRESS: \${{ vars.ALERT_DESTINATION_ADDRESS }}`);
  });

  it("validates every required secret before a read-only Cloudflare identity check", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    for (const secret of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_D1_API_TOKEN",
      "CLOUDFLARE_LOGPUSH_API_TOKEN",
      "LOGPUSH_R2_ACCESS_KEY_ID",
      "LOGPUSH_R2_SECRET_ACCESS_KEY",
      "STAGING_ANALYTICS_READ_TOKEN",
      "STAGING_LOGPUSH_STATUS_TOKEN",
      "STAGING_ABUSE_HMAC_SECRET_CURRENT",
      "STAGING_ABUSE_HMAC_SECRET_PREVIOUS",
      "STAGING_MAINTAINER_SESSION_ID",
      "STAGING_MAINTAINER_HASHES_JSON",
    ]) {
      const expression = `${secret}: \${{ secrets.${secret} }}`;
      expect(workflow).toContain(expression);
    }
    const validateIndex = workflow.indexOf(
      "node scripts/verify-processing-deployment-environment.mjs",
    );
    const identityIndex = workflow.indexOf("pnpm exec wrangler whoami");
    expect(validateIndex).toBeGreaterThan(0);
    expect(identityIndex).toBeGreaterThan(validateIndex);
    for (const prohibited of [
      "ensure-cloudflare-processing-resources",
      "wrangler deploy",
      "migrations apply",
      "queues resume-delivery",
    ]) {
      expect(workflow).not.toContain(prohibited);
    }
  });
});
