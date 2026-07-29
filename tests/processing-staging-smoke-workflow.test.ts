import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/processing-staging-smoke.yml", "utf8");

describe("processing staging smoke workflow", () => {
  it("is a manual main-only check serialized with deployment", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: processing-staging");
    expect(workflow).toContain(
      "if: github.repository == 'liorium/hereisit' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("environment: processing-staging");
  });

  it("resumes only primary delivery and fails closed", () => {
    const resume = workflow.indexOf('wrangler queues resume-delivery "$QUEUE_NAME"');
    const smoke = workflow.indexOf("node scripts/smoke-image-compress-server.mjs");
    const cleanup = workflow.indexOf('wrangler queues pause-delivery "$QUEUE_NAME"');

    expect(resume).toBeGreaterThan(0);
    expect(smoke).toBeGreaterThan(resume);
    expect(cleanup).toBeGreaterThan(smoke);
    expect(workflow).not.toContain('queues resume-delivery "$DLQ_NAME"');
    expect(workflow.slice(cleanup)).toContain('--queue "$QUEUE_NAME" --expected paused');
    expect(workflow.slice(cleanup)).toContain('--queue "$DLQ_NAME" --expected paused');
    expect(workflow).toContain(
      `STAGING_MAINTAINER_SESSION_ID: \${{ secrets.STAGING_MAINTAINER_SESSION_ID }}`,
    );
  });
});
