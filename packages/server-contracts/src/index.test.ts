import { describe, expect, it } from "vitest";
import type { ImageEngineJobStatus } from "./index";
import {
  anyEngineCreateJobRequestSchema,
  engineCreateJobRequestSchema,
  engineJobStatusSchema,
  imageContentClassSchema,
  imageJobMessageSchema,
  serverEngineJobStatusSchema,
  serverJobMessageSchema,
} from "./index";

const jobId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const queueEpoch = "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe";
const inputObjectId = "550e8400-e29b-41d4-a716-446655440000";
const outputObjectId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const specHash = "a".repeat(64);

const spec = {
  version: 1,
  mode: "smart",
  preset: "balanced",
  output: "same-format",
  metadata: "strip",
  orientation: "apply",
  colorSpace: "srgb",
  minimumSavingsPercent: 1,
} as const;

const measurements = {
  processedInputBytes: 1_000_000,
  processedPixels: 12_000_000,
  cpuMs: 1000,
  memoryByteMilliseconds: 512 * 1024 * 1024 * 1000,
  peakMemoryBytes: 512 * 1024 * 1024,
  testedCandidates: 2,
  processingMs: 1100,
} as const;

const inspection = {
  verifiedInputMime: "image/jpeg",
  inputHasAlpha: false,
  contentClass: "photo",
} as const;

function createEngineRequest(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    jobId,
    attempt: 1,
    tool: "image.optimize",
    toolVersion: 1,
    spec,
    specHash,
    input: {
      byteLength: 1_000_000,
      etag: "input-etag",
      mimeHint: "image/jpeg",
    },
    resourceClass: "image-standard-v1",
    ...overrides,
  };
}

function createMessage(overrides: Record<string, unknown> = {}) {
  return {
    jobId,
    contractId: "image.optimize@1",
    specHash,
    inputKey: `inputs/${inputObjectId}`,
    inputEtag: "input-etag",
    outputKey: `outputs/${outputObjectId}`,
    resourceClass: "image-standard-v1",
    attempt: 1,
    queueEpoch,
    queueGeneration: 0,
    ...overrides,
  };
}

function succeededStatus(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    jobId,
    state: "succeeded",
    phase: "preparing-output",
    fraction: 1,
    sequence: 8,
    result: {
      kind: "download",
      mime: "image/jpeg",
      byteLength: 600_000,
      width: 4000,
      height: 3000,
      testedCandidates: 2,
      engineBuildId: "engine-1",
      codecBuildId: "codec-1",
      warnings: [],
    },
    inspection,
    measurements,
    ...overrides,
  };
}

function failedStatus(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    jobId,
    state: "failed",
    phase: "optimizing",
    fraction: 0.5,
    sequence: 7,
    measurements,
    inspection,
    error: {
      code: "ENGINE_TIMEOUT",
      retryable: true,
      guidance: "TRY_BALANCED_PRESET",
    },
    ...overrides,
  };
}

function cancelledStatus(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    jobId,
    state: "cancelled",
    phase: null,
    fraction: null,
    sequence: 7,
    measurements,
    inspection,
    error: {
      code: "CANCELLED",
      retryable: false,
    },
    ...overrides,
  };
}

