import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertPositiveNumber,
  assertSha256,
  canonicalize,
  canonicalJson,
  decimalUsdToMicrousd,
  parseCliArguments,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

export { canonicalJson };

const priceFields = Object.freeze([
  "containerVcpuSecond",
  "containerGibSecond",
  "containerDiskGbSecond",
  "containerEgressRegion",
  "workersMillionRequests",
  "workersMillionCpuMs",
  "durableObjectMillionRequests",
  "durableObjectGibSecond",
  "durableObjectStorageGbMonth",
  "r2StorageGbMonth",
  "r2ClassAMillion",
  "r2ClassBMillion",
  "queueMillionOperations",
  "d1MillionRowsRead",
  "d1MillionRowsWritten",
  "d1StorageGbMonth",
  "observabilityMillionLogEvents",
  "workersLogpushMillionEvents",
  "analyticsEngineMillionDataPoints",
  "analyticsEngineMillionReadQueries",
  "monthlyFixed",
]);
const routeNames = Object.freeze([
  "policy",
  "create",
  "upload",
  "read",
  "result",
  "maintenance",
  "queue",
]);

function validateArrivalTrace(value, label) {
  if (!Array.isArray(value) || value.length !== 24)
    throw new TypeError(`${label} must contain 24 hourly values`);
  return value.map((entry, index) => assertNonNegativeSafeInteger(entry, `${label}[${index}]`));
}

export function validateRouteCpuBenchmark(value) {
  const benchmark = assertObject(value, "routeCpuBenchmark");
  assertExactKeys(
    benchmark,
    ["version", "sourceModuleSha256", "toolchain", "margin", "routes"],
    "routeCpuBenchmark",
  );
  if (benchmark.version !== 1) throw new TypeError("routeCpuBenchmark.version must be 1");
  assertSha256(benchmark.sourceModuleSha256, "routeCpuBenchmark.sourceModuleSha256");
  if (
    typeof benchmark.toolchain !== "string" ||
    benchmark.toolchain.length < 3 ||
    benchmark.toolchain.length > 100
  ) {
    throw new TypeError("routeCpuBenchmark.toolchain is invalid");
  }
  const margin = assertObject(benchmark.margin, "routeCpuBenchmark.margin");
  assertExactKeys(margin, ["kind", "percent"], "routeCpuBenchmark.margin");
  if (
    margin.kind !== "p99-plus-percent" ||
    !Number.isInteger(margin.percent) ||
    margin.percent < 0 ||
    margin.percent > 100
  ) {
    throw new TypeError("routeCpuBenchmark.margin is invalid");
  }
  const routes = assertObject(benchmark.routes, "routeCpuBenchmark.routes");
  assertExactKeys(routes, routeNames, "routeCpuBenchmark.routes");
  const envelope = {};
  for (const route of routeNames) {
    const measurement = assertObject(routes[route], `routeCpuBenchmark.routes.${route}`);
    assertExactKeys(measurement, ["p99Ms", "samples"], `routeCpuBenchmark.routes.${route}`);
    assertPositiveNumber(measurement.p99Ms, `routeCpuBenchmark.routes.${route}.p99Ms`);
    if (!Number.isSafeInteger(measurement.samples) || measurement.samples < 20) {
      throw new TypeError(`routeCpuBenchmark.routes.${route}.samples must be at least 20`);
    }
    envelope[route] = Math.ceil(measurement.p99Ms * (1 + margin.percent / 100));
  }
  return { envelope, sha256: sha256Canonical(benchmark) };
}

