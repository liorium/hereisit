import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePdfBenchmarkReport, validatePdfReleaseGate } from "./benchmark-pdf-engine.mjs";
import { validatePdfVisualBrowserEvidence } from "./create-pdf-visual-browser-evidence.mjs";
import {
  hostedReviewSchemas,
  validateHostedReviewDocument,
} from "./create-processing-hosted-check.mjs";
import {
  assertExactKeys,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const projects = Object.freeze([
  "chromium",
  "firefox",
  "mobile-chromium",
  "mobile-firefox",
  "webkit",
  "mobile-webkit",
]);

async function readJson(path, label) {
  const bytes = await readBoundedRegularFile(resolve(path), 16 * 1024 * 1024, label);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

export async function createPdfVisualHostedReports({
  benchmarkPath,
  gatePath,
  visualEvidencePath,
  output,
  gitSha,
  sourceSha256,
  checkRunId,
}) {
  assertSha256(sourceSha256, "hosted source hash");
  const runId = typeof checkRunId === "string" ? Number(checkRunId) : checkRunId;
  if (!/^[a-f0-9]{40}$/u.test(gitSha ?? "") || !Number.isSafeInteger(runId) || runId < 1)
    throw new TypeError("hosted execution identity is invalid");

  const benchmarkFile = await readJson(benchmarkPath, "PDF benchmark evidence");
  const gateFile = await readJson(gatePath, "PDF release gate evidence");
  const visualFile = await readJson(visualEvidencePath, "PDF browser visual evidence");
  const benchmark = validatePdfBenchmarkReport(benchmarkFile.value);
  const gate = validatePdfReleaseGate(gateFile.value, benchmark);
  const visual = validatePdfVisualBrowserEvidence(visualFile.value);
  if (
    !gate.publicAdmissionReady ||
    gate.visualProfilesMeasured !== 3 ||
    visual.gitSha !== gitSha ||
    visual.sourceSha256 !== sourceSha256 ||
    visual.checkRunId !== runId ||
    visual.engineImageDigest !== gate.engineImageDigest ||
    visual.corpusManifestSha256 !== gate.corpusManifestSha256 ||
    visual.visualProfilesMeasured !== gate.visualProfilesMeasured * 3
  )
    throw new TypeError("PDF browser evidence does not match the exact public benchmark identity");

  const common = {
    version: 1,
    passed: true,
    gitSha,
    sourceSha256,
    checkRunId: runId,
    execution: "exact-main-hosted-check",
  };
  const documents = {
    fullCorpusBenchmark: {
      schema: hostedReviewSchemas.fullCorpusBenchmark,
      ...common,
      profilesMeasured: gate.visualProfilesMeasured,
      corpusSha256: gate.corpusManifestSha256,
      benchmarkSha256: gate.benchmarkSha256,
      releaseGateSha256: sha256Bytes(canonicalJson(gate)),
      engineImageDigest: gate.engineImageDigest,
    },
    deviceMatrix: {
      schema: hostedReviewSchemas.deviceMatrix,
      ...common,
      projects,
      productAnalytics: true,
      pdfVisualEvidenceSha256: sha256Bytes(visualFile.bytes),
      pdfVisualProfilesMeasured: visual.visualProfilesMeasured,
    },
  };
  const root = resolve(output);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [name, document] of Object.entries(documents)) {
    validateHostedReviewDocument(document, { name, gitSha, sourceSha256, checkRunId: runId });
    await writeCanonicalJsonAtomic(join(root, `${name}.json`), document, {
      refuseOverwrite: true,
      mode: 0o600,
    });
  }
  return documents;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = parseCliArguments(process.argv.slice(2));
  assertExactKeys(
    args,
    ["benchmark", "gate", "visual-evidence", "output", "git-sha", "source-sha256", "check-run-id"],
    "PDF visual hosted report CLI arguments",
  );
  const documents = await createPdfVisualHostedReports({
    benchmarkPath: args.benchmark,
    gatePath: args.gate,
    visualEvidencePath: args["visual-evidence"],
    output: args.output,
    gitSha: args["git-sha"],
    sourceSha256: args["source-sha256"],
    checkRunId: args["check-run-id"],
  });
  process.stdout.write(`${canonicalJson({ ok: true, reports: Object.keys(documents) })}\n`);
}
