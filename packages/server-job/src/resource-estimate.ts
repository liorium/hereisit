import {
  type EngineMeasurements,
  type EngineResult,
  IMAGE_ENGINE_MAX_TESTED_CANDIDATES,
  type ImageResourceClass,
} from "@hereisit/server-contracts";
import {
  IMAGE_OPTIMIZE_MAX_PIXELS,
  type ImageOptimizeCreateRequestV1,
  type ImageOptimizeMime,
  imageOptimizeCreateRequestSchema,
  PDF_OPTIMIZE_MAX_PAGES,
  type PdfOptimizeCreateRequestV1,
  type PdfOptimizeMime,
  pdfOptimizeCreateRequestSchema,
} from "@hereisit/tool-contracts";

export interface ResourceEstimate {
  resourceClass: "image-standard-v1";
  reservedWeightedUnits: number;
  inputBytes: number;
  reservationPixelCeiling: 40_000_000;
}

export interface PdfResourceEstimate {
  resourceClass: "pdf-standard-v1";
  reservedWeightedUnits: number;
  inputBytes: number;
  reservationPageCeiling: 100;
}

export type ToolResourceEstimate = ResourceEstimate | PdfResourceEstimate;

export interface ActualUsageSample {
  inputBytes: number;
  outputBytes: number | null;
  pixels: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  testedCandidates: number;
  mime: ImageOptimizeMime | PdfOptimizeMime;
}

export interface EngineAttemptCaps {
  cpuMs: number;
  wallMs: number;
  memoryBytes: number;
  memoryByteMilliseconds: number;
  testedCandidates: typeof IMAGE_ENGINE_MAX_TESTED_CANDIDATES;
}

export type EngineAttemptValidationErrorCode =
  | "INVALID_MEASUREMENT"
  | "PROCESSED_INPUT_BYTES_EXCEEDED"
  | "PROCESSED_PIXELS_EXCEEDED"
  | "CPU_MS_EXCEEDED"
  | "PROCESSING_MS_EXCEEDED"
  | "PEAK_MEMORY_BYTES_EXCEEDED"
  | "MEMORY_BYTE_MILLISECONDS_EXCEEDED"
  | "TESTED_CANDIDATES_EXCEEDED"
  | "OUTPUT_NOT_SMALLER";

export interface EngineAttemptValidationError {
  code: EngineAttemptValidationErrorCode;
  field: keyof EngineMeasurements | "inputBytes" | "result.byteLength" | "result.testedCandidates";
  actual: number;
  maximum: number;
}

export type EngineAttemptValidationResult =
  | { valid: true }
  | {
      valid: false;
      error: EngineAttemptValidationError;
    };

export interface EngineAttemptValidationInput {
  inputBytes: number;
  resourceClass: ImageResourceClass;
  measurements: EngineMeasurements;
  result: EngineResult | null;
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
  "application/pdf": 1,
} as const satisfies Record<ImageOptimizeMime | PdfOptimizeMime, number>;

function createEngineAttemptCaps(
  cpuMs: number,
  wallMs: number,
  memoryMiB: number,
): Readonly<EngineAttemptCaps> {
  const memoryBytes = checkedProduct(memoryMiB, MEBIBYTE, "engine memory bytes");

  return Object.freeze({
    cpuMs,
    wallMs,
    memoryBytes,
    memoryByteMilliseconds: checkedProduct(memoryBytes, wallMs, "engine memory byte milliseconds"),
    testedCandidates: IMAGE_ENGINE_MAX_TESTED_CANDIDATES,
  });
}

const engineAttemptCaps: Readonly<Record<ImageResourceClass, Readonly<EngineAttemptCaps>>> =
  Object.freeze({
    "image-standard-v1": createEngineAttemptCaps(45_000, 60_000, 768),
    "image-large-v1": createEngineAttemptCaps(75_000, 90_000, 1536),
  });

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

export function getEngineAttemptCaps(
  resourceClass: ImageResourceClass,
): Readonly<EngineAttemptCaps> {
  if (!Object.hasOwn(engineAttemptCaps, resourceClass)) {
    throw new RangeError(`Unsupported image resource class: ${String(resourceClass)}.`);
  }
  return engineAttemptCaps[resourceClass];
}

function invalidEngineAttempt(
  code: EngineAttemptValidationErrorCode,
  field: EngineAttemptValidationError["field"],
  actual: number,
  maximum: number,
): EngineAttemptValidationResult {
  return {
    valid: false,
    error: {
      code,
      field,
      actual,
      maximum,
    },
  };
}

function invalidSafeInteger(
  field: EngineAttemptValidationError["field"],
  value: number,
): EngineAttemptValidationResult | null {
  if (!Number.isSafeInteger(value) || value < 0) {
    return invalidEngineAttempt("INVALID_MEASUREMENT", field, value, Number.MAX_SAFE_INTEGER);
  }
  return null;
}

