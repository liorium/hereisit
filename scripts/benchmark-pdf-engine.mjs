import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  probePdfCorpusFeature,
  REQUIRED_PDF_CORPUS_STRATA,
  validatePdfCorpusManifest,
  verifyPdfCorpusFiles,
} from "./create-pdf-compression-corpus.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
} from "./image-lab-common.mjs";

const execute = promisify(execFile);
const pdfLibVersion = "2.7.1";
const SCHEMA = "hereisit.pdf-engine-benchmark@2";
const GATE_SCHEMA = "hereisit.pdf-engine-release-gate@1";
const REPEATS = 3;
const MAX_SAMPLES = REQUIRED_PDF_CORPUS_STRATA.length * REPEATS;
const MAX_WALL_MS = 300_000;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_RSS_BYTES = 768 * 1024 * 1024;
const MAX_PARSER_PIXELS = 20_000_000;
const MAX_DIAGNOSTIC_BYTES = 4096;
const HOSTILE = new Set(["encrypted", "corrupt", "decompression-bomb"]);
const STRUCTURED = new Set([
  "text-vector",
  "link",
  "annotation",
  "form",
  "outline",
  "attachment",
  "layer",
  "duplicate-resource",
  "flate-heavy",
  "mixed",
]);
const VERDICTS = new Set(["reduced", "original-retained", "rejected"]);
const SEMANTIC_VERIFICATIONS = new Set(["passed", "failed", "not-applicable"]);
const VISUAL_VERIFICATIONS = new Set(["passed", "failed", "not-applicable", "not-required"]);
const VISUAL_INPUT_SCHEMA = "hereisit.pdf-browser-visual-input@1";

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} is invalid`);
  return value;
}

function finite(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} is invalid`);
  return value;
}

function safeString(value, pattern, label) {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    /(?:https?:\/\/|file:\/\/|[\\/]|\.\.)/iu.test(value)
  )
    throw new TypeError(`${label} is unsafe`);
  return value;
}

function median(values) {
  return values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];
}

function validateRunner(raw, label) {
  const runner = assertObject(raw, label);
  assertExactKeys(
    runner,
    [
      "samples",
      "medianEffectiveBytes",
      "medianDurationMs",
      "maximumPeakRssBytes",
      "maximumCandidateCount",
    ],
    label,
  );
  if (!Array.isArray(runner.samples) || runner.samples.length !== REPEATS)
    throw new TypeError(`${label} samples are incomplete`);
  const repeats = new Set();
  for (const [index, rawSample] of runner.samples.entries()) {
    const sample = assertObject(rawSample, `${label} sample`);
    assertExactKeys(
      sample,
      [
        "repeat",
        "verdict",
        "effectiveBytes",
        "durationMs",
        "peakRssBytes",
        "candidateCount",
        "code",
        "profile",
        "semantic",
        "visual",
      ],
      `${label} sample`,
    );
    repeats.add(integer(sample.repeat, 0, REPEATS - 1, `${label} repeat`));
    if (sample.repeat !== index) throw new TypeError(`${label} repeat order is not canonical`);
    if (!VERDICTS.has(sample.verdict)) throw new TypeError(`${label} verdict is invalid`);
    if (sample.effectiveBytes !== null)
      integer(sample.effectiveBytes, 1, MAX_OUTPUT_BYTES, `${label} effective bytes`);
    finite(sample.durationMs, 0, MAX_WALL_MS, `${label} duration`);
    integer(sample.peakRssBytes, 0, Number.MAX_SAFE_INTEGER, `${label} peak RSS`);
    integer(sample.candidateCount, 0, 2, `${label} candidate count`);
    if (sample.code !== null) safeString(sample.code, /^[A-Z][A-Z0-9_]{2,48}$/u, `${label} code`);
    if (sample.profile !== null && !["structural", "image-optimized"].includes(sample.profile))
      throw new TypeError(`${label} profile is invalid`);
    if (!SEMANTIC_VERIFICATIONS.has(sample.semantic) || !VISUAL_VERIFICATIONS.has(sample.visual))
      throw new TypeError(`${label} verification is invalid`);
    if (
      (sample.verdict === "rejected") !== (sample.effectiveBytes === null) ||
      (sample.verdict === "rejected") !== (sample.code !== null)
    )
      throw new TypeError(`${label} verdict fields are inconsistent`);
    if (
      sample.verdict === "rejected" &&
      (sample.semantic !== "not-applicable" || sample.visual !== "not-applicable")
    )
      throw new TypeError(`${label} rejection verification is invalid`);
  }
  if (repeats.size !== REPEATS) throw new TypeError(`${label} repeats are duplicated`);
  const effective = runner.samples
    .map((sample) => sample.effectiveBytes)
    .filter((value) => value !== null);
  const derivedBytes = effective.length === REPEATS ? median(effective) : null;
  const derivedDuration = median(runner.samples.map((sample) => sample.durationMs));
  const derivedRss = Math.max(...runner.samples.map((sample) => sample.peakRssBytes));
  const derivedCandidates = Math.max(...runner.samples.map((sample) => sample.candidateCount));
  if (
    runner.medianEffectiveBytes !== derivedBytes ||
    runner.medianDurationMs !== derivedDuration ||
    runner.maximumPeakRssBytes !== derivedRss ||
    runner.maximumCandidateCount !== derivedCandidates
  )
    throw new TypeError(`${label} derivation is inconsistent`);
  return runner;
}

