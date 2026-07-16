import type { ImageOptimizeCreateRequestV1 } from "@hereisit/tool-contracts";
import { describe, expect, it } from "vitest";
import {
  calculateActualWeightedUnits,
  calculateAttemptChargedUnits,
  calculateSettledWeightedUnits,
  estimateAttemptReservation,
  estimateImageOptimizeUnits,
  PROCESSING_UNIT_COEFFICIENT_VERSION,
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
