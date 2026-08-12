import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
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
const SCHEMA = "hereisit.pdf-engine-benchmark@1";
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
const VERIFICATIONS = new Set(["passed", "failed", "not-applicable", "not-required"]);

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

function validateRunner(raw, label) {
  const runner = assertObject(raw, label);
  assertExactKeys(
    runner,
    [
      "verdict",
      "outputBytes",
      "ratio",
      "coldMs",
      "warmMedianMs",
      "peakRssBytes",
      "candidateCount",
      "semantic",
      "visual",
    ],
    label,
  );
  if (!VERDICTS.has(runner.verdict)) throw new TypeError(`${label} verdict is invalid`);
  if (runner.outputBytes !== null)
    integer(runner.outputBytes, 1, MAX_OUTPUT_BYTES, `${label} output`);
  if (runner.ratio !== null) finite(runner.ratio, 0, 2, `${label} ratio`);
  finite(runner.coldMs, 0, MAX_WALL_MS, `${label} cold duration`);
  finite(runner.warmMedianMs, 0, MAX_WALL_MS, `${label} warm duration`);
  integer(runner.peakRssBytes, 0, Number.MAX_SAFE_INTEGER, `${label} peak RSS`);
  integer(runner.candidateCount, 0, 2, `${label} candidate count`);
  if (!VERIFICATIONS.has(runner.semantic) || !VERIFICATIONS.has(runner.visual))
    throw new TypeError(`${label} verification is invalid`);
  if (
    (runner.verdict === "rejected" && (runner.outputBytes !== null || runner.ratio !== null)) ||
    (runner.verdict !== "rejected" && (runner.outputBytes === null || runner.ratio === null))
  )
    throw new TypeError(`${label} output fields do not match verdict`);
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
      ["stratum", "sourceBytes", "local", "native", "smallerOnly", "nativeAdvantageRatio"],
      "PDF benchmark record",
    );
    if (!REQUIRED_PDF_CORPUS_STRATA.includes(record.stratum) || seen.has(record.stratum))
      throw new TypeError("PDF benchmark stratum is invalid or duplicated");
    seen.add(record.stratum);
    integer(record.sourceBytes, 1, MAX_SOURCE_BYTES, "PDF benchmark source bytes");
    const local = validateRunner(record.local, "local PDF runner");
    const native = validateRunner(record.native, "native PDF runner");
    if (typeof record.smallerOnly !== "boolean")
      throw new TypeError("smaller-only verdict is invalid");
    finite(record.nativeAdvantageRatio, -1, 1, "native advantage ratio");
    for (const runner of [local, native]) {
      if (
        runner.outputBytes !== null &&
        Math.abs(runner.ratio - runner.outputBytes / record.sourceBytes) > 1e-9
      )
        throw new TypeError("PDF benchmark ratio is inconsistent");
    }
  }
  if (REQUIRED_PDF_CORPUS_STRATA.some((stratum) => !seen.has(stratum)))
    throw new TypeError("PDF benchmark stratum is missing");
  const summary = assertObject(report.summary, "PDF benchmark summary");
  assertExactKeys(
    summary,
    ["strata", "measuredSamples", "nativeWins", "rejectedSafely", "passed"],
    "PDF benchmark summary",
  );
  integer(summary.strata, 1, REQUIRED_PDF_CORPUS_STRATA.length, "summary strata");
  integer(summary.measuredSamples, 0, MAX_SAMPLES, "summary samples");
  integer(summary.nativeWins, 0, REQUIRED_PDF_CORPUS_STRATA.length, "summary native wins");
  integer(summary.rejectedSafely, 0, HOSTILE.size, "summary safe rejections");
  if (typeof summary.passed !== "boolean") throw new TypeError("summary pass is invalid");
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
      if (runner.outputBytes !== null && runner.outputBytes > record.sourceBytes)
        failures.push(`${record.stratum}:${runnerName}:EXPANSION`);
      if (runner.peakRssBytes > report.limits.maximumPeakRssBytes)
        failures.push(`${record.stratum}:${runnerName}:RSS_LIMIT`);
      if (runner.verdict !== "rejected" && runner.peakRssBytes === 0)
        failures.push(`${record.stratum}:${runnerName}:RSS_NOT_MEASURED`);
      if (runner.semantic === "failed") failures.push(`${record.stratum}:${runnerName}:SEMANTIC`);
      if (runner.visual === "failed") failures.push(`${record.stratum}:${runnerName}:VISUAL`);
    }
    if (
      HOSTILE.has(record.stratum) &&
      (record.local.verdict !== "rejected" || record.native.verdict !== "rejected")
    )
      failures.push(`${record.stratum}:UNSAFE_ACCEPTANCE`);
  }
  if (
    !report.records.some(
      (record) => STRUCTURED.has(record.stratum) && record.nativeAdvantageRatio >= 0.01,
    )
  )
    failures.push("NO_REPEATABLE_STRUCTURED_NATIVE_ADVANTAGE");
  return [...new Set(failures)].sort();
}

