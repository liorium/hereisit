import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(`.github/workflows/${name}.yml`, "utf8");

function expectDualResources(workflow: string, environment: "staging" | "production") {
  expect(workflow).toContain(`PDF_QUEUE_NAME: hereisit-pdf-jobs-${environment}`);
  expect(workflow).toContain(`PDF_DLQ_NAME: hereisit-pdf-jobs-dlq-${environment}`);
  expect(workflow).toContain('--pdf-queue-name "$PDF_QUEUE_NAME"');
  expect(workflow).toContain('--pdf-dlq-name "$PDF_DLQ_NAME"');
  expect(workflow).toContain('--pdf-engine-image "$PDF_ENGINE_IMAGE"');
  expect(workflow).toContain("--container-class-name ImageEngineContainer");
  expect(workflow).toContain("--container-class-name PdfEngineContainer");
  expect(workflow).toMatch(/queues pause-delivery "\$PDF_QUEUE_NAME"/u);
  expect(workflow).toMatch(/--queue "\$PDF_DLQ_NAME" --expected paused/u);
}

function expectIsolatedCanaries(workflow: string) {
  const resumeImage = workflow.indexOf('queues resume-delivery "$QUEUE_NAME"');
  const imageSmoke = workflow.indexOf("smoke-image-compress-server.mjs", resumeImage);
  const pauseImage = workflow.indexOf('queues pause-delivery "$QUEUE_NAME"', imageSmoke);
  const resumePdf = workflow.indexOf('queues resume-delivery "$PDF_QUEUE_NAME"', pauseImage);
  const pdfSmoke = workflow.indexOf("smoke-pdf-compress-server.mjs", resumePdf);
  const pausePdf = workflow.indexOf('queues pause-delivery "$PDF_QUEUE_NAME"', pdfSmoke);
  const positions = [resumeImage, imageSmoke, pauseImage, resumePdf, pdfSmoke, pausePdf];
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions.slice(1).every((position, index) => position > positions[index])).toBe(true);
  expect(workflow.slice(pauseImage, pdfSmoke)).toContain('--queue "$QUEUE_NAME" --expected paused');
  expect(workflow.slice(resumePdf, pdfSmoke)).toContain(
    '--queue "$PDF_QUEUE_NAME" --expected resumed',
  );
}