export function validateEngineAttempt(
  input: EngineAttemptValidationInput,
): EngineAttemptValidationResult {
  const inputError = invalidSafeInteger("inputBytes", input.inputBytes);
  if (inputError !== null || input.inputBytes === 0) {
    return (
      inputError ?? invalidEngineAttempt("INVALID_MEASUREMENT", "inputBytes", input.inputBytes, 0)
    );
  }

  for (const field of [
    "processedInputBytes",
    "processedPixels",
    "cpuMs",
    "memoryByteMilliseconds",
    "peakMemoryBytes",
    "testedCandidates",
    "processingMs",
  ] as const satisfies readonly (keyof EngineMeasurements)[]) {
    const measurementError = invalidSafeInteger(field, input.measurements[field]);
    if (measurementError !== null) {
      return measurementError;
    }
  }

  const caps = getEngineAttemptCaps(input.resourceClass);
  const limits = [
    [
      "PROCESSED_INPUT_BYTES_EXCEEDED",
      "processedInputBytes",
      input.measurements.processedInputBytes,
      input.inputBytes,
    ],
    [
      "PROCESSED_PIXELS_EXCEEDED",
      "processedPixels",
      input.measurements.processedPixels,
      IMAGE_OPTIMIZE_MAX_PIXELS,
    ],
    ["CPU_MS_EXCEEDED", "cpuMs", input.measurements.cpuMs, caps.cpuMs],
    ["PROCESSING_MS_EXCEEDED", "processingMs", input.measurements.processingMs, caps.wallMs],
    [
      "PEAK_MEMORY_BYTES_EXCEEDED",
      "peakMemoryBytes",
      input.measurements.peakMemoryBytes,
      caps.memoryBytes,
    ],
    [
      "MEMORY_BYTE_MILLISECONDS_EXCEEDED",
      "memoryByteMilliseconds",
      input.measurements.memoryByteMilliseconds,
      caps.memoryByteMilliseconds,
    ],
    [
      "TESTED_CANDIDATES_EXCEEDED",
      "testedCandidates",
      input.measurements.testedCandidates,
      caps.testedCandidates,
    ],
  ] as const;

  for (const [code, field, actual, maximum] of limits) {
    if (actual > maximum) {
      return invalidEngineAttempt(code, field, actual, maximum);
    }
  }

  if (input.result !== null) {
    const resultCandidatesError = invalidSafeInteger(
      "result.testedCandidates",
      input.result.testedCandidates,
    );
    if (resultCandidatesError !== null) {
      return resultCandidatesError;
    }
    if (input.result.testedCandidates > caps.testedCandidates) {
      return invalidEngineAttempt(
        "TESTED_CANDIDATES_EXCEEDED",
        "result.testedCandidates",
        input.result.testedCandidates,
        caps.testedCandidates,
      );
    }
  }

  if (input.result?.kind === "download") {
    const outputError = invalidSafeInteger("result.byteLength", input.result.byteLength);
    if (outputError !== null) {
      return outputError;
    }
    if (input.result.byteLength >= input.inputBytes) {
      return invalidEngineAttempt(
        "OUTPUT_NOT_SMALLER",
        "result.byteLength",
        input.result.byteLength,
        input.inputBytes - 1,
      );
    }
  }

  return { valid: true };
}

export function estimateAttemptReservation(input: {
  inputBytes: number;
  resourceClass: ImageResourceClass;
}): number {
  assertNonNegativeSafeInteger(input.inputBytes, "inputBytes");
  const caps = getEngineAttemptCaps(input.resourceClass);

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
      checkedProduct(caps.memoryBytes / MEBIBYTE, caps.wallMs, "memory reservation"),
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

export function estimatePdfOptimizeUnits(request: PdfOptimizeCreateRequestV1): PdfResourceEstimate {
  const parsed = pdfOptimizeCreateRequestSchema.parse(request);
  const inputBytes = parsed.input.byteLength;

  return {
    resourceClass: "pdf-standard-v1",
    reservedWeightedUnits: estimateAttemptReservation({
      inputBytes,
      resourceClass: "image-standard-v1",
    }),
    inputBytes,
    reservationPageCeiling: PDF_OPTIMIZE_MAX_PAGES,
  };
}

export function estimateResources(
  request: ImageOptimizeCreateRequestV1 | PdfOptimizeCreateRequestV1,
): ToolResourceEstimate {
  return request.toolContract === "pdf.optimize@1"
    ? estimatePdfOptimizeUnits(request)
    : estimateImageOptimizeUnits(imageOptimizeCreateRequestSchema.parse(request));
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
    throw new RangeError(`Unsupported processing MIME: ${String(sample.mime)}.`);
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