export function evaluatePdfEngineReleaseGate(rawReport) {
  const report = validatePdfBenchmarkReport(rawReport);
  const failures = gateFailures(report);
  return {
    schema: GATE_SCHEMA,
    benchmarkSha256: createHash("sha256").update(canonicalJson(report)).digest("hex"),
    engineImageDigest: report.identity.engineImageDigest,
    corpusManifestSha256: report.identity.corpusManifestSha256,
    passed: failures.length === 0,
    failures,
  };
}

export function validatePdfReleaseGate(raw) {
  const gate = assertObject(raw, "PDF release gate");
  assertExactKeys(
    gate,
    [
      "schema",
      "benchmarkSha256",
      "engineImageDigest",
      "corpusManifestSha256",
      "passed",
      "failures",
    ],
    "PDF release gate",
  );
  if (gate.schema !== GATE_SCHEMA) throw new TypeError("PDF release gate schema is invalid");
  assertSha256(gate.benchmarkSha256, "benchmark SHA-256");
  safeString(gate.engineImageDigest, /^sha256:[a-f0-9]{64}$/u, "release engine digest");
  assertSha256(gate.corpusManifestSha256, "release corpus SHA-256");
  if (typeof gate.passed !== "boolean" || !Array.isArray(gate.failures))
    throw new TypeError("PDF release result is invalid");
  for (const failure of gate.failures)
    safeString(failure, /^[A-Za-z0-9:_-]{3,100}$/u, "PDF release failure");
  if (
    new Set(gate.failures).size !== gate.failures.length ||
    gate.passed !== (gate.failures.length === 0)
  )
    throw new TypeError("PDF release failure set is inconsistent");
  return gate;
}

async function docker(args, options = {}) {
  const result = await execute("docker", args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
  });
  return result.stdout.trim();
}

function median(values) {
  return values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];
}

async function localStructural(bytes) {
  const started = performance.now();
  let peakMemoryBytes = process.memoryUsage().rss;
  try {
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
      measurements: { peakMemoryBytes, testedCandidates: 0 },
    };
  }
}

async function poll(origin, jobId) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const response = await fetch(`${origin}/v1/jobs/${jobId}`);
    if (!response.ok) throw new Error("native status request failed");
    const status = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(status.state)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("native PDF benchmark timed out");
}

