import type {
  ImageOptimizeCreateRequestV1,
  PdfOptimizeCreateRequestV1,
} from "@hereisit/tool-contracts";
import { describe, expect, it } from "vitest";
import * as resourceEstimateModule from "./resource-estimate";
import {
  calculateActualWeightedUnits,
  calculateAttemptChargedUnits,
  calculateSettledWeightedUnits,
  estimateAttemptReservation,
  estimateImageOptimizeUnits,
  getEngineAttemptCaps,
  PROCESSING_UNIT_COEFFICIENT_VERSION,
  validateEngineAttempt,
} from "./resource-estimate";

const request: ImageOptimizeCreateRequestV1 = {
  jobContract: "tool-job@1",
  toolContract: "image.optimize@1",
  anonymousSessionId: "018f47a2-65d4-7f31-a377-5afbb8f53f27",
  clientRequestId: "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe",
  jobToken: "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA",
  input: {
    byteLength: 1_000_000,
    mimeHint: "image/jpeg",
    width: 4000,
    height: 3000,
  },
  spec: {
    version: 1,
    mode: "smart",
    preset: "balanced",
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  },
};

const pdfRequest: PdfOptimizeCreateRequestV1 = {
  contract: "tool-job@1",
  toolContract: "pdf.optimize@1",
  anonymousSessionId: "123e4567-e89b-42d3-a456-426614174000",
  clientRequestId: "7ba7b810-9dad-41d1-80b4-00c04fd430c8",
  jobToken: "b".repeat(43),
  input: {
    byteLength: 1_000_000,
    mime: "application/pdf",
    pageCount: 3,
  },
  spec: { version: 1, preset: "balanced" },
};

const expectedAttemptCaps = {
  "image-standard-v1": {
    cpuMs: 45_000,
    wallMs: 60_000,
    memoryBytes: 768 * 1024 * 1024,
    memoryByteMilliseconds: 768 * 1024 * 1024 * 60_000,
    testedCandidates: 3,
  },
  "image-large-v1": {
    cpuMs: 75_000,
    wallMs: 90_000,
    memoryBytes: 1536 * 1024 * 1024,
    memoryByteMilliseconds: 1536 * 1024 * 1024 * 90_000,
    testedCandidates: 3,
  },
} as const;

type ResourceClass = keyof typeof expectedAttemptCaps;

function validEngineAttempt(resourceClass: ResourceClass) {
  const caps = expectedAttemptCaps[resourceClass];

  return {
    inputBytes: 1_000_000,
    resourceClass,
    measurements: {
      processedInputBytes: 1_000_000,
      processedPixels: 40_000_000,
      cpuMs: caps.cpuMs,
      memoryByteMilliseconds: caps.memoryByteMilliseconds,
      peakMemoryBytes: caps.memoryBytes,
      testedCandidates: caps.testedCandidates,
      processingMs: caps.wallMs,
    },
    result: {
      kind: "download",
      mime: "image/jpeg",
      byteLength: 999_999,
      width: 4000,
      height: 3000,
      testedCandidates: 3,
      engineBuildId: "engine-1",
      codecBuildId: "codec-1",
      warnings: [],
    },
  } as const;
}

describe("image optimize reservations", () => {
  it("reserves the exact standard-attempt conservative maximum", () => {
    expect(estimateImageOptimizeUnits(request)).toEqual({
      resourceClass: "image-standard-v1",
      reservedWeightedUnits: 2_439_579_999,
      inputBytes: 1_000_000,
      reservationPixelCeiling: 40_000_000,
    });
  });

  it("never lets hostile dimension or MIME hints lower the reservation", () => {
    const tinyJpegHint = {
      ...request,
      input: { ...request.input, mimeHint: "image/jpeg", width: 1, height: 1 },
    } as ImageOptimizeCreateRequestV1;
    const hostileHints = {
      ...request,
      input: {
        ...request.input,
        mimeHint: "image/hostile",
        width: 0,
        height: 0,
      },
    } as unknown as ImageOptimizeCreateRequestV1;

    expect(estimateImageOptimizeUnits(tinyJpegHint).reservedWeightedUnits).toBe(2_439_579_999);
    expect(estimateImageOptimizeUnits(hostileHints).reservedWeightedUnits).toBe(2_439_579_999);
  });

  it("reserves one exact maximum for each resource class attempt", () => {
    expect(
      estimateAttemptReservation({
        inputBytes: 1_000_000,
        resourceClass: "image-standard-v1",
      }),
    ).toBe(2_439_579_999);
    expect(
      estimateAttemptReservation({
        inputBytes: 1_000_000,
        resourceClass: "image-large-v1",
      }),
    ).toBe(4_031_739_999);
  });

  it("publishes coefficient version one", () => {
    expect(PROCESSING_UNIT_COEFFICIENT_VERSION).toBe(1);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
  ])("rejects invalid attempt input bytes %s", (inputBytes) => {
    expect(() =>
      estimateAttemptReservation({ inputBytes, resourceClass: "image-standard-v1" }),
    ).toThrow();
  });

  it("rejects unknown resource classes and unsafe reservation arithmetic", () => {
    for (const resourceClass of ["image-medium-v1", "__proto__"]) {
      expect(() =>
        estimateAttemptReservation({
          inputBytes: 1,
          resourceClass,
        } as never),
      ).toThrow();
    }
    expect(() =>
      estimateAttemptReservation({
        inputBytes: Number.MAX_SAFE_INTEGER,
        resourceClass: "image-large-v1",
      }),
    ).toThrow("safe integer");
  });

  it("rejects invalid request byte counts while still treating hints as untrusted", () => {
    for (const byteLength of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() =>
        estimateImageOptimizeUnits({
          ...request,
          input: { ...request.input, byteLength },
        } as ImageOptimizeCreateRequestV1),
      ).toThrow();
    }
  });
});

