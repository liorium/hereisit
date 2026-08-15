import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/processing-production-preflight.yml";

describe("processing production preflight workflow", () => {
  it("is a manual, protected, read-only production check", () => {
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("environment: processing-production");
    expect(workflow).toContain(
      "node scripts/verify-processing-deployment-environment.mjs --environment production",
    );
    expect(workflow).toContain("pnpm exec wrangler whoami");
    expect(workflow).toContain("pnpm exec wrangler d1 list --json");
    expect(workflow).toContain("--mode inspect-current");
    expect(workflow).toContain("processing-production-state.json");
    for (const secret of [
      "PRODUCTION_ANALYTICS_READ_TOKEN",
      "PRODUCTION_LOGPUSH_STATUS_TOKEN",
      "PRODUCTION_ABUSE_HMAC_SECRET_CURRENT",
      "PRODUCTION_ABUSE_HMAC_SECRET_PREVIOUS",
      "PRODUCTION_MAINTAINER_SESSION_ID",
      "PRODUCTION_MAINTAINER_HASHES_JSON",
    ]) {
      expect(workflow).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
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