export function validatePdfBenchmarkReport(raw) {
  const report = assertObject(raw, "PDF benchmark report");
  assertExactKeys(
    report,
    ["schema", "identity", "limits", "records", "summary"],
    "PDF benchmark report",
  );
  if (report.schema !== SCHEMA) throw new TypeError("PDF benchmark schema is invalid");
  const identity = assertObject(report.identity, "PDF benchmark identity");
  assertExactKeys(
    identity,
    [
      "engineImageId",
      "engineImageDigest",
      "qpdfVersion",
      "corpusManifestSha256",
      "sourceLockSha256",
      "localRunner",
    ],
    "PDF benchmark identity",
  );
  safeString(identity.engineImageId, /^sha256:[a-f0-9]{64}$/u, "engine image ID");
  safeString(identity.engineImageDigest, /^sha256:[a-f0-9]{64}$/u, "engine image digest");
  if (identity.engineImageId !== identity.engineImageDigest)
    throw new TypeError("PDF benchmark image identity is inconsistent");
  safeString(identity.qpdfVersion, /^12\.4\.0$/u, "qpdf version");
  assertSha256(identity.corpusManifestSha256, "corpus manifest SHA-256");
  assertSha256(identity.sourceLockSha256, "source lock SHA-256");
  safeString(identity.localRunner, /^pdf-lib-structural@\d+\.\d+\.\d+$/u, "local runner");
  const limits = assertObject(report.limits, "PDF benchmark limits");
  assertExactKeys(
    limits,
    [
      "repeats",
      "maximumSamples",
      "maximumWallMs",
      "maximumSourceBytes",
      "maximumOutputBytes",
      "maximumPeakRssBytes",
      "maximumParserPixels",
      "maximumDiagnosticBytes",
    ],
    "PDF benchmark limits",
  );
  const derivedPassed = gateFailures(report).length === 0;
  if (
    limits.repeats !== REPEATS ||
    limits.maximumSamples !== MAX_SAMPLES ||
    limits.maximumWallMs !== MAX_WALL_MS ||
    limits.maximumSourceBytes !== MAX_SOURCE_BYTES ||
    limits.maximumOutputBytes !== MAX_OUTPUT_BYTES ||
    limits.maximumPeakRssBytes !== MAX_RSS_BYTES ||
    limits.maximumParserPixels !== MAX_PARSER_PIXELS ||
    limits.maximumDiagnosticBytes !== MAX_DIAGNOSTIC_BYTES
  )
    throw new TypeError("PDF benchmark limits are invalid");
  if (!Array.isArray(report.records) || report.records.length !== REQUIRED_PDF_CORPUS_STRATA.length)
    throw new TypeError("PDF benchmark records are incomplete");
  const seen = new Set();
  for (const recordRaw of report.records) {
    const record = assertObject(recordRaw, "PDF benchmark record");
    assertExactKeys(
      record,
      [
        "stratum",
        "sourceBytes",
        "local",
        "native",
        "smallerOnly",
        "repeatableNativeWins",
        "nativeAdvantageRatio",
      ],
      "PDF benchmark record",
    );
    if (!REQUIRED_PDF_CORPUS_STRATA.includes(record.stratum) || seen.has(record.stratum))
      throw new TypeError("PDF benchmark stratum is invalid or duplicated");
    seen.add(record.stratum);
    integer(record.sourceBytes, 1, MAX_SOURCE_BYTES, "PDF benchmark source bytes");
    const local = validateRunner(record.local, "local PDF runner");
    const native = validateRunner(record.native, "native PDF runner");
    const allSamples = [...local.samples, ...native.samples];
    const smallerOnly = allSamples.every(
      (sample) => sample.effectiveBytes === null || sample.effectiveBytes <= record.sourceBytes,
    );
    if (record.smallerOnly !== smallerOnly)
      throw new TypeError("smaller-only derivation is invalid");
    const wins = native.samples.filter(
      (sample, index) =>
        sample.effectiveBytes !== null &&
        local.samples[index].effectiveBytes !== null &&
        local.samples[index].effectiveBytes - sample.effectiveBytes >=
          Math.max(1, Math.ceil(record.sourceBytes / 100)),
    ).length;
    integer(record.repeatableNativeWins, 0, REPEATS, "repeatable native wins");
    if (record.repeatableNativeWins !== wins)
      throw new TypeError("repeat win derivation is invalid");
    finite(record.nativeAdvantageRatio, -1, 1, "native advantage ratio");
    const advantage =
      local.medianEffectiveBytes === null || native.medianEffectiveBytes === null
        ? 0
        : (local.medianEffectiveBytes - native.medianEffectiveBytes) / record.sourceBytes;
    if (Math.abs(record.nativeAdvantageRatio - advantage) > 1e-9)
      throw new TypeError("native advantage derivation is invalid");
  }
  if (REQUIRED_PDF_CORPUS_STRATA.some((stratum) => !seen.has(stratum)))
    throw new TypeError("PDF benchmark stratum is missing");
  const summary = assertObject(report.summary, "PDF benchmark summary");
  assertExactKeys(
    summary,
    [
      "strata",
      "measuredSamples",
      "nativeWins",
      "rejectedSafely",
      "maximumPeakRssBytes",
      "visualProfilesMeasured",
      "passed",
    ],
    "PDF benchmark summary",
  );
  const nativeWins = report.records.filter(
    (record) =>
      STRUCTURED.has(record.stratum) &&
      record.repeatableNativeWins >= 2 &&
      record.nativeAdvantageRatio >= 0.01,
  ).length;
  const rejectedSafely = report.records.filter(
    (record) =>
      HOSTILE.has(record.stratum) &&
      [...record.local.samples, ...record.native.samples].every(
        (sample) => sample.verdict === "rejected",
      ),
  ).length;
  const maximumPeakRssBytes = Math.max(
    ...report.records.flatMap((record) =>
      [...record.local.samples, ...record.native.samples].map((sample) => sample.peakRssBytes),
    ),
  );
  const visualProfilesMeasured = report.records
    .flatMap((record) => record.native.samples)
    .filter((sample) => sample.profile === "image-optimized" && sample.visual === "passed").length;
  if (
    summary.strata !== report.records.length ||
    summary.measuredSamples !== report.records.length * REPEATS ||
    summary.nativeWins !== nativeWins ||
    summary.rejectedSafely !== rejectedSafely ||
    summary.maximumPeakRssBytes !== maximumPeakRssBytes ||
    summary.visualProfilesMeasured !== visualProfilesMeasured ||
    summary.passed !== derivedPassed
  )
    throw new TypeError("summary derivation is invalid");
  return report;
}