describe("contract-discriminated reservations", () => {
  const estimateResources = () =>
    Reflect.get(resourceEstimateModule, "estimateResources") as
      | ((request: ImageOptimizeCreateRequestV1 | PdfOptimizeCreateRequestV1) => unknown)
      | undefined;

  it("preserves the exact image reservation through the shared boundary", () => {
    expect(estimateResources()?.(request)).toEqual(estimateImageOptimizeUnits(request));
  });

  it("reserves a bounded PDF with its own resource class", () => {
    expect(estimateResources()?.(pdfRequest)).toEqual({
      resourceClass: "pdf-standard-v1",
      reservedWeightedUnits: 2_439_579_999,
      inputBytes: 1_000_000,
      reservationPageCeiling: 100,
    });
  });

  it("rejects PDF page and byte limits at the shared boundary", () => {
    const estimate = estimateResources();
    expect(() =>
      estimate?.({
        ...pdfRequest,
        input: { ...pdfRequest.input, pageCount: 101 },
      } as PdfOptimizeCreateRequestV1),
    ).toThrow();
    expect(() =>
      estimate?.({
        ...pdfRequest,
        input: { ...pdfRequest.input, byteLength: 50 * 1024 * 1024 + 1 },
      } as PdfOptimizeCreateRequestV1),
    ).toThrow();
  });
});