export function createLiveCostModel(rawInput) {
  const input = assertObject(rawInput, "live cost input");
  assertExactKeys(
    input,
    [
      "version",
      "pricesUsd",
      "resources",
      "routeCpuBenchmark",
      "projectedMonthlyJobs",
      "arrivalTraces",
    ],
    "live cost input",
  );
  if (input.version !== 1) throw new TypeError("live cost input version must be 1");
  const prices = assertObject(input.pricesUsd, "pricesUsd");
  assertExactKeys(prices, priceFields, "pricesUsd");
  const resources = assertObject(input.resources, "resources");
  assertExactKeys(
    resources,
    ["containerInstanceVcpu", "containerInstanceMemoryGib", "containerInstanceDiskGb"],
    "resources",
  );
  const egress = assertObject(prices.containerEgressRegion, "pricesUsd.containerEgressRegion");
  if (Object.keys(egress).length < 1)
    throw new TypeError("at least one signed egress region price is required");
  const egressMicros = Object.fromEntries(
    Object.entries(egress).map(([region, value]) => {
      if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(region))
        throw new TypeError(`invalid egress region ${region}`);
      return [region, decimalUsdToMicrousd(value, `egress region ${region}`)];
    }),
  );
  const priceMicros = Object.fromEntries(
    priceFields
      .filter((field) => field !== "containerEgressRegion")
      .map((field) => [field, decimalUsdToMicrousd(prices[field], `pricesUsd.${field}`)]),
  );
  const arrival = assertObject(input.arrivalTraces, "arrivalTraces");
  assertExactKeys(arrival, ["steady", "bursty", "sparse"], "arrivalTraces");
  const steady = validateArrivalTrace(arrival.steady, "arrivalTraces.steady");
  const bursty = validateArrivalTrace(arrival.bursty, "arrivalTraces.bursty");
  const sparse = validateArrivalTrace(arrival.sparse, "arrivalTraces.sparse");
  const projectedMonthlyJobs = assertNonNegativeSafeInteger(
    input.projectedMonthlyJobs,
    "projectedMonthlyJobs",
  );
  if (projectedMonthlyJobs === 0) throw new TypeError("projectedMonthlyJobs must be positive");
  const benchmark = validateRouteCpuBenchmark(input.routeCpuBenchmark);

  return canonicalize({
    version: 1,
    containerVcpuSecondMicrousd: priceMicros.containerVcpuSecond,
    containerGibSecondMicrousd: priceMicros.containerGibSecond,
    containerDiskGbSecondMicrousd: priceMicros.containerDiskGbSecond,
    containerEgressGbMicrousd: Math.max(...Object.values(egressMicros)),
    containerEgressRegionPricesMicrousd: egressMicros,
    containerEgressRegionPricesSha256: sha256Canonical(egressMicros),
    containerInstanceVcpu: assertPositiveNumber(
      resources.containerInstanceVcpu,
      "resources.containerInstanceVcpu",
    ),
    containerInstanceMemoryGib: assertPositiveNumber(
      resources.containerInstanceMemoryGib,
      "resources.containerInstanceMemoryGib",
    ),
    containerInstanceDiskGb: assertPositiveNumber(
      resources.containerInstanceDiskGb,
      "resources.containerInstanceDiskGb",
    ),
    containerSleepAfterSeconds: 60,
    workersMillionRequestsMicrousd: priceMicros.workersMillionRequests,
    workersMillionCpuMsMicrousd: priceMicros.workersMillionCpuMs,
    durableObjectMillionRequestsMicrousd: priceMicros.durableObjectMillionRequests,
    durableObjectGibSecondMicrousd: priceMicros.durableObjectGibSecond,
    durableObjectStorageGbMonthMicrousd: priceMicros.durableObjectStorageGbMonth,
    r2StorageGbMonthMicrousd: priceMicros.r2StorageGbMonth,
    r2ClassAMillionMicrousd: priceMicros.r2ClassAMillion,
    r2ClassBMillionMicrousd: priceMicros.r2ClassBMillion,
    queueMillionOperationsMicrousd: priceMicros.queueMillionOperations,
    d1MillionRowsReadMicrousd: priceMicros.d1MillionRowsRead,
    d1MillionRowsWrittenMicrousd: priceMicros.d1MillionRowsWritten,
    d1StorageGbMonthMicrousd: priceMicros.d1StorageGbMonth,
    observabilityMillionLogEventsMicrousd: priceMicros.observabilityMillionLogEvents,
    workersLogpushMillionEventsMicrousd: priceMicros.workersLogpushMillionEvents,
    analyticsEngineMillionDataPointsMicrousd: priceMicros.analyticsEngineMillionDataPoints,
    analyticsEngineMillionReadQueriesMicrousd: priceMicros.analyticsEngineMillionReadQueries,
    monthlyFixedMicrousd: priceMicros.monthlyFixed,
    projectedMonthlyJobs,
    routeCpuBenchmarkSha256: benchmark.sha256,
    routeCpuEnvelopeMs: benchmark.envelope,
    arrivalProjection: {
      algorithm: "arrival-union-tail-v1",
      steadyHourlyJobs: steady,
      burstyHourlyJobs: bursty,
      sparseHourlyJobs: sparse,
      scenariosSha256: sha256Canonical({ steady, bursty, sparse }),
    },
  });
}

export function liveCostModelSha256(model) {
  return sha256Canonical(model);
}