describe("internal server messages", () => {
  it("accepts all exact attempts and resource classes", () => {
    for (const attempt of [1, 2, 3]) {
      for (const resourceClass of ["image-standard-v1", "image-large-v1"]) {
        expect(
          imageJobMessageSchema.safeParse(createMessage({ attempt, resourceClass })).success,
        ).toBe(true);
        expect(
          engineCreateJobRequestSchema.safeParse(createEngineRequest({ attempt, resourceClass }))
            .success,
        ).toBe(true);
      }
    }
  });

  it.each([0, 4])("rejects attempt %s", (attempt) => {
    expect(imageJobMessageSchema.safeParse(createMessage({ attempt })).success).toBe(false);
    expect(engineCreateJobRequestSchema.safeParse(createEngineRequest({ attempt })).success).toBe(
      false,
    );
  });

  it.each([
    "image-small-v1",
    "image-standard-v2",
    "image-large-v2",
  ])("rejects resource class %s", (resourceClass) => {
    expect(imageJobMessageSchema.safeParse(createMessage({ resourceClass })).success).toBe(false);
    expect(
      engineCreateJobRequestSchema.safeParse(createEngineRequest({ resourceClass })).success,
    ).toBe(false);
  });

  it.each([
    ["a filename", { filename: "private.jpg" }],
    ["an input URL", { inputUrl: "https://example.invalid/private" }],
    ["a result URL", { resultUrl: "https://example.invalid/private" }],
    ["a token", { jobToken: "secret" }],
    ["an unknown field", { internalNote: "secret" }],
  ])("rejects %s on queue messages and engine requests", (_case, unknownField) => {
    expect(imageJobMessageSchema.safeParse(createMessage(unknownField)).success).toBe(false);
    expect(engineCreateJobRequestSchema.safeParse(createEngineRequest(unknownField)).success).toBe(
      false,
    );
  });

  it.each([
    ["a non-UUID job ID", { jobId: "job-1" }],
    ["a non-UUID queue epoch", { queueEpoch: "epoch-1" }],
    ["a short spec hash", { specHash: "abc123" }],
    ["a non-hex spec hash", { specHash: "z".repeat(64) }],
    ["an input key outside the opaque namespace", { inputKey: `private/${inputObjectId}` }],
    ["an input key without a UUID", { inputKey: "inputs/private.jpg" }],
    ["an output key outside the opaque namespace", { outputKey: `results/${outputObjectId}` }],
    ["an output key without a UUID", { outputKey: "outputs/private.jpg" }],
    ["an ETag with a newline", { inputEtag: "etag\nsecret" }],
    ["an unbounded ETag", { inputEtag: "a".repeat(257) }],
  ])("rejects queue message with %s", (_case, override) => {
    expect(imageJobMessageSchema.safeParse(createMessage(override)).success).toBe(false);
  });

  it.each([
    ["a non-UUID job ID", { jobId: "job-1" }],
    ["a short spec hash", { specHash: "abc123" }],
    ["a non-hex spec hash", { specHash: "z".repeat(64) }],
    [
      "an ETag with a control character",
      {
        input: {
          byteLength: 1_000_000,
          etag: "etag\u0000secret",
          mimeHint: "image/jpeg",
        },
      },
    ],
    [
      "an unbounded ETag",
      {
        input: {
          byteLength: 1_000_000,
          etag: "a".repeat(257),
          mimeHint: "image/jpeg",
        },
      },
    ],
  ])("rejects engine request with %s", (_case, override) => {
    expect(engineCreateJobRequestSchema.safeParse(createEngineRequest(override)).success).toBe(
      false,
    );
  });

  it.each([
    ["filename", "private.jpg"],
    ["url", "https://example.invalid/private"],
    ["token", "secret"],
    ["unknown", "value"],
  ])("rejects nested engine input field %s", (field, value) => {
    expect(
      engineCreateJobRequestSchema.safeParse(
        createEngineRequest({
          input: {
            byteLength: 1_000_000,
            etag: "input-etag",
            mimeHint: "image/jpeg",
            [field]: value,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("does not expose monetary coefficients to the engine", () => {
    expect(
      engineCreateJobRequestSchema.safeParse(
        createEngineRequest({ processingUnitCoefficientVersion: 1 }),
      ).success,
    ).toBe(false);
    expect(
      engineCreateJobRequestSchema.safeParse(
        createEngineRequest({ reservedWeightedUnits: 2_439_579_999 }),
      ).success,
    ).toBe(false);
    expect(
      engineJobStatusSchema.safeParse({
        ...failedStatus(),
        measurements: { ...measurements, actualWeightedUnits: 97_112_000 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["negative queue generation", { queueGeneration: -1 }],
    ["fractional queue generation", { queueGeneration: 1.5 }],
    ["non-finite queue generation", { queueGeneration: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_case, override) => {
    expect(imageJobMessageSchema.safeParse(createMessage(override)).success).toBe(false);
  });

  it.each([
    ["zero input bytes", { byteLength: 0 }],
    ["negative input bytes", { byteLength: -1 }],
    ["fractional input bytes", { byteLength: 1.5 }],
    ["unsafe input bytes", { byteLength: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_case, inputOverride) => {
    expect(
      engineCreateJobRequestSchema.safeParse(
        createEngineRequest({
          input: {
            etag: "input-etag",
            mimeHint: "image/jpeg",
            ...inputOverride,
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("engine job status protocol", () => {
  it.each([
    "photo",
    "screenshot-text",
    "flat-graphic",
    "transparent-graphic",
    "noisy",
    "already-optimized",
  ])("accepts content class %s", (contentClass) => {
    expect(imageContentClassSchema.safeParse(contentClass).success).toBe(true);
  });

  it("rejects content classes outside the shared closed union", () => {
    expect(imageContentClassSchema.safeParse("illustration").success).toBe(false);
  });

  it.each([
    ["created", null, null],
    ["uploading", null, null],
    ["ready", null, null],
    ["running", "validating", null],
    ["running", "optimizing", 0.25],
  ])("accepts a valid %s status", (state, phase, fraction) => {
    expect(
      engineJobStatusSchema.safeParse({
        protocol: 1,
        jobId,
        state,
        phase,
        fraction,
        sequence: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts both successful result kinds", () => {
    expect(engineJobStatusSchema.safeParse(succeededStatus()).success).toBe(true);
    expect(
      engineJobStatusSchema.safeParse(
        succeededStatus({
          result: {
            kind: "original-retained",
            testedCandidates: 2,
            engineBuildId: "engine-1",
            codecBuildId: "codec-1",
            warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a download at the exact 40 MP boundary", () => {
    expect(
      engineJobStatusSchema.safeParse(
        succeededStatus({
          result: {
            ...succeededStatus().result,
            width: 8000,
            height: 5000,
          },
          measurements: {
            ...measurements,
            processedPixels: 40_000_000,
          },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["a download over 40 MP", 8000, 5001],
    ["an unsafe dimension product", Number.MAX_SAFE_INTEGER, 2],
  ])("rejects %s without unsafe multiplication", (_case, width, height) => {
    expect(
      engineJobStatusSchema.safeParse(
        succeededStatus({
          result: {
            ...succeededStatus().result,
            width,
            height,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("requires the download MIME to match verified inspection MIME", () => {
    expect(
      engineJobStatusSchema.safeParse(
        succeededStatus({
          result: {
            ...succeededStatus().result,
            mime: "image/png",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it.each([
    [
      "download success",
      succeededStatus({
        result: {
          ...succeededStatus().result,
          testedCandidates: 4,
        },
        measurements: {
          ...measurements,
          testedCandidates: 4,
        },
      }),
    ],
    [
      "original-retained success",
      succeededStatus({
        result: {
          kind: "original-retained",
          testedCandidates: 4,
          engineBuildId: "engine-1",
          codecBuildId: "codec-1",
          warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
        },
        measurements: {
          ...measurements,
          testedCandidates: 4,
        },
      }),
    ],
    [
      "failure",
      failedStatus({
        measurements: {
          ...measurements,
          testedCandidates: 4,
        },
      }),
    ],
    [
      "cancellation",
      cancelledStatus({
        measurements: {
          ...measurements,
          testedCandidates: 4,
        },
      }),
    ],
  ])("rejects four tested candidates for %s", (_case, status) => {
    expect(engineJobStatusSchema.safeParse(status).success).toBe(false);
  });

  it.each([
    [
      "failure processed pixels",
      failedStatus({
        measurements: {
          ...measurements,
          processedPixels: 40_000_001,
        },
      }),
    ],
    [
      "cancelled processed pixels",
      cancelledStatus({
        measurements: {
          ...measurements,
          processedPixels: 40_000_001,
        },
      }),
    ],
    [
      "failure processed input bytes",
      failedStatus({
        measurements: {
          ...measurements,
          processedInputBytes: 30 * 1024 * 1024 + 1,
        },
      }),
    ],
    [
      "cancelled processed input bytes",
      cancelledStatus({
        measurements: {
          ...measurements,
          processedInputBytes: 30 * 1024 * 1024 + 1,
        },
      }),
    ],
  ])("rejects universal measurement limit breach for %s", (_case, status) => {
    expect(engineJobStatusSchema.safeParse(status).success).toBe(false);
  });

  it.each([
    ["download", { ...succeededStatus().result, testedCandidates: 1 }],
    [
      "original-retained",
      {
        kind: "original-retained",
        testedCandidates: 1,
        engineBuildId: "engine-1",
        codecBuildId: "codec-1",
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
      },
    ],
  ])("requires %s candidate count to equal measurements", (_kind, result) => {
    expect(engineJobStatusSchema.safeParse(succeededStatus({ result })).success).toBe(false);
  });

  it("requires failed measurements and accepts every measurement at zero", () => {
    const zeroMeasurements = {
      processedInputBytes: 0,
      processedPixels: 0,
      cpuMs: 0,
      memoryByteMilliseconds: 0,
      peakMemoryBytes: 0,
      testedCandidates: 0,
      processingMs: 0,
    };

    expect(
      engineJobStatusSchema.safeParse(
        failedStatus({ measurements: zeroMeasurements, inspection: null }),
      ).success,
    ).toBe(true);
    const { measurements: _measurements, ...withoutMeasurements } = failedStatus();
    expect(engineJobStatusSchema.safeParse(withoutMeasurements).success).toBe(false);
  });

  it("accepts cancelled measurements at zero", () => {
    expect(
      engineJobStatusSchema.safeParse(
        cancelledStatus({
          sequence: 4,
          measurements: {
            processedInputBytes: 0,
            processedPixels: 0,
            cpuMs: 0,
            memoryByteMilliseconds: 0,
            peakMemoryBytes: 0,
            testedCandidates: 0,
            processingMs: 0,
          },
          inspection: null,
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["negative sequence", -1],
    ["fractional sequence", 1.5],
    ["non-finite sequence", Number.POSITIVE_INFINITY],
    ["unsafe sequence", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s", (_case, sequence) => {
    expect(engineJobStatusSchema.safeParse(failedStatus({ sequence })).success).toBe(false);
  });

  it.each([
    ["processedInputBytes", -1],
    ["processedPixels", -1],
    ["cpuMs", -1],
    ["memoryByteMilliseconds", -1],
    ["peakMemoryBytes", -1],
    ["testedCandidates", -1],
    ["processingMs", -1],
    ["processedInputBytes", 1.5],
    ["cpuMs", Number.POSITIVE_INFINITY],
    ["peakMemoryBytes", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid %s measurement %s", (field, value) => {
    expect(
      engineJobStatusSchema.safeParse(
        failedStatus({ measurements: { ...measurements, [field]: value } }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["negative running fraction", { state: "running", phase: "optimizing", fraction: -0.01 }],
    ["oversized running fraction", { state: "running", phase: "optimizing", fraction: 1.01 }],
    [
      "non-finite running fraction",
      { state: "running", phase: "optimizing", fraction: Number.NaN },
    ],
    ["a phase on ready", { state: "ready", phase: "validating", fraction: null }],
    ["a fraction on uploading", { state: "uploading", phase: null, fraction: 0 }],
    ["a null running phase", { state: "running", phase: null, fraction: null }],
    ["a non-terminal success fraction", { fraction: 0.99 }],
  ])("rejects %s", (_case, override) => {
    const candidate =
      "result" in override || !("state" in override)
        ? succeededStatus(override)
        : {
            protocol: 1,
            jobId,
            sequence: 2,
            ...override,
          };
    expect(engineJobStatusSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ["a filename", { filename: "private.jpg" }],
    ["an output URL", { outputUrl: "https://example.invalid/private" }],
    ["a token", { token: "secret" }],
    ["an unknown field", { workerNote: "secret" }],
  ])("rejects %s on status messages", (_case, unknownField) => {
    expect(engineJobStatusSchema.safeParse(succeededStatus(unknownField)).success).toBe(false);
  });

  it("requires a UUID job ID on every engine status", () => {
    expect(engineJobStatusSchema.safeParse(failedStatus({ jobId: "job-1" })).success).toBe(false);
  });

  it("rejects secret or location fields nested in results and errors", () => {
    expect(
      engineJobStatusSchema.safeParse({
        ...succeededStatus(),
        result: {
          ...succeededStatus().result,
          outputUrl: "https://example.invalid/private",
        },
      }).success,
    ).toBe(false);
    expect(
      engineJobStatusSchema.safeParse({
        ...failedStatus(),
        error: {
          code: "ENGINE_TIMEOUT",
          retryable: true,
          token: "secret",
        },
      }).success,
    ).toBe(false);
  });
});

describe("PDF engine contract branch", () => {
  it("accepts a strict PDF create request without image fields", () => {
    expect(
      anyEngineCreateJobRequestSchema.safeParse({
        protocol: 1,
        jobId,
        attempt: 1,
        tool: "pdf.optimize",
        toolVersion: 1,
        spec: { version: 1, preset: "balanced" },
        specHash,
        input: {
          byteLength: 1_000,
          etag: "input-etag",
          mimeHint: "application/pdf",
          pageCount: 3,
        },
        resourceClass: "pdf-standard-v1",
      }).success,
    ).toBe(true);
  });

  it("accepts a PDF terminal status and rejects image-only fields", () => {
    const status = {
      protocol: 1,
      jobId,
      state: "succeeded",
      phase: "preparing-output",
      fraction: 1,
      sequence: 8,
      result: {
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 1_000,
        byteLength: 990,
        pageCount: 3,
        profile: "structural",
        engineBuildId: "qpdf-12.4.0",
        warnings: ["SIGNATURES_INVALIDATED"],
      },
      measurements: {
        processedInputBytes: 1_000,
        cpuMs: 1000,
        memoryByteMilliseconds: 512 * 1024 * 1024 * 1000,
        peakMemoryBytes: 512 * 1024 * 1024,
        testedCandidates: 1,
        processingMs: 1100,
      },
      inspection: {
        verifiedInputMime: "application/pdf",
        verifiedPageCount: 3,
        encrypted: false,
      },
    };

    expect(serverEngineJobStatusSchema.safeParse({ tool: "pdf.optimize", status }).success).toBe(
      true,
    );
    expect(
      serverEngineJobStatusSchema.safeParse({
        tool: "pdf.optimize",
        status: { ...status, result: { ...status.result, width: 4000 } },
      }).success,
    ).toBe(false);
  });

  it("requires a matching tool discriminator around every server engine status", () => {
    const pdfStatus = {
      protocol: 1,
      jobId,
      state: "running",
      phase: "optimizing",
      fraction: 0.5,
      sequence: 7,
    };
    const imageStatus = succeededStatus();

    expect(
      serverEngineJobStatusSchema.safeParse({ tool: "pdf.optimize", status: pdfStatus }).success,
    ).toBe(true);
    expect(
      serverEngineJobStatusSchema.safeParse({ tool: "image.optimize", status: imageStatus })
        .success,
    ).toBe(true);
    expect(serverEngineJobStatusSchema.safeParse({ status: pdfStatus }).success).toBe(false);
    expect(
      serverEngineJobStatusSchema.safeParse({ tool: "pdf.optimize", status: imageStatus }).success,
    ).toBe(false);
  });

  it("publishes only matching tagged engine status branches", () => {
    type TaggedEngineStatus = ReturnType<typeof serverEngineJobStatusSchema.parse>;

    // @ts-expect-error a PDF tag cannot contain an image status.
    const mismatchedStatus: TaggedEngineStatus = {
      tool: "pdf.optimize",
      status: {} as ImageEngineJobStatus,
    };
    expect(mismatchedStatus).toBeDefined();
  });

  it("routes strict queue messages by the contract discriminator", () => {
    expect(
      serverJobMessageSchema.safeParse({
        ...createMessage(),
        contractId: "pdf.optimize@1",
        resourceClass: "pdf-standard-v1",
      }).success,
    ).toBe(true);
  });
});
