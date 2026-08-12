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
  it("fails CI closed on the sealed PDF benchmark and release gate", () => {
    const workflow = read("ci");
    expect(workflow).toContain("verify-pdf-engine-licenses.mjs");
    expect(workflow).toContain("validate-pdf-benchmark-evidence.mjs");
    expect(workflow).toContain("pdf-engine-benchmark.json");
    expect(workflow).toContain("pdf-engine-release-gate.json");
  });

  it("builds, scans, binds, deploys, and authentically smokes both staging engines", () => {
    const workflow = read("processing-staging");
    expectDualResources(workflow, "staging");
    expect(workflow).toContain("apps/pdf-engine/Dockerfile");
    expect(workflow).toContain("hereisit-pdf-engine:$EXPECTED_HEAD_SHA");
    expect(workflow).toContain("security-pdf-engine-license-gate.json");
    expect(workflow).toContain("pdf-engine-benchmark.json");
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
  });

  it("cannot authorize anonymous PDF processing from legacy or false visual evidence", () => {
    const workflow = read("processing-production-admission");
    expectDualResources(workflow, "production");
    expect(workflow).toContain("pdfQuality.publicAdmissionReady");
    expect(workflow).toContain("PDF_PUBLIC_ADMISSION_BLOCKED_NO_VISUAL_EVIDENCE");
    expect(workflow).toContain("publicAdmissionReady !== true");
    expect(workflow).not.toMatch(/smoke-pdf-compress-server\.mjs[^\n]*--anonymous/u);
  });
});
