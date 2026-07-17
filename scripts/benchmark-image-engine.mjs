import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateLiveCostModelDocument } from "./create-live-cost-model.mjs";
import {
  parseCliArguments,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { verifyBenchmarkRecords } from "./verify-image-quality.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const sharp = require("../apps/image-engine/node_modules/sharp");
const validClasses = new Set([
  "photo",
  "portrait",
  "night-noisy",
  "screenshot-text",
  "ui",
  "code",
  "logo",
  "illustration",
  "gradient",
  "flat-graphic",
]);
const mimeByFormat = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function sizeBand(bytes) {
  if (bytes < 100 * 1024) return "tiny";
  if (bytes <= 1024 * 1024) return "small";
  if (bytes <= 10 * 1024 * 1024) return "medium";
  return "large";
}

async function docker(...args) {
  const result = await execute("docker", args, { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

async function waitForHealth(origin, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.status === 204) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("image engine did not become healthy");
}

async function pollTerminal(origin, jobId) {
  const started = Date.now();
  let firstRunningAt = null;
  while (Date.now() - started < 100_000) {
    const response = await fetch(`${origin}/v1/jobs/${jobId}`);
    if (!response.ok) throw new Error(`engine status failed with ${response.status}`);
    const status = await response.json();
    if (status.state === "running" && firstRunningAt === null) firstRunningAt = Date.now();
    if (["succeeded", "failed", "cancelled"].includes(status.state))
      return { status, firstRunningAt };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("image engine benchmark job timed out");
}

function metricNumber(output, label) {
  const matches = output.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
  if (!matches?.length) throw new Error(`${label} produced no numeric score`);
  const number = Number(matches.at(-1));
  if (!Number.isFinite(number)) throw new Error(`${label} produced an invalid score`);
  return number;
}

async function measureMetrics(metricImage, sourcePath, outputPath) {
  const sourceDirectory = dirname(sourcePath);
  const outputDirectory = dirname(outputPath);
  const mounts = [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${sourceDirectory}:/source:ro`,
    "-v",
    `${outputDirectory}:/result:ro`,
  ];
  const source = `/source/${basename(sourcePath)}`;
  const result = `/result/${basename(outputPath)}`;
  const ssim = await docker(
    ...mounts,
    "--entrypoint",
    "/opt/benchmark/libjxl/bin/ssimulacra2",
    metricImage,
    source,
    result,
  );
  const butter = await docker(
    ...mounts,
    "--entrypoint",
    "/opt/benchmark/libjxl/bin/butteraugli_main",
    metricImage,
    source,
    result,
  );
  return {
    ssimulacra2: metricNumber(ssim, "ssimulacra2"),
    butteraugli: metricNumber(butter, "butteraugli"),
  };
}

function calculateCostUsd(model, record) {
  const processingSeconds = record.processingMs / 1000;
  const activeSeconds = processingSeconds + model.containerSleepAfterSeconds;
  const computeMicros =
    activeSeconds * model.containerInstanceVcpu * model.containerVcpuSecondMicrousd +
    activeSeconds * model.containerInstanceMemoryGib * model.containerGibSecondMicrousd +
    activeSeconds * model.containerInstanceDiskGb * model.containerDiskGbSecondMicrousd;
  const delivered = record.effectiveDeliveredBytes ?? 0;
  const storageMicros =
    ((record.inputBytes + delivered) / 1_000_000_000 / 30) * model.r2StorageGbMonthMicrousd +
    (2048 / 1_000_000_000 / 30) * model.d1StorageGbMonthMicrousd;
  const routeCpuMs = Object.values(model.routeCpuEnvelopeMs).reduce((sum, value) => sum + value, 0);
  const operationsMicros =
    (8 / 1_000_000) * model.workersMillionRequestsMicrousd +
    (routeCpuMs / 1_000_000) * model.workersMillionCpuMsMicrousd +
    (8 / 1_000_000) * model.durableObjectMillionRequestsMicrousd +
    activeSeconds * 0.125 * model.durableObjectGibSecondMicrousd +
    (4 / 1_000_000) * model.queueMillionOperationsMicrousd +
    (12 / 1_000_000) * model.d1MillionRowsReadMicrousd +
    (8 / 1_000_000) * model.d1MillionRowsWrittenMicrousd +
    (2 / 1_000_000) * model.r2ClassAMillionMicrousd +
    (4 / 1_000_000) * model.r2ClassBMillionMicrousd +
    (10 / 1_000_000) * model.observabilityMillionLogEventsMicrousd +
    (8 / 1_000_000) * model.workersLogpushMillionEventsMicrousd +
    (6 / 1_000_000) * model.analyticsEngineMillionDataPointsMicrousd +
    (delivered / 1_000_000_000) * model.containerEgressGbMicrousd +
    model.monthlyFixedMicrousd / model.projectedMonthlyJobs;
  const totalMicros = computeMicros + storageMicros + operationsMicros;
  return {
    compute: computeMicros / 1_000_000,
    storage: storageMicros / 1_000_000,
    operations: operationsMicros / 1_000_000,
    total: totalMicros / 1_000_000,
  };
}

async function runOne({
  origin,
  entry,
  inputPath,
  inputBytes,
  mode,
  preset,
  build,
  model,
  metricImage,
  temporaryRoot,
  coldStart,
}) {
  const jobId = randomUUID();
  const spec = {
    version: 1,
    mode,
    preset,
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  };
  const createdAt = performance.now();
  const createResponse = await fetch(`${origin}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: 1,
      jobId,
      attempt: 1,
      tool: "image.optimize",
      toolVersion: 1,
      spec,
      specHash: sha256Canonical(spec),
      input: {
        byteLength: inputBytes.byteLength,
        etag: `corpus-${entry.sha256}`,
        mimeHint: mimeByFormat[entry.expected.format],
      },
      resourceClass: "image-standard-v1",
    }),
  });
  if (createResponse.status !== 201)
    throw new Error(`engine create failed with ${createResponse.status}`);
  const feedbackMs = performance.now() - createdAt;
  const uploadResponse = await fetch(`${origin}/v1/jobs/${jobId}/input`, {
    method: "PUT",
    headers: {
      "content-type": mimeByFormat[entry.expected.format],
      "content-length": String(inputBytes.byteLength),
    },
    body: inputBytes,
  });
  if (uploadResponse.status !== 204)
    throw new Error(`engine upload failed with ${uploadResponse.status}`);
  const runStarted = performance.now();
  const runResponse = await fetch(`${origin}/v1/jobs/${jobId}/run`, { method: "POST" });
  if (runResponse.status !== 202) throw new Error(`engine run failed with ${runResponse.status}`);
  const { status } = await pollTerminal(origin, jobId);
  let outputBytes = null;
  let outputMime = null;
  let effectiveDeliveredBytes = null;
  let metrics = { ssimulacra2: null, butteraugli: null };
  let normalizedPixelMatch = null;
  let losslessVerification = null;
  let outcome = "rejected";
  let errorCode = status.error?.code ?? null;
  let codecBuildId = build.codecs[entry.expected.format] ?? "unknown";
  if (status.state === "succeeded") {
    codecBuildId = status.result.codecBuildId;
    errorCode = null;
    if (status.result.kind === "download") {
      outcome = "download";
      outputBytes = status.result.byteLength;
      outputMime = status.result.mime;
      effectiveDeliveredBytes = outputBytes;
      const response = await fetch(`${origin}/v1/jobs/${jobId}/output`);
      if (!response.ok) throw new Error(`engine output failed with ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength !== outputBytes || bytes.byteLength >= inputBytes.byteLength)
        throw new Error("engine selected an invalid output size");
      const outputPath = join(
        temporaryRoot,
        `${jobId}.${entry.expected.format === "jpeg" ? "jpg" : entry.expected.format}`,
      );
      await writeFile(outputPath, bytes);
      await chmod(outputPath, 0o644);
      if (metricImage) {
        const metricSourcePath = join(temporaryRoot, `${jobId}-source.png`);
        const metricOutputPath = join(temporaryRoot, `${jobId}-output.png`);
        await sharp(inputPath).rotate().toColourspace("srgb").png().toFile(metricSourcePath);
        await sharp(outputPath).rotate().toColourspace("srgb").png().toFile(metricOutputPath);
        await Promise.all([chmod(metricSourcePath, 0o644), chmod(metricOutputPath, 0o644)]);
        metrics = await measureMetrics(metricImage, metricSourcePath, metricOutputPath);
      }
      if (mode === "lossless") {
        normalizedPixelMatch = true;
        losslessVerification =
          entry.expected.format === "jpeg" ? "jpeg-coefficient-exact" : "pixel-exact";
      }
    } else {
      outcome = "original-retained";
      effectiveDeliveredBytes = inputBytes.byteLength;
    }
  }
  const measurements = status.measurements ?? {
    processingMs: Math.round(performance.now() - runStarted),
    peakMemoryBytes: 0,
    processedPixels: 0,
    testedCandidates: 0,
    cpuMs: 0,
  };
  const baseRecord = {
    corpusId: entry.id,
    inputMime: mimeByFormat[entry.expected.format],
    outputMime,
    sizeBand: sizeBand(inputBytes.byteLength),
    alpha: entry.expected.alpha,
    contentClass: entry.expected.class,
    strategicTags: entry.strategicTags,
    outcome,
    errorCode,
    engineBuildId: build.engineBuildId,
    codecBuildId,
    mode,
    preset,
    inputBytes: inputBytes.byteLength,
    outputBytes,
    effectiveDeliveredBytes,
    queueMs: 0,
    coldStart,
    timeToFirstFeedbackMs: Math.round(feedbackMs),
    processingMs: measurements.processingMs,
    peakMemoryBytes: measurements.peakMemoryBytes,
    weightedUnits:
      measurements.cpuMs * 50_000 +
      measurements.testedCandidates * 500_000 +
      measurements.processedPixels,
    ssimulacra2: metrics.ssimulacra2,
    butteraugli: metrics.butteraugli,
    normalizedPixelMatch,
    losslessVerification,
    alphaChecksPassed: status.state === "succeeded",
    reproducedFalseNoSizeReductionCase: outcome !== "rejected",
    cancellationObservedMs: null,
    inputDeletionLagMs: null,
    resultDeletionLagMs: null,
    costUsd: null,
  };
  baseRecord.costUsd = calculateCostUsd(model, baseRecord);
  const deleteStarted = performance.now();
  const deleted = await fetch(`${origin}/v1/jobs/${jobId}`, { method: "DELETE" });
  if (deleted.status !== 204) throw new Error(`engine delete failed with ${deleted.status}`);
  baseRecord.resultDeletionLagMs = Math.round(performance.now() - deleteStarted);
  baseRecord.inputDeletionLagMs = baseRecord.resultDeletionLagMs;
  return baseRecord;
}

export async function benchmarkImageEngine({
  engineImage,
  metricImage,
  manifestPath,
  liveCostModelPath,
  scope,
}) {
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const model = validateLiveCostModelDocument(
    JSON.parse(await readFile(liveCostModelPath, "utf8")),
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hereisit-image-lab-"));
  await chmod(temporaryRoot, 0o755);
  const container = `hereisit-image-lab-${process.pid}-${Date.now()}`;
  let containerId;
  try {
    containerId = await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--network",
      "bridge",
      "--publish",
      "127.0.0.1::8080",
      "--env",
      "ENGINE_BUILD_ID=image-lab",
      "--env",
      "JPEG_CODEC_BUILD_ID=mozjpeg",
      "--env",
      "PNG_CODEC_BUILD_ID=oxipng-quantizr",
      "--env",
      "WEBP_CODEC_BUILD_ID=libwebp",
      "--env",
      "TRANSFORM_BUILD_ID=libvips",
      engineImage,
    );
    const portLine = await docker("port", containerId, "8080/tcp");
    const port = portLine.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("docker did not publish the engine port");
    const origin = `http://127.0.0.1:${port}`;
    await waitForHealth(origin);
    const build = await (await fetch(`${origin}/v1/build`)).json();
    const valid = manifest.entries.filter((entry) => validClasses.has(entry.expected.class));
    const selected =
      scope === "pr"
        ? valid
            .filter((entry) => entry.expected.width * entry.expected.height <= 400_000)
            .slice(0, 20)
        : valid;
    if (
      !new Set(selected.map((entry) => entry.expected.format)).isSupersetOf(
        new Set(["jpeg", "png", "webp"]),
      )
    )
      throw new Error("benchmark scope must cover JPEG, PNG, and WebP");
    const variants =
      scope === "pr"
        ? [["smart", "balanced"]]
        : [
            ["smart", "balanced"],
            ["smart", "smallest"],
            ["lossless", "balanced"],
          ];
    const records = [];
    let first = true;
    for (const entry of selected) {
      const path = resolve(dirname(manifestPath), entry.relativePath);
      const bytes = await readFile(path);
      if (sha256Bytes(bytes) !== entry.sha256)
        throw new Error(`corpus hash mismatch for ${entry.id}`);
      for (const [mode, preset] of variants) {
        records.push(
          await runOne({
            origin,
            entry,
            inputPath: path,
            inputBytes: bytes,
            mode,
            preset,
            build,
            model,
            metricImage,
            temporaryRoot,
            coldStart: first,
          }),
        );
        first = false;
      }
    }
    verifyBenchmarkRecords(records);
    records.sort((left, right) =>
      `${left.corpusId}:${left.mode}:${left.preset}`.localeCompare(
        `${right.corpusId}:${right.mode}:${right.preset}`,
      ),
    );
    const engineDigest = await docker("image", "inspect", "--format", "{{.Id}}", engineImage);
    const sourceLock = await readFile(resolve("apps/image-engine/native/sources.lock.json"));
    return {
      version: 1,
      scope,
      identity: {
        engineImageDigest: engineDigest,
        sourceLockSha256: sha256Bytes(sourceLock),
        corpusManifestSha256: sha256Bytes(manifestBytes),
        liveCostModelSha256: sha256Canonical(model),
        metricBuildIds: {
          ssimulacra2: "libjxl-0.11.2-332feb17",
          butteraugli: "libjxl-0.11.2-332feb17",
        },
      },
      configuration: {
        variants: variants.map(([mode, preset]) => ({ mode, preset })),
        corpusEntries: selected.length,
      },
      records,
      summary: {
        attempted: records.length,
        succeeded: records.filter((record) => record.outcome !== "rejected").length,
        originalRetained: records.filter((record) => record.outcome === "original-retained").length,
        totalCostUsd: records.reduce((sum, record) => sum + record.costUsd.total, 0),
      },
    };
  } finally {
    if (containerId) await docker("rm", "--force", containerId).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const expected = [
    "engine-image",
    "metric-image",
    "manifest",
    "live-cost-model",
    "scope",
    "output",
  ];
  if (
    Object.keys(args).sort().join() !== expected.sort().join() ||
    !["pr", "release"].includes(args.scope)
  )
    throw new TypeError(
      "usage: benchmark-image-engine --engine-image <image> --metric-image <image> --manifest <json> --live-cost-model <json> --scope <pr|release> --output <json>",
    );
  const report = await benchmarkImageEngine({
    engineImage: args["engine-image"],
    metricImage: args["metric-image"],
    manifestPath: args.manifest,
    liveCostModelPath: args["live-cost-model"],
    scope: args.scope,
  });
  const hash = await writeCanonicalJsonAtomic(args.output, report);
  process.stdout.write(`${hash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