function gateFailures(report) {
  const failures = [];
  for (const record of report.records) {
    if (!record.smallerOnly) failures.push(`${record.stratum}:EXPANSION`);
    for (const [runnerName, runner] of [
      ["local", record.local],
      ["native", record.native],
    ]) {
      for (const sample of runner.samples) {
        if (sample.effectiveBytes !== null && sample.effectiveBytes > record.sourceBytes)
          failures.push(`${record.stratum}:${runnerName}:EXPANSION`);
        if (sample.peakRssBytes > report.limits.maximumPeakRssBytes)
          failures.push(`${record.stratum}:${runnerName}:RSS_LIMIT`);
        if (
          sample.peakRssBytes === 0 &&
          (sample.verdict !== "rejected" ||
            (record.stratum === "decompression-bomb" && runnerName === "native"))
        )
          failures.push(`${record.stratum}:${runnerName}:RSS_NOT_MEASURED`);
        if (sample.semantic !== "passed" && sample.verdict !== "rejected")
          failures.push(`${record.stratum}:${runnerName}:SEMANTIC`);
        if (
          sample.visual === "failed" ||
          (sample.profile === "image-optimized" && sample.visual !== "passed")
        )
          failures.push(`${record.stratum}:${runnerName}:VISUAL`);
        const safeCode =
          record.stratum === "decompression-bomb"
            ? runnerName === "native"
              ? "INPUT_LIMIT_EXCEEDED"
              : "INFLATED_LIMIT_EXCEEDED"
            : HOSTILE.has(record.stratum)
              ? "UNSUPPORTED_INPUT"
              : null;
        if (sample.verdict === "rejected" && safeCode !== null && sample.code !== safeCode)
          failures.push(`${record.stratum}:${runnerName}:UNSAFE_REJECTION_CODE`);
      }
    }
    if (
      HOSTILE.has(record.stratum) &&
      [...record.local.samples, ...record.native.samples].some(
        (sample) => sample.verdict !== "rejected",
      )
    )
      failures.push(`${record.stratum}:UNSAFE_ACCEPTANCE`);
  }
  if (
    !report.records.some(
      (record) =>
        STRUCTURED.has(record.stratum) &&
        record.repeatableNativeWins >= 2 &&
        record.nativeAdvantageRatio >= 0.01,
    )
  )
    failures.push("NO_REPEATABLE_STRUCTURED_NATIVE_ADVANTAGE");
  return [...new Set(failures)].sort();
}

export async function readBoundedPdfResponse(response) {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null || !/^(?:[1-9]\d*)$/u.test(rawLength))
    throw new TypeError("PDF output length is invalid");
  const expected = Number(rawLength);
  if (!Number.isSafeInteger(expected) || expected > MAX_OUTPUT_BYTES || response.body === null)
    throw new RangeError("PDF output length exceeds its limit");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expected || total > MAX_OUTPUT_BYTES)
        throw new RangeError("PDF output stream exceeded its limit");
      chunks.push(Buffer.from(value));
    }
    if (total !== expected) throw new RangeError("PDF output length mismatch");
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

export async function fetchBeforeDeadline(input, init, deadline, fetchImplementation = fetch) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("PDF benchmark wall limit exceeded");
  const timeout = AbortSignal.timeout(remaining);
  const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
  return fetchImplementation(input, { ...init, signal });
}

export async function runBenchmarkRepeats({ deadline, operation, now = Date.now }) {
  const results = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    if (now() >= deadline) throw new Error("PDF benchmark wall limit exceeded");
    results.push(await operation(repeat, deadline));
    if (now() >= deadline) throw new Error("PDF benchmark wall limit exceeded");
  }
  return results;
}

function hasPdfEnvelope(bytes) {
  return (
    bytes.byteLength >= 14 &&
    Buffer.from(bytes).subarray(0, 5).toString("ascii") === "%PDF-" &&
    Buffer.from(bytes).subarray(-1024).includes(Buffer.from("%%EOF"))
  );
}

function validateVisualArtifact(raw, label, artifactPattern, extraKeys = []) {
  const artifact = assertObject(raw, label);
  assertExactKeys(artifact, ["artifact", "sha256", "byteLength", ...extraKeys], label);
  safeString(artifact.artifact, artifactPattern, `${label} artifact`);
  assertSha256(artifact.sha256, `${label} SHA-256`);
  integer(artifact.byteLength, 1, MAX_OUTPUT_BYTES, `${label} byte length`);
  return artifact;
}