describe("native PDF processing release workflows", () => {
  it("builds one exact @2 release authority in CI and verifies it before every mutation", () => {
    const ci = read("ci");
    const staging = read("processing-staging");
    const production = read("processing-production");
    const admission = read("processing-production-admission");
    expect(ci).toContain("release-authority:");
    expect(ci).toContain('dockerfile="apps/$engine-engine/Dockerfile"');
    expect(ci.match(/docker buildx build/g)).toHaveLength(1);
    expect(ci).toContain("git archive --format=tar");
    expect(ci).toContain("normalize-processing-security-evidence.mjs");
    expect(ci).toContain("environment: processing-release-authority");
    expect(ci).toContain("ghcr.io/aquasecurity/trivy-db:2");
    expect(ci).toContain('--db-repository "ghcr.io/aquasecurity/trivy-db@$TRIVY_DB_DIGEST"');
    expect(ci).toContain("--skip-db-update --offline-scan");
    expect(ci).toContain(".artifacts/runtime/web-staging-scan");
    expect(ci).toContain(".artifacts/runtime/web-production-scan");
    expect(ci).toContain('source="dir:/repo/.artifacts/runtime/$scope-scan"');
    expect(ci).toContain('trivy=(filesystem "/repo/.artifacts/runtime/$scope-scan")');
    expect(ci).not.toMatch(/web-(?:staging|production)\)[^\n]*source="file:/u);
    for (const scope of [
      "engine",
      "pdf-engine",
      "web-staging",
      "web-production",
      "worker",
      "lockfile",
    ]) {
      expect(ci).toContain(`security-sbom-${scope}.cdx.json`);
      expect(ci).toContain(`security-trivy-${scope}.json`);
    }
    expect(ci).toContain("create-processing-candidate.mjs");
    expect(ci).toContain("create-processing-release-report.mjs");
    expect(ci).toContain(
      "cp .artifacts/runtime/evidence-public.pem .artifacts/release-authority/evidence-public.pem",
    );
    expect(ci).toContain(`processing-release-authority-\${{ github.sha }}`);
    for (const workflow of [staging, production, admission]) {
      const verify = workflow.indexOf("verify-processing-deployment-authority.mjs");
      const mutation = Math.min(
        ...[
          "ensure-cloudflare-processing-resources.mjs",
          "wrangler containers push",
          'wrangler deploy "$WORKER_MODULE"',
          "queues pause-delivery",
        ]
          .map((needle) => workflow.indexOf(needle))
          .filter((position) => position >= 0),
      );
      expect(verify).toBeGreaterThanOrEqual(0);
      expect(verify).toBeLessThan(mutation);
      expect(workflow).toContain("REPORT_SHA256=");
      expect(workflow).not.toContain("SOURCE_SHA256=");
    }
    expect(staging).not.toContain("docker buildx build");
  });
  it.each([
    "processing-staging",
    "processing-production",
    "processing-staging-smoke",
  ])("%s restores every prior Queue state under independent cancellation cleanup", (name) => {
    const workflow = read(name);
    expect(workflow).toContain("capture-processing-queue-states.mjs");
    expect(workflow).toContain(
      "if: always() && steps.resume-attempt.outputs.attempted == 'true' && (failure() || cancelled())",
    );
    expect(workflow).toContain("CLOUDFLARE_CLEANUP_API_TOKEN");
    expect(workflow).toContain("timeout-minutes: 5");
    for (const key of ["image-primary", "image-dlq", "pdf-primary", "pdf-dlq"]) {
      expect(workflow).toContain(`restore_queue ${key}`);
    }
    expect(workflow).toContain('--expected "$expected"');
  });
  it("fails CI closed on the sealed PDF benchmark and release gate", () => {
    const workflow = read("ci");
    expect(workflow).toContain("verify-pdf-engine-licenses.mjs");
    expect(workflow).toContain("validate-pdf-benchmark-evidence.mjs");
    expect(read("ci")).toContain("pdf-engine-benchmark.json");
    expect(workflow).toContain("pdf-engine-release-gate.json");
  });

  it("builds, scans, binds, deploys, and authentically smokes both staging engines", () => {
    const workflow = read("processing-staging");
    expectDualResources(workflow, "staging");
    expect(workflow).toContain("pdf-engine-linux-amd64.docker.tar");
    expect(workflow).toContain("hereisit-pdf-engine:$EXPECTED_HEAD_SHA");
    expect(read("ci")).toContain("security-pdf-engine-license-gate.json");
    expect(read("ci")).toContain("pdf-engine-benchmark.json");
    expect(workflow).toContain("smoke-pdf-compress-server.mjs");
    expect(workflow).toContain("pdf-smoke-result.json");
    expectIsolatedCanaries(workflow);
  });

  it("reruns the authenticated PDF lifecycle against the sealed staging deployment", () => {
    const workflow = read("processing-staging-smoke");
    expect(workflow).toContain("PDF_QUEUE_NAME: hereisit-pdf-jobs-staging");
    expect(workflow).toContain("PDF_DLQ_NAME: hereisit-pdf-jobs-dlq-staging");
    expect(workflow).toContain('queues resume-delivery "$PDF_QUEUE_NAME"');
    expect(workflow).toContain("smoke-pdf-compress-server.mjs");
    expect(workflow).toContain('queues pause-delivery "$PDF_QUEUE_NAME"');
    expectIsolatedCanaries(workflow);
  });

  it("keeps production PDF maintainer-only through a dual-engine canary and rollback", () => {
    const workflow = read("processing-production");
    expectDualResources(workflow, "production");
    expect(workflow).toContain("cloudflare-pdf-image-digest.txt");
    expect(workflow).toContain("smoke-pdf-compress-server.mjs");
    expect(workflow).toContain("pdf-canary-smoke.json");
    expectIsolatedCanaries(workflow);
    expect(workflow).toContain("prior-worker-version.json");
    expect(workflow).toContain("prior-admission-state.json");
    expect(workflow).toContain('--engine-image "$PRIOR_IMAGE"');
    expect(workflow).toContain('--engine-image "$PRIOR_PDF_IMAGE"');
  });

  it("cannot authorize anonymous PDF processing from legacy or false visual evidence", () => {
    const workflow = read("processing-production-admission");
    expectDualResources(workflow, "production");
    expect(workflow).toContain("create-pdf-public-admission-state.mjs");
    expect(workflow).toContain("PDF_PUBLIC_ADMISSION_ENABLED");
    expect(workflow).toContain("if: env.PDF_PUBLIC_ADMISSION_ENABLED == 'true'");
    expect(workflow).toMatch(/smoke-pdf-compress-server\.mjs[\s\S]*--anonymous true/u);
  });
});
