#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluatePdfEngineReleaseGate,
  validatePdfBenchmarkReport,
  validatePdfEvidenceSchemas,
  validatePdfReleaseGate,
} from "./benchmark-pdf-engine.mjs";
import { assertExactKeys, canonicalJson, parseCliArguments } from "./image-lab-common.mjs";

export async function validatePdfBenchmarkEvidence({
  report: reportRaw,
  gate: gateRaw,
  benchmarkSchema,
  gateSchema,
  expectedEngineImageDigest,
}) {
  const report = validatePdfBenchmarkReport(reportRaw);
  const gate = validatePdfReleaseGate(gateRaw);
  await validatePdfEvidenceSchemas({ report, gate, benchmarkSchema, gateSchema });
  if (canonicalJson(gate) !== canonicalJson(evaluatePdfEngineReleaseGate(report))) {
    throw new TypeError("PDF evidence gate does not match report");
  }
  if (gate.passed !== true) throw new TypeError("PDF structural quality gate did not pass");
  if (
    expectedEngineImageDigest !== undefined &&
    (report.identity.engineImageDigest !== expectedEngineImageDigest ||
      gate.engineImageDigest !== expectedEngineImageDigest)
  ) {
    throw new TypeError("PDF evidence engine image digest does not match");
  }
  return {
    benchmarkSha256: gate.benchmarkSha256,
    releaseGateSha256: createHash("sha256").update(canonicalJson(gate)).digest("hex"),
    visualProfilesMeasured: gate.visualProfilesMeasured,
    publicAdmissionReady: gate.publicAdmissionReady,
  };
}

async function run(argv) {
  const args = parseCliArguments(argv);
  assertExactKeys(
    args,
    ["report", "gate", "benchmark-schema", "gate-schema"],
    "PDF evidence CLI arguments",
  );
  const [report, gate, benchmarkSchema, gateSchema] = await Promise.all(
    [args.report, args.gate, args["benchmark-schema"], args["gate-schema"]].map(async (path) =>
      JSON.parse(await readFile(resolve(path), "utf8")),
    ),
  );
  const result = await validatePdfBenchmarkEvidence({ report, gate, benchmarkSchema, gateSchema });
  process.stdout.write(`${JSON.stringify({ ok: true, passed: true, ...result })}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await run(process.argv.slice(2));
}