export function validatePdfVisualInputManifest(raw) {
  const manifest = assertObject(raw, "PDF visual input manifest");
  assertExactKeys(
    manifest,
    [
      "schema",
      "version",
      "engineImageDigest",
      "corpusManifestSha256",
      "stratum",
      "source",
      "results",
    ],
    "PDF visual input manifest",
  );
  if (
    manifest.schema !== VISUAL_INPUT_SCHEMA ||
    manifest.version !== 1 ||
    manifest.stratum !== "jpeg-heavy"
  )
    throw new TypeError("PDF visual input identity is invalid");
  safeString(manifest.engineImageDigest, /^sha256:[a-f0-9]{64}$/u, "visual engine digest");
  assertSha256(manifest.corpusManifestSha256, "visual corpus SHA-256");
  const source = validateVisualArtifact(manifest.source, "PDF visual source", /^source\.pdf$/u, [
    "pageCount",
  ]);
  integer(source.pageCount, 1, 100, "PDF visual page count");
  if (!Array.isArray(manifest.results) || manifest.results.length !== REPEATS)
    throw new TypeError("PDF visual results are incomplete");
  for (const [index, rawResult] of manifest.results.entries()) {
    const result = assertObject(rawResult, "PDF visual result");
    assertExactKeys(
      result,
      ["repeat", "artifact", "sha256", "byteLength", "profile", "semantic", "visual"],
      "PDF visual result",
    );
    if (
      result.repeat !== index ||
      result.artifact !== `result-${index}.pdf` ||
      result.profile !== "image-optimized" ||
      result.semantic !== "passed" ||
      result.visual !== "passed"
    )
      throw new TypeError("PDF visual result is invalid");
    safeString(result.artifact, /^result-[012]\.pdf$/u, "PDF visual result artifact");
    assertSha256(result.sha256, "PDF visual result SHA-256");
    integer(result.byteLength, 1, MAX_OUTPUT_BYTES, "PDF visual result byte length");
    if (result.byteLength > source.byteLength - Math.max(1, Math.ceil(source.byteLength / 100)))
      throw new TypeError("PDF visual result is not smaller than its source");
  }
  return manifest;
}

export async function validatePdfVisualInputSchema(manifest, schema) {
  assertClosedSchema(schema);
  if (schema?.properties?.schema?.const !== VISUAL_INPUT_SCHEMA)
    throw new TypeError("PDF visual input schema vocabulary is invalid");
  validateJsonSchema(manifest, schema, schema);
  validatePdfVisualInputManifest(manifest);
}

