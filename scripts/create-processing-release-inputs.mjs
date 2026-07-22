import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLiveCostModel, validateRouteCpuBenchmark } from "./create-live-cost-model.mjs";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  canonicalize,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const placeholder = /(?:todo|tbd|placeholder|example|changeme|your[-_ ]|xxx)/i;
const releaseIdPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/;
const releaseInputPathPattern =
  /^docs\/deployment\/releases\/([0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*)\/processing-release-inputs\.json$/;
const trustedSchemaPath = "docs/deployment/processing-release-inputs.schema.json";
const maximumReleaseInputBytes = 1024 * 1024;

async function assertTrustedReleaseInputSchema(path, requireRepositoryPath = false) {
  if (requireRepositoryPath && path !== trustedSchemaPath) {
    throw new TypeError("trusted schema must use its canonical repository path");
  }
  const bytes = await readBoundedRegularFile(
    resolve(path),
    maximumReleaseInputBytes,
    "processing release input schema",
  );
  let schema;
  try {
    schema = assertObject(JSON.parse(bytes), "processing release input schema");
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError("processing release input schema is not valid JSON");
    }
    throw error;
  }
  const version = assertObject(
    assertObject(schema.properties, "processing release input schema properties").version,
    "processing release input schema version",
  );
  // Identity only: createProcessingReleaseInputs remains the authoritative semantic validator.
  if (
    schema.$id !== "https://hereisit.app/schemas/processing-release-inputs-v1.json" ||
    schema.title !== "HereIsIt immutable processing release inputs v1" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    version.const !== 1
  ) {
    throw new TypeError("processing release input schema identity is invalid");
  }
}

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
    !releaseIdPattern.test(input.releaseId) ||
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
    [
      "maxCostPer1000JobsMicrousd",
      "maxLiveMedianOutputRatioBps",
      "maxLiveP95WeightedUnits",
      "maxLiveOriginalRetainedRateBps",
      "maxProjectedMonthlyCostMicrousd",
    ],
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
  for (const field of ["maxLiveMedianOutputRatioBps", "maxLiveP95WeightedUnits"]) {
    assertNonNegativeSafeInteger(ceilings[field], `ceilings.${field}`);
    if (ceilings[field] === 0) throw new TypeError(`ceilings.${field} must be positive`);
  }
  if (ceilings.maxLiveMedianOutputRatioBps > 10_000) {
    throw new TypeError("ceilings.maxLiveMedianOutputRatioBps must not exceed 10000");
  }
  assertNonNegativeSafeInteger(
    ceilings.maxLiveOriginalRetainedRateBps,
    "ceilings.maxLiveOriginalRetainedRateBps",
  );
  if (ceilings.maxLiveOriginalRetainedRateBps > 10_000) {
    throw new TypeError("ceilings.maxLiveOriginalRetainedRateBps must not exceed 10000");
  }
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

export function validateCanonicalProcessingReleaseInputs(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("processing release inputs must be bytes");
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new TypeError("processing release inputs are not valid JSON");
  }
  const {
    routeCpuBenchmarkSha256: _routeCpuBenchmarkSha256,
    routeCpuEnvelopeMs: _routeCpuEnvelopeMs,
    ...rawInput
  } = assertObject(parsed, "processing release inputs");
  const document = createProcessingReleaseInputs(rawInput);
  if (!bytes.equals(Buffer.from(canonicalJson(document)))) {
    throw new TypeError("processing release inputs are not canonical JSON");
  }
  return document;
}

export async function verifyProcessingReleaseInputs(path) {
  const pathReleaseId = releaseInputPathPattern.exec(path)?.[1];
  if (pathReleaseId === undefined) {
    throw new TypeError("processing release inputs must use their canonical repository path");
  }
  const requestedPath = resolve(path);
  const bytes = await readBoundedRegularFile(
    requestedPath,
    maximumReleaseInputBytes,
    "processing release inputs",
  );
  const document = validateCanonicalProcessingReleaseInputs(bytes);
  if (document.releaseId !== pathReleaseId) {
    throw new TypeError("processing release ID does not match its repository path");
  }
  return sha256Bytes(bytes);
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (args["verify-only"] !== undefined) {
    assertExactKeys(args, ["verify-only", "schema"], "processing release arguments");
    await assertTrustedReleaseInputSchema(args.schema, true);
    process.stdout.write(`${await verifyProcessingReleaseInputs(args["verify-only"])}\n`);
    return;
  }
  if (!args.schema || !args.output) throw new TypeError("--schema and --output are required");
  await assertTrustedReleaseInputSchema(args.schema);
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
