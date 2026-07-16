import type { ImageResourceClass } from "@hereisit/server-contracts";
import {
  IMAGE_OPTIMIZE_MAX_PIXELS,
  type ImageOptimizeCreateRequestV1,
  type ImageOptimizeMime,
} from "@hereisit/tool-contracts";

export interface ResourceEstimate {
  resourceClass: "image-standard-v1";
  reservedWeightedUnits: number;
  inputBytes: number;
  reservationPixelCeiling: 40_000_000;
}

export interface ActualUsageSample {
  inputBytes: number;
  outputBytes: number | null;
  pixels: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  testedCandidates: number;
  mime: ImageOptimizeMime;
}

export const PROCESSING_UNIT_COEFFICIENT_VERSION = 1 as const;
export const FAILED_ATTEMPT_MINIMUM_UNITS = 2_000_000;

const MEBIBYTE = 1024 * 1024;
const CONTROL_PLANE_BUDGET_UNITS = 20_000_000;
const CPU_WEIGHT = 50_000;
const CANDIDATE_WEIGHT = 500_000;

const contentCoefficient = {
  "image/jpeg": 2,
  "image/png": 3,
  "image/webp": 2,
} as const satisfies Record<ImageOptimizeMime, number>;

const attemptCaps = {
  "image-standard-v1": {
    cpuMs: 45_000,
    wallMs: 60_000,
    memoryDeltaMiB: 768,
    testedCandidates: 3,
  },
  "image-large-v1": {
    cpuMs: 75_000,
    wallMs: 90_000,
    memoryDeltaMiB: 1536,
    testedCandidates: 3,
  },
} as const satisfies Record<
  ImageResourceClass,
  {
    cpuMs: number;
    wallMs: number;
    memoryDeltaMiB: number;
    testedCandidates: number;
  }
>;

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function checkedProduct(left: number, right: number, label: string): number {
  if (left !== 0 && right > Number.MAX_SAFE_INTEGER / left) {
    throw new RangeError(`${label} must remain within the maximum safe integer.`);
  }
  return left * right;
}

function checkedSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError(`${label} must remain within the maximum safe integer.`);
    }
    total += value;
  }
  return total;
}

function getAttemptCaps(resourceClass: ImageResourceClass) {
  if (!Object.hasOwn(attemptCaps, resourceClass)) {
    throw new RangeError(`Unsupported image resource class: ${String(resourceClass)}.`);
  }
  const caps = attemptCaps[resourceClass];
  return caps;
}

export function estimateAttemptReservation(input: {
  inputBytes: number;
  resourceClass: ImageResourceClass;
}): number {
  assertNonNegativeSafeInteger(input.inputBytes, "inputBytes");
  const caps = getAttemptCaps(input.resourceClass);

  return checkedSum(
    [
      input.inputBytes,
      Math.max(0, input.inputBytes - 1),
      checkedProduct(
        IMAGE_OPTIMIZE_MAX_PIXELS,
        Math.max(...Object.values(contentCoefficient)),
        "pixel reservation",
      ),
      checkedProduct(caps.cpuMs, CPU_WEIGHT, "CPU reservation"),
      checkedProduct(caps.memoryDeltaMiB, caps.wallMs, "memory reservation"),
      checkedProduct(caps.testedCandidates, CANDIDATE_WEIGHT, "candidate reservation"),
      CONTROL_PLANE_BUDGET_UNITS,
    ],
    "attempt reservation",
  );
}

export function estimateImageOptimizeUnits(
  request: ImageOptimizeCreateRequestV1,
): ResourceEstimate {
  const inputBytes = request.input.byteLength;
  const reservedWeightedUnits = estimateAttemptReservation({
    inputBytes,
    resourceClass: "image-standard-v1",
  });

  return {
    resourceClass: "image-standard-v1",
    reservedWeightedUnits,
    inputBytes,
    reservationPixelCeiling: IMAGE_OPTIMIZE_MAX_PIXELS,
  };
}

function calculateMeasuredWeightedUnits(sample: ActualUsageSample): number {
  assertNonNegativeSafeInteger(sample.inputBytes, "inputBytes");
  if (sample.outputBytes !== null) {
    assertNonNegativeSafeInteger(sample.outputBytes, "outputBytes");
  }
  assertNonNegativeSafeInteger(sample.pixels, "pixels");
  assertNonNegativeSafeInteger(sample.cpuMs, "cpuMs");
  assertNonNegativeSafeInteger(sample.memoryByteMilliseconds, "memoryByteMilliseconds");
  assertNonNegativeSafeInteger(sample.testedCandidates, "testedCandidates");

  if (!Object.hasOwn(contentCoefficient, sample.mime)) {
    throw new RangeError(`Unsupported image MIME: ${String(sample.mime)}.`);
  }

  return checkedSum(
    [
      sample.inputBytes,
      sample.outputBytes ?? 0,
      checkedProduct(sample.pixels, contentCoefficient[sample.mime], "pixel usage"),
      checkedProduct(sample.cpuMs, CPU_WEIGHT, "CPU usage"),
      Math.ceil(sample.memoryByteMilliseconds / MEBIBYTE),
      checkedProduct(sample.testedCandidates, CANDIDATE_WEIGHT, "candidate usage"),
    ],
    "measured weighted units",
  );
}

export function calculateActualWeightedUnits(sample: ActualUsageSample): number {
  return checkedSum(
    [calculateMeasuredWeightedUnits(sample), CONTROL_PLANE_BUDGET_UNITS],
    "actual weighted units",
  );
}

export function calculateAttemptChargedUnits(sample: ActualUsageSample): number {
  return Math.max(calculateMeasuredWeightedUnits(sample), FAILED_ATTEMPT_MINIMUM_UNITS);
}

export function calculateSettledWeightedUnits(attempts: readonly ActualUsageSample[]): number {
  return checkedSum(
    [
      ...attempts.map((attempt) => calculateAttemptChargedUnits(attempt)),
      CONTROL_PLANE_BUDGET_UNITS,
    ],
    "settled weighted units",
  );
}
