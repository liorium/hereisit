import type { LiveCostModelV1 } from "./env";

const INT64_MAXIMUM = 9_223_372_036_854_775_807n;
const CANONICAL_INTEGER_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const MILLION = 1_000_000n;
const GIB_BYTE_MILLISECONDS_PER_SECOND = 1_073_741_824n * 1_000n;
const GB_BYTE_MILLISECONDS_PER_SECOND = 1_000_000_000n * 1_000n;
const GB_MONTH_BYTE_MILLISECONDS = 1_000_000_000n * 30n * 24n * 3_600n * 1_000n;
const DURABLE_OBJECT_128_MIB_MILLISECONDS_PER_GIB_SECOND = 8_000n;
const FIXED_COST_HOURS = 30n * 24n;

export interface HourlyCostUsage {
  readonly workerRequests: string;
  readonly workerCpuMs: string;
  readonly containerCpuMicroseconds: string;
  readonly containerAllocatedMemoryByteMilliseconds: string;
  readonly containerAllocatedDiskByteMilliseconds: string;
  readonly containerTransmittedBytesByRegion: readonly {
    readonly region: string;
    readonly transmittedBytes: string;
  }[];
  readonly durableObjectActiveMilliseconds: string;
  readonly durableObjectRequests: string;
  readonly durableObjectStorageByteMilliseconds: string;
  readonly queueOperations: string;
  readonly d1RowsRead: string;
  readonly d1RowsWritten: string;
  readonly d1StorageByteMilliseconds: string;
  readonly r2ClassAOperations: string;
  readonly r2ClassBOperations: string;
  readonly r2StorageByteMilliseconds: string;
  readonly analyticsEngineDataPoints: string;
  readonly analyticsEngineReadQueries: string;
  readonly observabilityLogEvents: string;
  readonly workersLogpushEvents: string;
}

export interface HourlyCosts {
  readonly workerCostMicrousd: string;
  readonly containerCostMicrousd: string;
  readonly durableObjectCostMicrousd: string;
  readonly queueCostMicrousd: string;
  readonly d1CostMicrousd: string;
  readonly r2CostMicrousd: string;
  readonly analyticsEngineCostMicrousd: string;
  readonly observabilityCostMicrousd: string;
  readonly fixedCostMicrousd: string;
  readonly totalCostMicrousd: string;
}

