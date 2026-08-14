import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePdfBenchmarkReport } from "./benchmark-pdf-engine.mjs";
import { createLiveCostModel } from "./create-live-cost-model.mjs";
import { createProcessingReleaseInputs } from "./create-processing-release-inputs.mjs";
import {
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
} from "./image-lab-common.mjs";

export function bindPdfBenchmarkCostInput(costInput, rawBenchmark) {
  const benchmark = validatePdfBenchmarkReport(rawBenchmark);
  return {
    ...costInput,
    pdfBenchmark: {
      ...costInput.pdfBenchmark,
      evidenceSha256: sha256Bytes(canonicalJson(benchmark)),
      engineImageId: benchmark.identity.engineImageId,
      engineImageDigest: benchmark.identity.engineImageDigest,
      maximumCandidates: Math.max(
        ...benchmark.records.map((record) => record.native.maximumCandidateCount),
      ),
      maximumInputBytes: benchmark.limits.maximumSourceBytes,
      maximumMeasuredPeakRssBytes: benchmark.summary.maximumPeakRssBytes,
      maximumOutputBytes: benchmark.limits.maximumOutputBytes,
    },
  };
}

export async function prepareProcessingCiReleaseSource({
  sourceRoot,
  runtimeRoot,
  releaseId,
  gitSha,
  sourceArchive,
  pdfBenchmarkPath,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub injects this protected reviewer identity
  actor = process.env.GITHUB_ACTOR,
  reviewedAt = new Date().toISOString(),
}) {
  if (
    !/^[a-f0-9]{40}$/.test(gitSha ?? "") ||
    !/^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/.test(releaseId ?? "")
  )
    throw new TypeError("release identity is invalid");
  if (typeof actor !== "string" || actor.length < 1)
    throw new TypeError("protected release reviewer identity is missing");
  const priceBytes = await readFile("docs/deployment/processing-staging-cost-input.json");
  const benchmarkBytes = await readBoundedRegularFile(
    resolve(pdfBenchmarkPath),
    16 * 1024 * 1024,
    "exact PDF benchmark",
  );
  const liveCostInput = bindPdfBenchmarkCostInput(
    JSON.parse(priceBytes.toString("utf8")),
    JSON.parse(benchmarkBytes.toString("utf8")),
  );
  const costModel = createLiveCostModel(liveCostInput);
  const { routeCpuBenchmark, ...modelInput } = liveCostInput;
  const sourceSha256 = sha256Bytes(await readFile(resolve(sourceArchive)));
  const inputs = createProcessingReleaseInputs({
    version: 1,
    releaseId,
    baseSourceSha256: sourceSha256,
    reviewedAt,
    reviewerIdHash: createHash("sha256").update(actor).digest("hex"),
    pricesAndResources: {
      version: 1,
      artifactSha256: sha256Bytes(canonicalJson(liveCostInput)),
      modelInput,
    },
    ceilings: {
      maxCostPer1000JobsMicrousd: 500000,
      maxLiveMedianOutputRatioBps: 8500,
      maxLiveP95WeightedUnits: 150000000,
      maxLiveOriginalRetainedRateBps: 7000,
      maxProjectedMonthlyCostMicrousd: 5000000,
    },
    routeCpuBenchmark: {
      artifactSha256: sha256Bytes(canonicalJson(routeCpuBenchmark)),
      ...routeCpuBenchmark,
    },
  });
  await writeFile(resolve(sourceRoot, "processing-release-inputs.json"), canonicalJson(inputs), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(resolve(sourceRoot, "live-cost-model.json"), canonicalJson(costModel), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    resolve(runtimeRoot, "release-review.json"),
    canonicalJson({
      schema: "hereisit-processing-ci-release-review@1",
      gitSha,
      releaseId,
      reviewedAt,
      reviewerIdHash: inputs.reviewerIdHash,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = parseCliArguments(process.argv.slice(2));
  await prepareProcessingCiReleaseSource({
    sourceRoot: args["source-root"],
    runtimeRoot: args["runtime-root"],
    releaseId: args["release-id"],
    gitSha: args["git-sha"],
    sourceArchive: args["source-archive"],
    pdfBenchmarkPath: args["pdf-benchmark"],
  });
}