export async function writePdfVisualInputBundle({
  output,
  engineImageDigest,
  corpusManifestSha256,
  stratum,
  source,
  pageCount,
  results,
}) {
  if (!(source instanceof Uint8Array) || !hasPdfEnvelope(source))
    throw new TypeError("PDF visual source is invalid");
  if (!Array.isArray(results) || results.length !== REPEATS)
    throw new TypeError("PDF visual results are incomplete");
  for (const [repeat, result] of results.entries()) {
    if (
      result.repeat !== repeat ||
      result.verdict !== "reduced" ||
      result.profile !== "image-optimized" ||
      result.semantic !== "passed" ||
      result.visual !== "passed" ||
      !(result.output instanceof Uint8Array) ||
      !hasPdfEnvelope(result.output)
    )
      throw new TypeError("PDF visual result is not verified image-optimized output");
  }
  const manifest = validatePdfVisualInputManifest({
    schema: VISUAL_INPUT_SCHEMA,
    version: 1,
    engineImageDigest,
    corpusManifestSha256,
    stratum,
    source: {
      artifact: "source.pdf",
      sha256: createHash("sha256").update(source).digest("hex"),
      byteLength: source.byteLength,
      pageCount,
    },
    results: results.map((result) => ({
      repeat: result.repeat,
      artifact: `result-${result.repeat}.pdf`,
      sha256: createHash("sha256").update(result.output).digest("hex"),
      byteLength: result.output.byteLength,
      profile: result.profile,
      semantic: result.semantic,
      visual: result.visual,
    })),
  });
  const root = resolve(output);
  let created = false;
  try {
    await mkdir(root, { mode: 0o700 });
    created = true;
    await writeFile(join(root, manifest.source.artifact), source, { flag: "wx", mode: 0o600 });
    await Promise.all(
      manifest.results.map((result, index) =>
        writeFile(join(root, result.artifact), results[index].output, {
          flag: "wx",
          mode: 0o600,
        }),
      ),
    );
    await writeFile(join(root, "manifest.json"), canonicalJson(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    return manifest;
  } catch (error) {
    if (created) await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function resolveSchemaReference(root, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/") || reference.includes("~"))
    throw new TypeError("unsupported JSON Schema reference");
  return reference
    .slice(2)
    .split("/")
    .reduce((value, key) => value?.[key], root);
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function validateJsonSchema(value, schema, root, path = "$") {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new TypeError(`${path} schema is invalid`);
  if (schema.$ref !== undefined)
    return validateJsonSchema(value, resolveSchemaReference(root, schema.$ref), root, path);
  if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const))
    throw new TypeError(`${path} violates const`);
  if (
    schema.enum !== undefined &&
    !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))
  )
    throw new TypeError(`${path} violates enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type)))
      throw new TypeError(`${path} violates type`);
  }
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      throw new TypeError(`${path} violates pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new TypeError(`${path} violates minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new TypeError(`${path} violates maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw new TypeError(`${path} violates minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new TypeError(`${path} violates maxItems`);
    if (schema.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length)
      throw new TypeError(`${path} violates uniqueItems`);
    if (schema.items !== undefined)
      value.forEach((item, index) => {
        validateJsonSchema(item, schema.items, root, `${path}[${index}]`);
      });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key)) throw new TypeError(`${path} misses required property`);
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!Object.hasOwn(properties, key)) throw new TypeError(`${path} has additional property`);
    for (const [key, child] of Object.entries(properties))
      if (Object.hasOwn(value, key)) validateJsonSchema(value[key], child, root, `${path}.${key}`);
  }
}

export function assertClosedSchema(schema, path = "$") {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw new TypeError(`${path} schema must be closed`);
    const properties = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    if (canonicalJson(properties) !== canonicalJson(required))
      throw new TypeError(`${path} schema required fields are incomplete`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || key === "$defs")
      for (const [child, nested] of Object.entries(value))
        assertClosedSchema(nested, `${path}.${child}`);
    else if (key === "items") assertClosedSchema(value, `${path}.items`);
  }
}

export async function validatePdfEvidenceSchemas({ report, gate, benchmarkSchema, gateSchema }) {
  assertClosedSchema(benchmarkSchema);
  assertClosedSchema(gateSchema);
  const benchmarkVocabulary = benchmarkSchema?.properties?.schema?.const;
  const gateVocabulary = gateSchema?.properties?.schema?.const;
  const sampleProperties = benchmarkSchema?.$defs?.sample?.properties;
  const stratumValues = benchmarkSchema?.$defs?.record?.properties?.stratum?.enum;
  const failurePattern = gateSchema?.properties?.failures?.items?.pattern;
  if (
    benchmarkVocabulary !== SCHEMA ||
    gateVocabulary !== GATE_SCHEMA ||
    !Array.isArray(stratumValues) ||
    canonicalJson(stratumValues) !== canonicalJson(REQUIRED_PDF_CORPUS_STRATA) ||
    !sampleProperties ||
    canonicalJson(sampleProperties.semantic.enum) !==
      canonicalJson(["passed", "failed", "not-applicable"]) ||
    canonicalJson(sampleProperties.visual.enum) !==
      canonicalJson(["passed", "failed", "not-applicable", "not-required"]) ||
    sampleProperties.repeat.minimum !== 0 ||
    sampleProperties.repeat.maximum !== REPEATS - 1 ||
    failurePattern !== "^[A-Za-z0-9:_-]{3,100}$"
  )
    throw new TypeError("PDF evidence schema vocabulary is inconsistent");
  validateJsonSchema(report, benchmarkSchema, benchmarkSchema);
  validateJsonSchema(gate, gateSchema, gateSchema);
  validatePdfBenchmarkReport(report);
  validatePdfReleaseGate(gate, report);
}

export function evaluatePdfEngineReleaseGate(rawReport) {
  const report = validatePdfBenchmarkReport(rawReport);
  const failures = gateFailures(report);
  return {
    schema: GATE_SCHEMA,
    benchmarkSha256: createHash("sha256").update(canonicalJson(report)).digest("hex"),
    engineImageDigest: report.identity.engineImageDigest,
    corpusManifestSha256: report.identity.corpusManifestSha256,
    visualProfilesMeasured: report.summary.visualProfilesMeasured,
    publicAdmissionReady: failures.length === 0 && report.summary.visualProfilesMeasured > 0,
    passed: failures.length === 0,
    failures,
  };
}

export function validatePdfReleaseGate(raw, report) {
  const gate = assertObject(raw, "PDF release gate");
  assertExactKeys(
    gate,
    [
      "schema",
      "benchmarkSha256",
      "engineImageDigest",
      "corpusManifestSha256",
      "visualProfilesMeasured",
      "publicAdmissionReady",
      "passed",
      "failures",
    ],
    "PDF release gate",
  );
  if (gate.schema !== GATE_SCHEMA) throw new TypeError("PDF release gate schema is invalid");
  assertSha256(gate.benchmarkSha256, "benchmark SHA-256");
  safeString(gate.engineImageDigest, /^sha256:[a-f0-9]{64}$/u, "release engine digest");
  assertSha256(gate.corpusManifestSha256, "release corpus SHA-256");
  integer(gate.visualProfilesMeasured, 0, MAX_SAMPLES, "release visual coverage");
  if (
    typeof gate.publicAdmissionReady !== "boolean" ||
    gate.publicAdmissionReady !== (gate.passed && gate.visualProfilesMeasured > 0)
  )
    throw new TypeError("PDF release admission readiness is invalid");
  if (typeof gate.passed !== "boolean" || !Array.isArray(gate.failures))
    throw new TypeError("PDF release result is invalid");
  for (const failure of gate.failures)
    safeString(failure, /^[A-Za-z0-9:_-]{3,100}$/u, "PDF release failure");
  if (
    new Set(gate.failures).size !== gate.failures.length ||
    gate.passed !== (gate.failures.length === 0)
  )
    throw new TypeError("PDF release failure set is inconsistent");
  if (report !== undefined) {
    const expected = evaluatePdfEngineReleaseGate(report);
    if (canonicalJson(gate) !== canonicalJson(expected))
      throw new TypeError("PDF release gate image or benchmark binding is inconsistent");
  }
  return gate;
}

async function docker(args, options = {}) {
  const result = await execute("docker", args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
  });
  return result.stdout.trim();
}

async function localStructural(bytes, stratum, safety) {
  const started = performance.now();
  let peakMemoryBytes = process.memoryUsage().rss;
  try {
    const admission = await probePdfCorpusFeature(bytes, stratum, safety);
    if (stratum === "decompression-bomb" && admission.inflatedBytes > safety.maximumInflatedBytes)
      return {
        verdict: "rejected",
        output: null,
        duration: performance.now() - started,
        pageCount: null,
        code: "INFLATED_LIMIT_EXCEEDED",
        profile: null,
        measurements: {
          peakMemoryBytes: Math.max(peakMemoryBytes, process.memoryUsage().rss),
          testedCandidates: 0,
        },
      };
    const document = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (document.isEncrypted || document.getPageCount() < 1 || document.getPageCount() > 100)
      return {
        verdict: "rejected",
        output: null,
        duration: performance.now() - started,
        pageCount: null,
        code: "UNSUPPORTED_INPUT",
        profile: null,
        measurements: { peakMemoryBytes, testedCandidates: 0 },
      };
    const output = Buffer.from(
      await document.save({
        useObjectStreams: true,
        addDefaultPage: false,
        objectsPerTick: 50,
        updateFieldAppearances: false,
      }),
    );
    return {
      verdict:
        output.byteLength <= bytes.byteLength - Math.max(1, Math.ceil(bytes.byteLength / 100))
          ? "reduced"
          : "original-retained",
      output:
        output.byteLength <= bytes.byteLength - Math.max(1, Math.ceil(bytes.byteLength / 100))
          ? output
          : bytes,
      duration: performance.now() - started,
      pageCount: document.getPageCount(),
      code: null,
      profile: "structural",
      measurements: {
        peakMemoryBytes: Math.max(peakMemoryBytes, process.memoryUsage().rss),
        testedCandidates: 1,
      },
    };
  } catch {
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    return {
      verdict: "rejected",
      output: null,
      duration: performance.now() - started,
      pageCount: null,
      code: "UNSUPPORTED_INPUT",
      profile: null,
      measurements: { peakMemoryBytes, testedCandidates: 0 },
    };
  }
}

async function poll(origin, jobId, deadline) {
  while (Date.now() < deadline) {
    const response = await fetchBeforeDeadline(`${origin}/v1/jobs/${jobId}`, {}, deadline);
    if (!response.ok) throw new Error("native status request failed");
    const status = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(status.state)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("native PDF benchmark timed out");
}

async function nativeRun(origin, bytes, pageCount, deadline) {
  const jobId = randomUUID();
  const body = {
    protocol: 1,
    jobId,
    attempt: 1,
    tool: "pdf.optimize",
    toolVersion: 1,
    spec: { version: 1, preset: "balanced" },
    specHash: createHash("sha256").update("pdf-benchmark-balanced-v1").digest("hex"),
    input: {
      byteLength: bytes.byteLength,
      etag: `corpus-${createHash("sha256").update(bytes).digest("hex")}`,
      mimeHint: "application/pdf",
      pageCount: pageCount ?? 1,
    },
    resourceClass: "pdf-standard-v1",
  };
  const started = performance.now();
  const created = await fetchBeforeDeadline(
    `${origin}/v1/jobs`,
    { method: "POST", body: JSON.stringify(body) },
    deadline,
  );
  if (created.status !== 201) throw new Error("native job create failed");
  try {
    const uploaded = await fetchBeforeDeadline(
      `${origin}/v1/jobs/${jobId}/input`,
      {
        method: "PUT",
        headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
        body: bytes,
      },
      deadline,
    );
    if (uploaded.status !== 204) throw new Error("native PDF upload failed");
    const run = await fetchBeforeDeadline(
      `${origin}/v1/jobs/${jobId}/run`,
      { method: "POST" },
      deadline,
    );
    if (run.status !== 202) throw new Error("native PDF run failed");
    const status = await poll(origin, jobId, deadline);
    let output = null;
    let verdict = "rejected";
    if (status.state === "succeeded") {
      verdict = status.result.kind === "download" ? "reduced" : "original-retained";
      if (verdict === "reduced") {
        const response = await fetchBeforeDeadline(
          `${origin}/v1/jobs/${jobId}/output`,
          {},
          deadline,
        );
        if (!response.ok) throw new Error("native PDF output failed");
        output = await readBoundedPdfResponse(response);
      }
    }
    return {
      verdict,
      output,
      profile: status.result?.profile ?? null,
      code: status.error?.code ?? null,
      duration: performance.now() - started,
      measurements: status.measurements ?? { peakMemoryBytes: 0, testedCandidates: 0 },
    };
  } finally {
    await fetchBeforeDeadline(`${origin}/v1/jobs/${jobId}`, { method: "DELETE" }, deadline).catch(
      () => undefined,
    );
  }
}

async function semanticVerdict(source, output, pageCount) {
  if (output === null) return "not-applicable";
  if (
    output.byteLength < 10 ||
    output.subarray(0, 5).toString("ascii") !== "%PDF-" ||
    !output.subarray(-1024).includes(Buffer.from("%%EOF"))
  )
    return "failed";
  try {
    const document = await PDFDocument.load(output, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    return document.getPageCount() === pageCount && output.byteLength < source.byteLength
      ? "passed"
      : "failed";
  } catch {
    return "failed";
  }
}

async function featureSemanticVerdict(source, output, stratum, safety, profile) {
  if (output === null) return "not-applicable";
  try {
    const [before, after] = await Promise.all([
      probePdfCorpusFeature(source, stratum, safety),
      probePdfCorpusFeature(
        output,
        stratum,
        stratum === "duplicate-resource" ? { ...safety, allowDeduplicated: true } : safety,
      ),
    ]);
    if (profile === "image-optimized" || stratum === "duplicate-resource") {
      const omitted =
        stratum === "duplicate-resource" ? ["duplicateStreams"] : ["imageEncoding", "imageCount"];
      const omitImages = (value) =>
        Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)));
      return canonicalJson(omitImages(before)) === canonicalJson(omitImages(after))
        ? "passed"
        : "failed";
    }
    return canonicalJson(before) === canonicalJson(after) ? "passed" : "failed";
  } catch {
    return "failed";
  }
}

let pdfjsPromise;
async function pdfjs() {
  pdfjsPromise ??= import(
    pathToFileURL(
      resolve("node_modules/.pnpm/pdfjs-dist@6.2.108/node_modules/pdfjs-dist/legacy/build/pdf.mjs"),
    ).href
  );
  return pdfjsPromise;
}

async function renderSample(bytes, pageNumber) {
  const module = await pdfjs();
  const task = module.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    stopEvent: true,
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 96 / 72 });
    if (viewport.width * viewport.height > MAX_PARSER_PIXELS)
      throw new RangeError("visual pixel limit exceeded");
    const factory = document.canvasFactory;
    if (factory === undefined) throw new Error("PDF canvas adapter unavailable");
    const canvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.context, canvas: canvas.canvas, viewport }).promise;
    const pixels = canvas.context.getImageData(
      0,
      0,
      canvas.canvas.width,
      canvas.canvas.height,
    ).data;
    factory.destroy(canvas);
    return pixels;
  } finally {
    await task.destroy();
  }
}

async function visualVerdict(source, output, pageCount, profile) {
  if (output === null) return "not-applicable";
  if (profile !== "image-optimized") return "not-required";
  try {
    const pages = [...new Set([1, Math.max(1, pageCount)])].slice(0, 5);
    for (const page of pages) {
      const [before, after] = await Promise.all([
        renderSample(source, page),
        renderSample(output, page),
      ]);
      if (before.length !== after.length) return "failed";
      let total = 0;
      for (let index = 0; index < before.length; index += 1)
        total += Math.abs(before[index] - after[index]);
      if (total / (before.length * 255) > 0.08) return "failed";
    }
    return "passed";
  } catch {
    return "failed";
  }
}

function runnerRecord(runs, sourceBytes) {
  const samples = runs.map((run, repeat) => ({
    repeat,
    verdict: run.verdict,
    effectiveBytes:
      run.output?.byteLength ?? (run.verdict === "original-retained" ? sourceBytes : null),
    durationMs: Math.round(run.duration * 1000) / 1000,
    peakRssBytes: run.measurements?.peakMemoryBytes ?? 0,
    candidateCount: run.measurements?.testedCandidates ?? (run.verdict === "rejected" ? 0 : 1),
    code: run.code ?? (run.verdict === "rejected" ? "UNSUPPORTED_INPUT" : null),
    profile: run.profile ?? null,
    semantic: run.semantic,
    visual: run.visual,
  }));
  const effective = samples
    .map((sample) => sample.effectiveBytes)
    .filter((value) => value !== null);
  return {
    samples,
    medianEffectiveBytes: effective.length === REPEATS ? median(effective) : null,
    medianDurationMs: median(samples.map((sample) => sample.durationMs)),
    maximumPeakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
    maximumCandidateCount: Math.max(...samples.map((sample) => sample.candidateCount)),
  };
}

export async function benchmarkPdfEngine({ engineImage, corpusPath, outputPath, visualOutput }) {
  const manifest = validatePdfCorpusManifest(JSON.parse(await readFile(corpusPath, "utf8")));
  const corpusRoot = dirname(resolve(corpusPath));
  await verifyPdfCorpusFiles(manifest, corpusRoot);
  const corpusManifestSha256 = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  const imageId = await docker(["image", "inspect", engineImage, "--format", "{{.Id}}"]);
  safeString(imageId, /^sha256:[a-f0-9]{64}$/u, "engine image ID");
  const sourceLockSha256 = createHash("sha256")
    .update(await readFile("apps/pdf-engine/native/sources.lock.json"))
    .digest("hex");
  const containerName = `hereisit-pdf-benchmark-${randomUUID()}`;
  const networkName = `hereisit-pdf-benchmark-${randomUUID()}`;
  const startedAt = Date.now();
  try {
    await docker([
      "network",
      "create",
      "--internal",
      "--label",
      "hereisit.pdf-benchmark=true",
      networkName,
    ]);
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      "hereisit.pdf-benchmark=true",
      "--network",
      networkName,
      "--read-only",
      "--tmpfs",
      "/tmp/hereisit-pdf-engine:rw,noexec,nosuid,nodev,size=268435456,uid=10001,gid=10001,mode=0700",
      "--memory",
      "768m",
      "--cpus",
      "2",
      "--pids-limit",
      "128",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      engineImage,
    ]);
    const address = await docker([
      "inspect",
      containerName,
      "--format",
      "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    ]);
    if (isIP(address) !== 4 || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(address))
      throw new Error("native PDF benchmark container address is invalid");
    const origin = `http://${address}:8080`;
    const benchmarkDeadline = startedAt + MAX_WALL_MS;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        if ((await fetchBeforeDeadline(`${origin}/healthz`, {}, benchmarkDeadline)).status === 204)
          break;
      } catch {}
      if (attempt === 299) throw new Error("native PDF engine did not become healthy");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const build = await (
      await fetchBeforeDeadline(`${origin}/v1/build`, {}, benchmarkDeadline)
    ).json();
    if (build.qpdf !== "12.4.0") throw new Error("native PDF qpdf version mismatch");
    const records = [];
    let measuredSamples = 0;
    let visualInput;
    for (const entry of manifest.entries) {
      if (Date.now() - startedAt > MAX_WALL_MS)
        throw new Error("PDF benchmark wall limit exceeded");
      const bytes = await readFile(join(corpusRoot, entry.artifact));
      const localRuns = [];
      const nativeRuns = [];
      const pairs = await runBenchmarkRepeats({
        deadline: benchmarkDeadline,
        operation: async () => {
          const local = await localStructural(bytes, entry.stratum, entry.safety);
          local.semantic =
            local.verdict === "rejected"
              ? "not-applicable"
              : local.verdict === "reduced"
                ? (await semanticVerdict(bytes, local.output, entry.pageCount)) === "passed"
                  ? await featureSemanticVerdict(
                      bytes,
                      local.output,
                      entry.stratum,
                      entry.safety,
                      local.profile,
                    )
                  : "failed"
                : "passed";
          local.visual = await visualVerdict(
            bytes,
            local.output,
            entry.pageCount ?? 1,
            local.profile,
          );
          const native = await nativeRun(origin, bytes, entry.pageCount, benchmarkDeadline);
          native.semantic =
            native.verdict === "rejected"
              ? "not-applicable"
              : native.verdict === "reduced"
                ? (await semanticVerdict(bytes, native.output, entry.pageCount)) === "passed"
                  ? await featureSemanticVerdict(
                      bytes,
                      native.output,
                      entry.stratum,
                      entry.safety,
                      native.profile,
                    )
                  : "failed"
                : "passed";
          native.visual = await visualVerdict(
            bytes,
            native.output,
            entry.pageCount ?? 1,
            native.profile,
          );
          measuredSamples += 1;
          return { local, native };
        },
      });
      localRuns.push(...pairs.map((pair) => pair.local));
      nativeRuns.push(...pairs.map((pair) => pair.native));
      if (
        entry.stratum === "jpeg-heavy" &&
        nativeRuns.every(
          (run) =>
            run.verdict === "reduced" &&
            run.profile === "image-optimized" &&
            run.semantic === "passed" &&
            run.visual === "passed" &&
            run.output instanceof Uint8Array,
        )
      ) {
        visualInput = {
          source: bytes,
          pageCount: entry.pageCount,
          results: nativeRuns.map((run, repeat) => ({ ...run, repeat })),
        };
      }
      const local = runnerRecord(localRuns, bytes.byteLength);
      const native = runnerRecord(nativeRuns, bytes.byteLength);
      const smallerOnly = [...local.samples, ...native.samples].every(
        (sample) => sample.effectiveBytes === null || sample.effectiveBytes <= bytes.byteLength,
      );
      const repeatableNativeWins = native.samples.filter(
        (sample, index) =>
          sample.effectiveBytes !== null &&
          local.samples[index].effectiveBytes !== null &&
          local.samples[index].effectiveBytes - sample.effectiveBytes >=
            Math.max(1, Math.ceil(bytes.byteLength / 100)),
      ).length;
      const nativeAdvantageRatio =
        local.medianEffectiveBytes === null || native.medianEffectiveBytes === null
          ? 0
          : (local.medianEffectiveBytes - native.medianEffectiveBytes) / bytes.byteLength;
      records.push({
        stratum: entry.stratum,
        sourceBytes: bytes.byteLength,
        local,
        native,
        smallerOnly,
        repeatableNativeWins,
        nativeAdvantageRatio,
      });
    }
    const draft = {
      schema: SCHEMA,
      identity: {
        engineImageId: imageId,
        engineImageDigest: imageId,
        qpdfVersion: build.qpdf,
        corpusManifestSha256,
        sourceLockSha256,
        localRunner: `pdf-lib-structural@${pdfLibVersion}`,
      },
      limits: {
        repeats: REPEATS,
        maximumSamples: MAX_SAMPLES,
        maximumWallMs: MAX_WALL_MS,
        maximumSourceBytes: MAX_SOURCE_BYTES,
        maximumOutputBytes: MAX_OUTPUT_BYTES,
        maximumPeakRssBytes: MAX_RSS_BYTES,
        maximumParserPixels: MAX_PARSER_PIXELS,
        maximumDiagnosticBytes: MAX_DIAGNOSTIC_BYTES,
      },
      records,
      summary: {
        strata: records.length,
        measuredSamples,
        nativeWins: records.filter(
          (record) =>
            STRUCTURED.has(record.stratum) &&
            record.repeatableNativeWins >= 2 &&
            record.nativeAdvantageRatio >= 0.01,
        ).length,
        rejectedSafely: records.filter(
          (record) =>
            HOSTILE.has(record.stratum) &&
            [...record.local.samples, ...record.native.samples].every(
              (sample) => sample.verdict === "rejected",
            ),
        ).length,
        maximumPeakRssBytes: Math.max(
          ...records.flatMap((record) =>
            [...record.local.samples, ...record.native.samples].map(
              (sample) => sample.peakRssBytes,
            ),
          ),
        ),
        visualProfilesMeasured: records
          .flatMap((record) => record.native.samples)
          .filter((sample) => sample.profile === "image-optimized" && sample.visual === "passed")
          .length,
        passed: false,
      },
    };
    draft.summary.passed = gateFailures(draft).length === 0;
    const report = validatePdfBenchmarkReport(draft);
    await writeFile(outputPath, canonicalJson(report), { mode: 0o600 });
    const gate = validatePdfReleaseGate(evaluatePdfEngineReleaseGate(report));
    await writeFile(outputPath.replace(/\.json$/u, "-gate.json"), canonicalJson(gate), {
      mode: 0o600,
    });
    if (!gate.passed) throw new Error(`PDF quality gate failed: ${gate.failures.join(",")}`);
    if (visualOutput !== undefined) {
      if (visualInput === undefined)
        throw new Error("PDF benchmark did not produce three verified image-optimized results");
      await writePdfVisualInputBundle({
        output: visualOutput,
        engineImageDigest: imageId,
        corpusManifestSha256,
        stratum: "jpeg-heavy",
        ...visualInput,
      });
    }
    return { report, gate };
  } finally {
    await execute("docker", ["rm", "--force", containerName], {
      timeout: 15_000,
      maxBuffer: MAX_DIAGNOSTIC_BYTES,
    }).catch(() => undefined);
    await execute("docker", ["network", "rm", networkName], {
      timeout: 15_000,
      maxBuffer: MAX_DIAGNOSTIC_BYTES,
    }).catch(() => undefined);
  }
}

function help() {
  return "Usage: node scripts/benchmark-pdf-engine.mjs --engine-image <local-image> --corpus <manifest.json> --output <report.json> [--visual-output <private-directory>]\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) process.stdout.write(help());
  else {
    const args = parseCliArguments(process.argv.slice(2));
    assertExactKeys(
      args,
      ["engine-image", "corpus", "output", ...(args["visual-output"] ? ["visual-output"] : [])],
      "PDF benchmark CLI arguments",
    );
    await mkdir(dirname(resolve(args.output)), { recursive: true, mode: 0o700 });
    const { gate } = await benchmarkPdfEngine({
      engineImage: args["engine-image"],
      corpusPath: args.corpus,
      outputPath: args.output,
      visualOutput: args["visual-output"],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, passed: gate.passed })}\n`);
  }
}