export function validateLiveCostModelDocument(rawModel) {
  const model = assertObject(rawModel, "live cost model");
  const numericFields = [
    "containerVcpuSecondMicrousd",
    "containerGibSecondMicrousd",
    "containerDiskGbSecondMicrousd",
    "containerEgressGbMicrousd",
    "containerInstanceVcpu",
    "containerInstanceMemoryGib",
    "containerInstanceDiskGb",
    "containerSleepAfterSeconds",
    "workersMillionRequestsMicrousd",
    "workersMillionCpuMsMicrousd",
    "durableObjectMillionRequestsMicrousd",
    "durableObjectGibSecondMicrousd",
    "durableObjectStorageGbMonthMicrousd",
    "r2StorageGbMonthMicrousd",
    "r2ClassAMillionMicrousd",
    "r2ClassBMillionMicrousd",
    "queueMillionOperationsMicrousd",
    "d1MillionRowsReadMicrousd",
    "d1MillionRowsWrittenMicrousd",
    "d1StorageGbMonthMicrousd",
    "observabilityMillionLogEventsMicrousd",
    "workersLogpushMillionEventsMicrousd",
    "analyticsEngineMillionDataPointsMicrousd",
    "analyticsEngineMillionReadQueriesMicrousd",
    "monthlyFixedMicrousd",
    "projectedMonthlyJobs",
  ];
  assertExactKeys(
    model,
    [
      "version",
      ...numericFields,
      "containerEgressRegionPricesMicrousd",
      "containerEgressRegionPricesSha256",
      "routeCpuBenchmarkSha256",
      "routeCpuEnvelopeMs",
      "arrivalProjection",
    ],
    "live cost model",
  );
  if (model.version !== 1 || model.containerSleepAfterSeconds !== 60)
    throw new TypeError("live cost model constants are invalid");
  for (const field of numericFields) {
    if (typeof model[field] !== "number" || !Number.isFinite(model[field]) || model[field] < 0)
      throw new TypeError(`live cost model ${field} is invalid`);
  }
  if (model.projectedMonthlyJobs < 1) throw new TypeError("projectedMonthlyJobs must be positive");
  const regional = assertObject(
    model.containerEgressRegionPricesMicrousd,
    "containerEgressRegionPricesMicrousd",
  );
  if (
    Object.keys(regional).length === 0 ||
    Object.values(regional).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    Math.max(...Object.values(regional)) !== model.containerEgressGbMicrousd ||
    sha256Canonical(regional) !== model.containerEgressRegionPricesSha256
  ) {
    throw new TypeError("regional container egress price binding is invalid");
  }
  assertSha256(model.routeCpuBenchmarkSha256, "routeCpuBenchmarkSha256");
  assertExactKeys(model.routeCpuEnvelopeMs, routeNames, "routeCpuEnvelopeMs");
  for (const value of Object.values(model.routeCpuEnvelopeMs))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError("route CPU envelope is invalid");
  const arrival = assertObject(model.arrivalProjection, "arrivalProjection");
  assertExactKeys(
    arrival,
    ["algorithm", "steadyHourlyJobs", "burstyHourlyJobs", "sparseHourlyJobs", "scenariosSha256"],
    "arrivalProjection",
  );
  if (arrival.algorithm !== "arrival-union-tail-v1")
    throw new TypeError("arrival algorithm is invalid");
  const steady = validateArrivalTrace(arrival.steadyHourlyJobs, "steadyHourlyJobs");
  const bursty = validateArrivalTrace(arrival.burstyHourlyJobs, "burstyHourlyJobs");
  const sparse = validateArrivalTrace(arrival.sparseHourlyJobs, "sparseHourlyJobs");
  if (sha256Canonical({ steady, bursty, sparse }) !== arrival.scenariosSha256)
    throw new TypeError("arrival scenario hash mismatch");
  return model;
}

const flagToPrice = Object.freeze({
  "container-vcpu-second-usd": "containerVcpuSecond",
  "container-gib-second-usd": "containerGibSecond",
  "container-disk-gb-second-usd": "containerDiskGbSecond",
  "workers-million-requests-usd": "workersMillionRequests",
  "workers-million-cpu-ms-usd": "workersMillionCpuMs",
  "do-million-requests-usd": "durableObjectMillionRequests",
  "do-gib-second-usd": "durableObjectGibSecond",
  "do-storage-gb-month-usd": "durableObjectStorageGbMonth",
  "r2-gb-month-usd": "r2StorageGbMonth",
  "r2-class-a-million-usd": "r2ClassAMillion",
  "r2-class-b-million-usd": "r2ClassBMillion",
  "queue-million-ops-usd": "queueMillionOperations",
  "d1-million-rows-read-usd": "d1MillionRowsRead",
  "d1-million-rows-written-usd": "d1MillionRowsWritten",
  "d1-storage-gb-month-usd": "d1StorageGbMonth",
  "observability-million-log-events-usd": "observabilityMillionLogEvents",
  "workers-logpush-million-events-usd": "workersLogpushMillionEvents",
  "analytics-engine-million-data-points-usd": "analyticsEngineMillionDataPoints",
  "analytics-engine-million-read-queries-usd": "analyticsEngineMillionReadQueries",
  "monthly-fixed-usd": "monthlyFixed",
});

