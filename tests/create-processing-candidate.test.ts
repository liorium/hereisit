import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("native PDF processing release source contract", () => {
  it("binds an immutable PDF engine and canonical quality evidence beside the image engine", () => {
    const candidate = readFileSync("scripts/create-processing-candidate.mjs", "utf8");
    const verifier = readFileSync("scripts/verify-processing-candidate.mjs", "utf8");
    const report = readFileSync("scripts/create-processing-release-report.mjs", "utf8");

    for (const source of [candidate, verifier, report]) expect(source).toContain("pdfEngine");
    expect(candidate).toContain("pdf-engine-linux-amd64.docker.tar");
    expect(candidate).toContain("pdf-engine-release-gate.json");
    expect(candidate).toContain("pdf-engine-benchmark.json");
    expect(verifier).toContain("validatePdfBenchmarkEvidence");
    expect(report).toContain("pdfEngineDockerConfigDigest");
  });
});
