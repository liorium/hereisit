import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLiveCostModel } from "./create-live-cost-model.mjs";
import { createProcessingReleaseInputs } from "./create-processing-release-inputs.mjs";
import { canonicalJson, parseCliArguments, sha256Bytes } from "./image-lab-common.mjs";

export async function prepareProcessingCiReleaseSource({
  sourceRoot,
  runtimeRoot,
  releaseId,
  gitSha,
  sourceArchive,
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
  const liveCostInput = JSON.parse(priceBytes.toString("utf8"));
  const { routeCpuBenchmark, ...modelInput } = liveCostInput;
  const sourceSha256 = sha256Bytes(await readFile(resolve(sourceArchive)));
  const inputs = createProcessingReleaseInputs({
    version: 1,
    releaseId,
    baseSourceSha256: sourceSha256,
    reviewedAt,
    reviewerIdHash: createHash("sha256").update(actor).digest("hex"),
    pricesAndResources: { version: 1, artifactSha256: sha256Bytes(priceBytes), modelInput },
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
  await writeFile(
    resolve(sourceRoot, "live-cost-model.json"),
    canonicalJson(createLiveCostModel(liveCostInput)),
    { flag: "wx", mode: 0o600 },
  );
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
  });
}