async function jsonArgument(value, label) {
  const source = value.trim();
  try {
    return JSON.parse(source);
  } catch {
    try {
      return JSON.parse(await readFile(source, "utf8"));
    } catch {
      throw new TypeError(`${label} must be JSON or a JSON file path`);
    }
  }
}

async function inputFromFlags(args) {
  const permitted = new Set([
    ...Object.keys(flagToPrice),
    "container-egress-region-prices-json",
    "container-instance-vcpu",
    "container-instance-memory-gib",
    "container-instance-disk-gb",
    "route-cpu-benchmark-json",
    "projected-monthly-jobs",
    "arrival-trace-steady",
    "arrival-trace-bursty",
    "arrival-trace-sparse",
    "schema",
    "output",
  ]);
  for (const key of Object.keys(args))
    if (!permitted.has(key)) throw new TypeError(`unknown argument --${key}`);
  for (const key of permitted)
    if (!["schema", "output"].includes(key) && args[key] === undefined)
      throw new TypeError(`missing mandatory argument --${key}`);
  const pricesUsd = Object.fromEntries(
    Object.entries(flagToPrice).map(([flag, field]) => [field, args[flag]]),
  );
  pricesUsd.containerEgressRegion = await jsonArgument(
    args["container-egress-region-prices-json"],
    "regional egress prices",
  );
  return {
    version: 1,
    pricesUsd,
    resources: {
      containerInstanceVcpu: Number(args["container-instance-vcpu"]),
      containerInstanceMemoryGib: Number(args["container-instance-memory-gib"]),
      containerInstanceDiskGb: Number(args["container-instance-disk-gb"]),
    },
    routeCpuBenchmark: await jsonArgument(args["route-cpu-benchmark-json"], "route CPU benchmark"),
    projectedMonthlyJobs: Number(args["projected-monthly-jobs"]),
    arrivalTraces: {
      steady: await jsonArgument(args["arrival-trace-steady"], "steady arrival trace"),
      bursty: await jsonArgument(args["arrival-trace-bursty"], "bursty arrival trace"),
      sparse: await jsonArgument(args["arrival-trace-sparse"], "sparse arrival trace"),
    },
  };
}

export function liveCostInputFromReleaseDocument(document) {
  const release = assertObject(document, "processing release inputs");
  const prices = assertObject(release.pricesAndResources, "release pricesAndResources");
  const benchmark = assertObject(release.routeCpuBenchmark, "release routeCpuBenchmark");
  const { artifactSha256: _artifactSha256, ...routeCpuBenchmark } = benchmark;
  if (sha256Canonical(routeCpuBenchmark) !== release.routeCpuBenchmarkSha256)
    throw new TypeError("release route benchmark hash mismatch");
  return { ...assertObject(prices.modelInput, "release modelInput"), routeCpuBenchmark };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (!args.schema || !args.output) throw new TypeError("--schema and --output are required");
  await readFile(args.schema, "utf8");
  const sourceCount =
    Number(args.input !== undefined) + Number(args["release-inputs"] !== undefined);
  if (sourceCount > 1) throw new TypeError("live cost input forms cannot be mixed");
  let input;
  if (args.input !== undefined) {
    assertExactKeys(args, ["input", "schema", "output"], "live cost model arguments");
    input = JSON.parse(await readFile(args.input, "utf8"));
  } else if (args["release-inputs"] !== undefined) {
    const releaseFields =
      args["production-release"] === undefined
        ? ["release-inputs", "schema", "output"]
        : ["release-inputs", "schema", "output", "production-release"];
    assertExactKeys(args, releaseFields, "live cost model arguments");
    if (args["production-release"] !== undefined && args["production-release"] !== "true")
      throw new TypeError("--production-release must be true");
    input = liveCostInputFromReleaseDocument(
      JSON.parse(await readFile(args["release-inputs"], "utf8")),
    );
  } else {
    input = await inputFromFlags(args);
  }
  const model = createLiveCostModel(input);
  const hash = await writeCanonicalJsonAtomic(args.output, model);
  process.stdout.write(`${hash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