async function nativeRun(origin, bytes, pageCount, stratum) {
  if (stratum === "decompression-bomb")
    return {
      verdict: "rejected",
      output: null,
      duration: 0,
      measurements: { peakMemoryBytes: 0, testedCandidates: 0 },
    };
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
  const created = await fetch(`${origin}/v1/jobs`, { method: "POST", body: JSON.stringify(body) });
  if (created.status !== 201) throw new Error("native job create failed");
  try {
    const uploaded = await fetch(`${origin}/v1/jobs/${jobId}/input`, {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    if (uploaded.status !== 204) throw new Error("native PDF upload failed");
    const run = await fetch(`${origin}/v1/jobs/${jobId}/run`, { method: "POST" });
    if (run.status !== 202) throw new Error("native PDF run failed");
    const status = await poll(origin, jobId);
    let output = null;
    let verdict = "rejected";
    if (status.state === "succeeded") {
      verdict = status.result.kind === "download" ? "reduced" : "original-retained";
      if (verdict === "reduced") {
        const response = await fetch(`${origin}/v1/jobs/${jobId}/output`);
        if (!response.ok) throw new Error("native PDF output failed");
        output = Buffer.from(await response.arrayBuffer());
      }
    }
    return {
      verdict,
      output,
      profile: status.result?.profile ?? null,
      duration: performance.now() - started,
      measurements: status.measurements ?? { peakMemoryBytes: 0, testedCandidates: 0 },
    };
  } finally {
    await fetch(`${origin}/v1/jobs/${jobId}`, { method: "DELETE" }).catch(() => undefined);
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

function runnerRecord(runs, sourceBytes) {
  const cold = runs[0];
  const last = runs.at(-1);
  const outputBytes =
    last.output?.byteLength ?? (last.verdict === "original-retained" ? sourceBytes : null);
  return {
    verdict: last.verdict,
    outputBytes,
    ratio: outputBytes === null ? null : outputBytes / sourceBytes,
    coldMs: Math.round(cold.duration * 1000) / 1000,
    warmMedianMs: Math.round(median(runs.slice(1).map((run) => run.duration)) * 1000) / 1000,
    peakRssBytes: Math.max(...runs.map((run) => run.measurements?.peakMemoryBytes ?? 0)),
    candidateCount: Math.max(
      ...runs.map(
        (run) => run.measurements?.testedCandidates ?? (run.verdict === "rejected" ? 0 : 1),
      ),
    ),
    semantic: last.semantic,
    visual: last.visual,
  };
}

export async function benchmarkPdfEngine({ engineImage, corpusPath, outputPath }) {
  const manifest = validatePdfCorpusManifest(JSON.parse(await readFile(corpusPath, "utf8")));
  const corpusRoot = dirname(resolve(corpusPath));
  await verifyPdfCorpusFiles(manifest, corpusRoot);
  const imageId = await docker(["image", "inspect", engineImage, "--format", "{{.Id}}"]);
  safeString(imageId, /^sha256:[a-f0-9]{64}$/u, "engine image ID");
  const sourceLockSha256 = createHash("sha256")
    .update(await readFile("apps/pdf-engine/native/sources.lock.json"))
    .digest("hex");
  const containerName = `hereisit-pdf-benchmark-${randomUUID()}`;
  const networkName = `hereisit-pdf-benchmark-${randomUUID()}`;
  const startedAt = Date.now();
  try {
    await docker(["network", "create", "--internal", networkName]);
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
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
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        if ((await fetch(`${origin}/healthz`)).status === 204) break;
      } catch {}
      if (attempt === 299) throw new Error("native PDF engine did not become healthy");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const build = await (await fetch(`${origin}/v1/build`)).json();
    if (build.qpdf !== "12.4.0") throw new Error("native PDF qpdf version mismatch");
    const records = [];
    let measuredSamples = 0;
    for (const entry of manifest.entries) {
      if (Date.now() - startedAt > MAX_WALL_MS)
        throw new Error("PDF benchmark wall limit exceeded");
      const bytes = await readFile(join(corpusRoot, entry.artifact));
      const localRuns = [];
      const nativeRuns = [];
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        if (entry.stratum === "decompression-bomb") {
          localRuns.push({
            verdict: "rejected",
            output: null,
            duration: 0,
            pageCount: null,
            semantic: "not-applicable",
            visual: "not-required",
          });
          nativeRuns.push({
            verdict: "rejected",
            output: null,
            duration: 0,
            measurements: { peakMemoryBytes: 0, testedCandidates: 0 },
            semantic: "not-applicable",
            visual: "not-required",
          });
          continue;
        }
        const local = await localStructural(bytes);
        local.semantic =
          local.verdict === "reduced"
            ? await semanticVerdict(bytes, local.output, entry.pageCount)
            : "not-applicable";
        local.visual = "not-required";
        localRuns.push(local);
        const native = await nativeRun(origin, bytes, entry.pageCount, entry.stratum);
        native.semantic =
          native.verdict === "reduced"
            ? await semanticVerdict(bytes, native.output, entry.pageCount)
            : "not-applicable";
        native.visual = "not-required";
        nativeRuns.push(native);
        measuredSamples += 1;
      }
      const local = runnerRecord(localRuns, bytes.byteLength);
      const native = runnerRecord(nativeRuns, bytes.byteLength);
      const smallerOnly = [local, native].every(
        (runner) => runner.outputBytes === null || runner.outputBytes <= bytes.byteLength,
      );
      const nativeAdvantageRatio =
        local.outputBytes === null || native.outputBytes === null
          ? 0
          : (local.outputBytes - native.outputBytes) / bytes.byteLength;
      records.push({
        stratum: entry.stratum,
        sourceBytes: bytes.byteLength,
        local,
        native,
        smallerOnly,
        nativeAdvantageRatio,
      });
    }
    const draft = {
      schema: SCHEMA,
      identity: {
        engineImageId: imageId,
        engineImageDigest: imageId,
        qpdfVersion: build.qpdf,
        corpusManifestSha256: createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
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
          (record) => STRUCTURED.has(record.stratum) && record.nativeAdvantageRatio >= 0.01,
        ).length,
        rejectedSafely: records.filter(
          (record) =>
            HOSTILE.has(record.stratum) &&
            record.local.verdict === "rejected" &&
            record.native.verdict === "rejected",
        ).length,
        passed: false,
      },
    };
    draft.summary.passed = gateFailures(validatePdfBenchmarkReport(draft)).length === 0;
    const report = validatePdfBenchmarkReport(draft);
    await writeFile(outputPath, canonicalJson(report), { mode: 0o600 });
    const gate = validatePdfReleaseGate(evaluatePdfEngineReleaseGate(report));
    await writeFile(outputPath.replace(/\.json$/u, "-gate.json"), canonicalJson(gate), {
      mode: 0o600,
    });
    if (!gate.passed) throw new Error(`PDF quality gate failed: ${gate.failures.join(",")}`);
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
  return "Usage: node scripts/benchmark-pdf-engine.mjs --engine-image <local-image> --corpus <manifest.json> --output <report.json>\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) process.stdout.write(help());
  else {
    const args = parseCliArguments(process.argv.slice(2));
    assertExactKeys(args, ["engine-image", "corpus", "output"], "PDF benchmark CLI arguments");
    await mkdir(dirname(resolve(args.output)), { recursive: true, mode: 0o700 });
    const { gate } = await benchmarkPdfEngine({
      engineImage: args["engine-image"],
      corpusPath: args.corpus,
      outputPath: args.output,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, passed: gate.passed })}\n`);
  }
}
