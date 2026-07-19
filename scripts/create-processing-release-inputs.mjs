import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createLiveCostModel, validateRouteCpuBenchmark } from "./create-live-cost-model.mjs";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  canonicalize,
  parseCliArguments,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const placeholder = /(?:todo|tbd|placeholder|example|changeme|your[-_ ]|xxx)/i;

export function createProcessingReleaseInputs(rawInput) {
  const input = assertObject(rawInput, "processing release input");
  assertExactKeys(
    input,
    [
      "version",
      "releaseId",
      "baseSourceSha256",
      "reviewedAt",
      "reviewerIdHash",
      "pricesAndResources",
      "ceilings",
      "routeCpuBenchmark",
    ],
    "processing release input",
  );
  if (input.version !== 1) throw new TypeError("processing release input version must be 1");
  if (
    typeof input.releaseId !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/.test(input.releaseId) ||
    placeholder.test(input.releaseId)
  ) {
    throw new TypeError("releaseId must be an immutable YYYY-MM-DD.N identifier");
  }
  assertSha256(input.baseSourceSha256, "baseSourceSha256");
  assertSha256(input.reviewerIdHash, "reviewerIdHash");
  if (
    typeof input.reviewedAt !== "string" ||
    new Date(input.reviewedAt).toISOString() !== input.reviewedAt
  ) {
    throw new TypeError("reviewedAt must be a canonical ISO timestamp");
  }
  const prices = assertObject(input.pricesAndResources, "pricesAndResources");
  assertExactKeys(prices, ["version", "artifactSha256", "modelInput"], "pricesAndResources");
  if (prices.version !== 1) throw new TypeError("pricesAndResources.version must be 1");
  assertSha256(prices.artifactSha256, "pricesAndResources.artifactSha256");
  const ceilings = assertObject(input.ceilings, "ceilings");
  assertExactKeys(
    ceilings,
    ["maxCostPer1000JobsMicrousd", "maxProjectedMonthlyCostMicrousd"],
    "ceilings",
  );
  assertNonNegativeSafeInteger(
    ceilings.maxCostPer1000JobsMicrousd,
    "ceilings.maxCostPer1000JobsMicrousd",
  );
  assertNonNegativeSafeInteger(
    ceilings.maxProjectedMonthlyCostMicrousd,
    "ceilings.maxProjectedMonthlyCostMicrousd",
  );
  const routeInput = assertObject(input.routeCpuBenchmark, "routeCpuBenchmark");
  assertExactKeys(
    routeInput,
    ["version", "artifactSha256", "sourceModuleSha256", "toolchain", "margin", "routes"],
    "routeCpuBenchmark",
  );
  assertSha256(routeInput.artifactSha256, "routeCpuBenchmark.artifactSha256");
  const { artifactSha256: routeArtifactSha256, ...routeBenchmarkPayload } = routeInput;
  const benchmark = validateRouteCpuBenchmark(routeBenchmarkPayload);
  const modelInput = assertObject(prices.modelInput, "pricesAndResources.modelInput");
  createLiveCostModel({ ...modelInput, routeCpuBenchmark: routeBenchmarkPayload });
  return canonicalize({
    version: 1,
    releaseId: input.releaseId,
    baseSourceSha256: input.baseSourceSha256,
    reviewedAt: input.reviewedAt,
    reviewerIdHash: input.reviewerIdHash,
    pricesAndResources: prices,
    ceilings,
    routeCpuBenchmark: { artifactSha256: routeArtifactSha256, ...routeBenchmarkPayload },
    routeCpuBenchmarkSha256: benchmark.sha256,
    routeCpuEnvelopeMs: benchmark.envelope,
  });
}

export function processingReleaseInputsSha256(value) {
  return sha256Canonical(value);
}

export async function writeProcessingReleaseInputs(path, rawInput) {
  const document = createProcessingReleaseInputs(rawInput);
  return writeCanonicalJsonAtomic(path, document, { refuseOverwrite: true });
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (!args.schema || !args.output) throw new TypeError("--schema and --output are required");
  await readFile(args.schema, "utf8");
  let rawInput;
  if (args.input !== undefined) {
    assertExactKeys(args, ["input", "schema", "output"], "processing release arguments");
    rawInput = JSON.parse(await readFile(args.input, "utf8"));
  } else {
    assertExactKeys(
      args,
      [
        "base-source-sha",
        "price-input",
        "route-cpu-benchmark",
        "quality-cost-ceilings",
        "schema",
        "output",
      ],
      "processing release arguments",
    );
    const [priceBytes, routeBytes, ceilingBytes] = await Promise.all([
      readFile(args["price-input"]),
      readFile(args["route-cpu-benchmark"]),
      readFile(args["quality-cost-ceilings"]),
    ]);
    const priceDocument = assertObject(JSON.parse(priceBytes), "reviewed price input");
    assertExactKeys(
      priceDocument,
      ["version", "reviewedAt", "reviewerIdHash", "modelInput"],
      "reviewed price input",
    );
    const routeDocument = assertObject(JSON.parse(routeBytes), "reviewed route benchmark");
    const ceilings = assertObject(JSON.parse(ceilingBytes), "reviewed quality/cost ceilings");
    rawInput = {
      version: 1,
      releaseId: basename(dirname(args.output)),
      baseSourceSha256: args["base-source-sha"],
      reviewedAt: priceDocument.reviewedAt,
      reviewerIdHash: priceDocument.reviewerIdHash,
      pricesAndResources: {
        version: 1,
        artifactSha256: sha256Bytes(priceBytes),
        modelInput: priceDocument.modelInput,
      },
      ceilings,
      routeCpuBenchmark: {
        artifactSha256: sha256Bytes(routeBytes),
        ...routeDocument,
      },
    };
  }
  const hash = await writeProcessingReleaseInputs(args.output, rawInput);
  process.stdout.write(`${hash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
