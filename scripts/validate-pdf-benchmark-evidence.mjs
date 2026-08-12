#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluatePdfEngineReleaseGate,
  validatePdfBenchmarkReport,
  validatePdfEvidenceSchemas,
  validatePdfReleaseGate,
} from "./benchmark-pdf-engine.mjs";
import { assertExactKeys, canonicalJson, parseCliArguments } from "./image-lab-common.mjs";

const args = parseCliArguments(process.argv.slice(2));
assertExactKeys(
  args,
  ["report", "gate", "benchmark-schema", "gate-schema"],
  "PDF evidence CLI arguments",
);
const [reportRaw, gateRaw, benchmarkSchema, gateSchema] = await Promise.all(
  [args.report, args.gate, args["benchmark-schema"], args["gate-schema"]].map(async (path) =>
    JSON.parse(await readFile(resolve(path), "utf8")),
  ),
);
const report = validatePdfBenchmarkReport(reportRaw);
const gate = validatePdfReleaseGate(gateRaw);
await validatePdfEvidenceSchemas({ report, gate, benchmarkSchema, gateSchema });
if (canonicalJson(gate) !== canonicalJson(evaluatePdfEngineReleaseGate(report)))
  throw new TypeError("PDF evidence gate does not match report");
process.stdout.write(`${JSON.stringify({ ok: true, passed: gate.passed })}\n`);
