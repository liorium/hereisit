import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertClosedSchema,
  validateJsonSchema,
  validatePdfVisualInputManifest,
} from "./benchmark-pdf-engine.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const PROJECT_SCHEMA = "hereisit.pdf-browser-visual-project@1";
const EVIDENCE_SCHEMA = "hereisit.pdf-browser-visual-evidence@1";
export const PDF_VISUAL_BROWSER_PROJECTS = Object.freeze(["chromium", "firefox", "webkit"]);
const SHA = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;

function identity(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function runId(value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError("check run ID is invalid");
  return parsed;
}

function visualResults(raw, input) {
  if (!Array.isArray(raw) || raw.length !== 3)
    throw new TypeError("PDF browser visual results are incomplete");
  return raw.map((rawResult, index) => {
    const result = assertObject(rawResult, "PDF browser visual result");
    assertExactKeys(
      result,
      ["repeat", "sha256", "byteLength", "verified"],
      "PDF browser visual result",
    );
    const expected = input.results[index];
    if (
      result.repeat !== index ||
      result.verified !== true ||
      result.sha256 !== expected?.sha256 ||
      result.byteLength !== expected?.byteLength
    )
      throw new TypeError("PDF browser visual result does not match its input");
    return result;
  });
}

export function validatePdfVisualProjectReceipt(raw, input) {
  const receipt = assertObject(raw, "PDF browser visual project receipt");
  assertExactKeys(
    receipt,
    [
      "schema",
      "version",
      "passed",
      "gitSha",
      "sourceSha256",
      "checkRunId",
      "execution",
      "project",
      "inputManifestSha256",
      "engineImageDigest",
      "results",
    ],
    "PDF browser visual project receipt",
  );
  if (
    receipt.schema !== PROJECT_SCHEMA ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.execution !== "exact-main-hosted-pdf-visual" ||
    !PDF_VISUAL_BROWSER_PROJECTS.includes(receipt.project)
  )
    throw new TypeError("PDF browser visual project identity is invalid");
  identity(receipt.gitSha, GIT_SHA, "PDF browser visual git SHA");
  assertSha256(receipt.sourceSha256, "PDF browser visual source SHA-256");
  runId(receipt.checkRunId);
  assertSha256(receipt.inputManifestSha256, "PDF visual input manifest SHA-256");
  if (receipt.engineImageDigest !== input.engineImageDigest)
    throw new TypeError("PDF browser visual engine identity drifted");
  visualResults(receipt.results, input);
  return receipt;
}

export function createPdfVisualProjectReceipt({
  gitSha,
  sourceSha256,
  checkRunId,
  project,
  inputManifestSha256,
  input: rawInput,
}) {
  const input = validatePdfVisualInputManifest(rawInput);
  return validatePdfVisualProjectReceipt(
    {
      schema: PROJECT_SCHEMA,
      version: 1,
      passed: true,
      gitSha,
      sourceSha256,
      checkRunId: runId(checkRunId),
      execution: "exact-main-hosted-pdf-visual",
      project,
      inputManifestSha256,
      engineImageDigest: input.engineImageDigest,
      results: input.results.map((result) => ({
        repeat: result.repeat,
        sha256: result.sha256,
        byteLength: result.byteLength,
        verified: true,
      })),
    },
    input,
  );
}

export function validatePdfVisualBrowserEvidence(raw) {
  const evidence = assertObject(raw, "PDF browser visual evidence");
  assertExactKeys(
    evidence,
    [
      "schema",
      "version",
      "passed",
      "gitSha",
      "sourceSha256",
      "checkRunId",
      "execution",
      "inputManifestSha256",
      "engineImageDigest",
      "corpusManifestSha256",
      "stratum",
      "projects",
      "visualProfilesMeasured",
    ],
    "PDF browser visual evidence",
  );
  if (
    evidence.schema !== EVIDENCE_SCHEMA ||
    evidence.version !== 1 ||
    evidence.passed !== true ||
    evidence.execution !== "exact-main-hosted-pdf-visual" ||
    evidence.stratum !== "jpeg-heavy" ||
    evidence.visualProfilesMeasured !== 9
  )
    throw new TypeError("PDF browser visual evidence identity is invalid");
  identity(evidence.gitSha, GIT_SHA, "PDF browser visual git SHA");
  assertSha256(evidence.sourceSha256, "PDF browser visual source SHA-256");
  runId(evidence.checkRunId);
  assertSha256(evidence.inputManifestSha256, "PDF visual input manifest SHA-256");
  identity(evidence.engineImageDigest, /^sha256:[a-f0-9]{64}$/u, "PDF visual engine digest");
  assertSha256(evidence.corpusManifestSha256, "PDF visual corpus SHA-256");
  if (
    !Array.isArray(evidence.projects) ||
    evidence.projects.length !== PDF_VISUAL_BROWSER_PROJECTS.length
  )
    throw new TypeError("PDF browser visual projects are incomplete");
  for (const [index, rawProject] of evidence.projects.entries()) {
    const project = assertObject(rawProject, "PDF browser visual project");
    assertExactKeys(project, ["project", "passed", "results"], "PDF browser visual project");
    if (project.project !== PDF_VISUAL_BROWSER_PROJECTS[index] || project.passed !== true)
      throw new TypeError("PDF browser visual project order is invalid");
    if (!Array.isArray(project.results) || project.results.length !== 3)
      throw new TypeError("PDF browser visual project results are incomplete");
    for (const [repeat, rawResult] of project.results.entries()) {
      const result = assertObject(rawResult, "PDF browser visual project result");
      assertExactKeys(
        result,
        ["repeat", "sha256", "byteLength", "verified"],
        "PDF browser visual project result",
      );
      if (
        result.repeat !== repeat ||
        result.verified !== true ||
        !SHA.test(result.sha256) ||
        !Number.isSafeInteger(result.byteLength) ||
        result.byteLength < 1 ||
        result.byteLength > 50 * 1024 * 1024
      )
        throw new TypeError("PDF browser visual project result is invalid");
    }
  }
  return evidence;
}

export async function validatePdfVisualBrowserEvidenceSchema(evidence, schema) {
  assertClosedSchema(schema);
  if (schema?.properties?.schema?.const !== EVIDENCE_SCHEMA)
    throw new TypeError("PDF browser visual evidence schema vocabulary is invalid");
  validateJsonSchema(evidence, schema, schema);
  validatePdfVisualBrowserEvidence(evidence);
}

async function readInput(inputRoot) {
  const root = resolve(inputRoot);
  const manifestBytes = await readBoundedRegularFile(
    join(root, "manifest.json"),
    1024 * 1024,
    "PDF visual input manifest",
  );
  const input = validatePdfVisualInputManifest(JSON.parse(manifestBytes.toString("utf8")));
  for (const artifact of [input.source, ...input.results]) {
    const bytes = await readBoundedRegularFile(
      join(root, artifact.artifact),
      50 * 1024 * 1024,
      "PDF visual private input",
    );
    if (bytes.byteLength !== artifact.byteLength || sha256Bytes(bytes) !== artifact.sha256)
      throw new TypeError("PDF visual private input digest is invalid");
  }
  return { input, inputManifestSha256: sha256Bytes(manifestBytes) };
}

export async function createPdfVisualBrowserEvidence({
  inputRoot,
  receiptRoot,
  output,
  gitSha,
  sourceSha256,
  checkRunId,
}) {
  identity(gitSha, GIT_SHA, "PDF browser visual git SHA");
  assertSha256(sourceSha256, "PDF browser visual source SHA-256");
  const parsedRunId = runId(checkRunId);
  const { input, inputManifestSha256 } = await readInput(inputRoot);
  const receipts = [];
  for (const project of PDF_VISUAL_BROWSER_PROJECTS) {
    const bytes = await readBoundedRegularFile(
      join(resolve(receiptRoot), `${project}.json`),
      1024 * 1024,
      `${project} PDF visual receipt`,
    );
    const receipt = validatePdfVisualProjectReceipt(JSON.parse(bytes.toString("utf8")), input);
    if (
      receipt.project !== project ||
      receipt.gitSha !== gitSha ||
      receipt.sourceSha256 !== sourceSha256 ||
      receipt.checkRunId !== parsedRunId ||
      receipt.inputManifestSha256 !== inputManifestSha256
    )
      throw new TypeError("PDF visual receipt does not bind the exact hosted execution");
    receipts.push(receipt);
  }
  const evidence = validatePdfVisualBrowserEvidence({
    schema: EVIDENCE_SCHEMA,
    version: 1,
    passed: true,
    gitSha,
    sourceSha256,
    checkRunId: parsedRunId,
    execution: "exact-main-hosted-pdf-visual",
    inputManifestSha256,
    engineImageDigest: input.engineImageDigest,
    corpusManifestSha256: input.corpusManifestSha256,
    stratum: input.stratum,
    projects: receipts.map((receipt) => ({
      project: receipt.project,
      passed: true,
      results: receipt.results,
    })),
    visualProfilesMeasured: receipts.reduce((total, receipt) => total + receipt.results.length, 0),
  });
  await writeCanonicalJsonAtomic(resolve(output), evidence, { refuseOverwrite: true, mode: 0o600 });
  return evidence;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = parseCliArguments(process.argv.slice(2));
  assertExactKeys(
    args,
    ["input-root", "receipt-root", "output", "git-sha", "source-sha256", "check-run-id"],
    "PDF browser visual evidence CLI arguments",
  );
  const evidence = await createPdfVisualBrowserEvidence({
    inputRoot: args["input-root"],
    receiptRoot: args["receipt-root"],
    output: args.output,
    gitSha: args["git-sha"],
    sourceSha256: args["source-sha256"],
    checkRunId: args["check-run-id"],
  });
  process.stdout.write(
    `${canonicalJson({ ok: true, visualProfilesMeasured: evidence.visualProfilesMeasured })}\n`,
  );
}