function integer(value: string, label: string): bigint {
  if (!CANONICAL_INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical non-negative integer.`);
  }
  const parsed = BigInt(value);
  if (parsed > INT64_MAXIMUM) throw new RangeError(`${label} exceeds signed 64-bit storage.`);
  return parsed;
}

function rate(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return BigInt(value);
}

function ceilingCharge(amount: bigint, price: bigint, denominator: bigint): bigint {
  if (amount === 0n || price === 0n) return 0n;
  return (amount * price + denominator - 1n) / denominator;
}

function checkedCostSum(label: string, ...components: readonly bigint[]): bigint {
  let total = 0n;
  for (const component of components) {
    total += component;
    if (total > INT64_MAXIMUM) throw new RangeError(`${label} exceeds signed 64-bit storage.`);
  }
  return total;
}

export function calculateHourlyCosts(model: LiveCostModelV1, usage: HourlyCostUsage): HourlyCosts {
  const workerCost = checkedCostSum(
    "Worker cost",
    ceilingCharge(
      integer(usage.workerRequests, "Worker requests"),
      rate(model.workersMillionRequestsMicrousd, "Worker request price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.workerCpuMs, "Worker CPU milliseconds"),
      rate(model.workersMillionCpuMsMicrousd, "Worker CPU price"),
      MILLION,
    ),
  );

  const regionalEgressCosts: bigint[] = [];
  let previousRegion: string | null = null;
  for (const entry of usage.containerTransmittedBytesByRegion) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(entry.region)) {
      throw new TypeError("Container egress region is invalid.");
    }
    if (previousRegion !== null && entry.region <= previousRegion) {
      throw new TypeError("Container egress regions must be strictly ordered.");
    }
    previousRegion = entry.region;
    const configuredPrice =
      model.containerEgressRegionPricesMicrousd[entry.region] ??
      model.containerEgressRegionPricesMicrousd[entry.region.toUpperCase()];
    if (configuredPrice === undefined) {
      throw new TypeError("Container egress region has no reviewed price.");
    }
    regionalEgressCosts.push(
      ceilingCharge(
        integer(entry.transmittedBytes, "Container transmitted bytes"),
        rate(configuredPrice, "Container regional egress price"),
        1_000_000_000n,
      ),
    );
  }
  const containerCost = checkedCostSum(
    "Container cost",
    ceilingCharge(
      integer(usage.containerCpuMicroseconds, "Container CPU microseconds"),
      rate(model.containerVcpuSecondMicrousd, "Container CPU price"),
      MILLION,
    ),
    ceilingCharge(
      integer(
        usage.containerAllocatedMemoryByteMilliseconds,
        "Container allocated memory byte-milliseconds",
      ),
      rate(model.containerGibSecondMicrousd, "Container memory price"),
      GIB_BYTE_MILLISECONDS_PER_SECOND,
    ),
    ceilingCharge(
      integer(
        usage.containerAllocatedDiskByteMilliseconds,
        "Container allocated disk byte-milliseconds",
      ),
      rate(model.containerDiskGbSecondMicrousd, "Container disk price"),
      GB_BYTE_MILLISECONDS_PER_SECOND,
    ),
    ...regionalEgressCosts,
  );

  const durableObjectCost = checkedCostSum(
    "Durable Object cost",
    ceilingCharge(
      integer(usage.durableObjectActiveMilliseconds, "Durable Object active milliseconds"),
      rate(model.durableObjectGibSecondMicrousd, "Durable Object duration price"),
      DURABLE_OBJECT_128_MIB_MILLISECONDS_PER_GIB_SECOND,
    ),
    ceilingCharge(
      integer(usage.durableObjectRequests, "Durable Object requests"),
      rate(model.durableObjectMillionRequestsMicrousd, "Durable Object request price"),
      MILLION,
    ),
    ceilingCharge(
      integer(
        usage.durableObjectStorageByteMilliseconds,
        "Durable Object storage byte-milliseconds",
      ),
      rate(model.durableObjectStorageGbMonthMicrousd, "Durable Object storage price"),
      GB_MONTH_BYTE_MILLISECONDS,
    ),
  );
  const queueCost = ceilingCharge(
    integer(usage.queueOperations, "Queue operations"),
    rate(model.queueMillionOperationsMicrousd, "Queue operation price"),
    MILLION,
  );
  const d1Cost = checkedCostSum(
    "D1 cost",
    ceilingCharge(
      integer(usage.d1RowsRead, "D1 rows read"),
      rate(model.d1MillionRowsReadMicrousd, "D1 read price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.d1RowsWritten, "D1 rows written"),
      rate(model.d1MillionRowsWrittenMicrousd, "D1 write price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.d1StorageByteMilliseconds, "D1 storage byte-milliseconds"),
      rate(model.d1StorageGbMonthMicrousd, "D1 storage price"),
      GB_MONTH_BYTE_MILLISECONDS,
    ),
  );
  const r2Cost = checkedCostSum(
    "R2 cost",
    ceilingCharge(
      integer(usage.r2ClassAOperations, "R2 class A operations"),
      rate(model.r2ClassAMillionMicrousd, "R2 class A price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.r2ClassBOperations, "R2 class B operations"),
      rate(model.r2ClassBMillionMicrousd, "R2 class B price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.r2StorageByteMilliseconds, "R2 storage byte-milliseconds"),
      rate(model.r2StorageGbMonthMicrousd, "R2 storage price"),
      GB_MONTH_BYTE_MILLISECONDS,
    ),
  );
  const analyticsEngineCost = checkedCostSum(
    "Analytics Engine cost",
    ceilingCharge(
      integer(usage.analyticsEngineDataPoints, "Analytics Engine data points"),
      rate(model.analyticsEngineMillionDataPointsMicrousd, "Analytics Engine point price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.analyticsEngineReadQueries, "Analytics Engine read queries"),
      rate(model.analyticsEngineMillionReadQueriesMicrousd, "Analytics Engine query price"),
      MILLION,
    ),
  );
  const observabilityCost = checkedCostSum(
    "Observability cost",
    ceilingCharge(
      integer(usage.observabilityLogEvents, "Observability log events"),
      rate(model.observabilityMillionLogEventsMicrousd, "Observability log price"),
      MILLION,
    ),
    ceilingCharge(
      integer(usage.workersLogpushEvents, "Workers Logpush events"),
      rate(model.workersLogpushMillionEventsMicrousd, "Workers Logpush price"),
      MILLION,
    ),
  );
  const fixedCost = ceilingCharge(
    1n,
    rate(model.monthlyFixedMicrousd, "Monthly fixed price"),
    FIXED_COST_HOURS,
  );
  const totalCost = checkedCostSum(
    "Hourly total cost",
    workerCost,
    containerCost,
    durableObjectCost,
    queueCost,
    d1Cost,
    r2Cost,
    analyticsEngineCost,
    observabilityCost,
    fixedCost,
  );
  return {
    workerCostMicrousd: workerCost.toString(),
    containerCostMicrousd: containerCost.toString(),
    durableObjectCostMicrousd: durableObjectCost.toString(),
    queueCostMicrousd: queueCost.toString(),
    d1CostMicrousd: d1Cost.toString(),
    r2CostMicrousd: r2Cost.toString(),
    analyticsEngineCostMicrousd: analyticsEngineCost.toString(),
    observabilityCostMicrousd: observabilityCost.toString(),
    fixedCostMicrousd: fixedCost.toString(),
    totalCostMicrousd: totalCost.toString(),
  };
}