describe("engine attempt validation", () => {
  it.each([
    "image-standard-v1",
    "image-large-v1",
  ] as const)("publishes exact immutable %s caps", (resourceClass) => {
    const caps = getEngineAttemptCaps(resourceClass);

    expect(caps).toEqual(expectedAttemptCaps[resourceClass]);
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it.each([
    "image-standard-v1",
    "image-large-v1",
  ] as const)("accepts every exact %s boundary", (resourceClass) => {
    expect(validateEngineAttempt(validEngineAttempt(resourceClass))).toEqual({ valid: true });
  });

  it.each([
    ["image-standard-v1", "cpuMs", "CPU_MS_EXCEEDED"],
    ["image-large-v1", "cpuMs", "CPU_MS_EXCEEDED"],
    ["image-standard-v1", "processingMs", "PROCESSING_MS_EXCEEDED"],
    ["image-large-v1", "processingMs", "PROCESSING_MS_EXCEEDED"],
    ["image-standard-v1", "peakMemoryBytes", "PEAK_MEMORY_BYTES_EXCEEDED"],
    ["image-large-v1", "peakMemoryBytes", "PEAK_MEMORY_BYTES_EXCEEDED"],
    ["image-standard-v1", "memoryByteMilliseconds", "MEMORY_BYTE_MILLISECONDS_EXCEEDED"],
    ["image-large-v1", "memoryByteMilliseconds", "MEMORY_BYTE_MILLISECONDS_EXCEEDED"],
  ] as const)("rejects %s %s above its class cap", (resourceClass, field, expectedCode) => {
    const attempt = validEngineAttempt(resourceClass);
    const result = validateEngineAttempt({
      ...attempt,
      measurements: {
        ...attempt.measurements,
        [field]: attempt.measurements[field] + 1,
      },
    });

    expect(result).toMatchObject({
      valid: false,
      error: {
        code: expectedCode,
        field,
      },
    });
  });

  it.each([
    ["image-standard-v1", "processedInputBytes", 1_000_001, "PROCESSED_INPUT_BYTES_EXCEEDED"],
    ["image-large-v1", "processedInputBytes", 1_000_001, "PROCESSED_INPUT_BYTES_EXCEEDED"],
    ["image-standard-v1", "processedPixels", 40_000_001, "PROCESSED_PIXELS_EXCEEDED"],
    ["image-large-v1", "processedPixels", 40_000_001, "PROCESSED_PIXELS_EXCEEDED"],
    ["image-standard-v1", "testedCandidates", 4, "TESTED_CANDIDATES_EXCEEDED"],
    ["image-large-v1", "testedCandidates", 4, "TESTED_CANDIDATES_EXCEEDED"],
  ] as const)("rejects %s universal %s cap", (resourceClass, field, value, expectedCode) => {
    const attempt = validEngineAttempt(resourceClass);
    const result = validateEngineAttempt({
      ...attempt,
      measurements: {
        ...attempt.measurements,
        [field]: value,
      },
    });

    expect(result).toMatchObject({
      valid: false,
      error: {
        code: expectedCode,
        field,
      },
    });
  });

  it.each([
    "image-standard-v1",
    "image-large-v1",
  ] as const)("requires %s download output to be strictly smaller", (resourceClass) => {
    const attempt = validEngineAttempt(resourceClass);
    const result = validateEngineAttempt({
      ...attempt,
      result: {
        ...attempt.result,
        byteLength: attempt.inputBytes,
      },
    });

    expect(result).toMatchObject({
      valid: false,
      error: {
        code: "OUTPUT_NOT_SMALLER",
        field: "result.byteLength",
        actual: 1_000_000,
        maximum: 999_999,
      },
    });
  });

  it("rejects invalid numeric measurements with a normalized validation error", () => {
    const attempt = validEngineAttempt("image-standard-v1");
    const result = validateEngineAttempt({
      ...attempt,
      measurements: {
        ...attempt.measurements,
        cpuMs: Number.MAX_SAFE_INTEGER + 1,
      },
    });

    expect(result).toMatchObject({
      valid: false,
      error: {
        code: "INVALID_MEASUREMENT",
        field: "cpuMs",
      },
    });
  });
});

describe("actual weighted units", () => {
  it("computes exact v1 units from raw engine measurements", () => {
    expect(
      calculateActualWeightedUnits({
        inputBytes: 1_000_000,
        outputBytes: 600_000,
        pixels: 12_000_000,
        cpuMs: 1000,
        memoryByteMilliseconds: 512 * 1024 * 1024 * 1000,
        testedCandidates: 2,
        mime: "image/jpeg",
      }),
    ).toBe(97_112_000);
  });

  it("treats a null output as zero and rounds memory units upward", () => {
    expect(
      calculateActualWeightedUnits({
        inputBytes: 0,
        outputBytes: null,
        pixels: 0,
        cpuMs: 0,
        memoryByteMilliseconds: 1,
        testedCandidates: 0,
        mime: "image/png",
      }),
    ).toBe(20_000_001);
  });

  it("applies the failure floor to each attempt and the control-plane budget once", () => {
    const belowFloorAttempt = {
      inputBytes: 0,
      outputBytes: null,
      pixels: 0,
      cpuMs: 0,
      memoryByteMilliseconds: 0,
      testedCandidates: 0,
      mime: "image/jpeg",
    } as const;
    const aboveFloorAttempt = {
      ...belowFloorAttempt,
      inputBytes: 3_000_000,
    };

    expect(calculateAttemptChargedUnits(belowFloorAttempt)).toBe(2_000_000);
    expect(calculateAttemptChargedUnits(aboveFloorAttempt)).toBe(3_000_000);
    expect(calculateSettledWeightedUnits([belowFloorAttempt, aboveFloorAttempt])).toBe(25_000_000);

    const aggregateThenFloor =
      20_000_000 +
      Math.max(
        calculateActualWeightedUnits({
          ...aboveFloorAttempt,
          outputBytes: null,
        }) - 20_000_000,
        2 * 2_000_000,
      );
    expect(aggregateThenFloor).toBe(24_000_000);
  });

  it("does not duplicate the control-plane budget across attempts", () => {
    const emptyAttempt = {
      inputBytes: 0,
      outputBytes: null,
      pixels: 0,
      cpuMs: 0,
      memoryByteMilliseconds: 0,
      testedCandidates: 0,
      mime: "image/png",
    } as const;

    expect(calculateSettledWeightedUnits([emptyAttempt, emptyAttempt])).toBe(24_000_000);
  });

  it.each([
    ["inputBytes", Number.NaN],
    ["inputBytes", Number.POSITIVE_INFINITY],
    ["inputBytes", -1],
    ["inputBytes", 1.5],
    ["outputBytes", -1],
    ["pixels", 1.5],
    ["cpuMs", -1],
    ["memoryByteMilliseconds", Number.POSITIVE_INFINITY],
    ["testedCandidates", -1],
  ])("rejects invalid %s %s", (field, value) => {
    expect(() =>
      calculateActualWeightedUnits({
        inputBytes: 1,
        outputBytes: 0,
        pixels: 1,
        cpuMs: 1,
        memoryByteMilliseconds: 1,
        testedCandidates: 1,
        mime: "image/webp",
        [field]: value,
      }),
    ).toThrow();
  });

  it("rejects unknown MIME classes and arithmetic beyond safe integers", () => {
    expect(() =>
      calculateActualWeightedUnits({
        inputBytes: 1,
        outputBytes: 0,
        pixels: 1,
        cpuMs: 1,
        memoryByteMilliseconds: 1,
        testedCandidates: 1,
        mime: "image/gif",
      } as never),
    ).toThrow();
    expect(() =>
      calculateActualWeightedUnits({
        inputBytes: Number.MAX_SAFE_INTEGER,
        outputBytes: 0,
        pixels: 0,
        cpuMs: 0,
        memoryByteMilliseconds: 0,
        testedCandidates: 0,
        mime: "image/jpeg",
      }),
    ).toThrow("safe integer");
  });
});
