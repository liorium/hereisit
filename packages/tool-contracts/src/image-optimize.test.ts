import { describe, expect, it } from "vitest";
import {
  IMAGE_OPTIMIZE_CONTRACT_ID,
  IMAGE_OPTIMIZE_MAX_DIMENSION,
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_FILES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
  imageOptimizeCreateRequestSchema,
  imageOptimizePolicyRequestSchema,
  imageOptimizePolicyResponseSchema,
  imageOptimizeResultDescriptorSchema,
  imageOptimizeSpecV1Schema,
  imageOptimizeStatusResponseSchema,
} from "./image-optimize";

const anonymousSessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const clientRequestId = "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe";
const jobToken = "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA";

const baseSpec = {
  version: 1,
  mode: "smart",
  preset: "balanced",
  output: "same-format",
  metadata: "strip",
  orientation: "apply",
  colorSpace: "srgb",
  minimumSavingsPercent: 1,
} as const;

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    jobContract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId,
    clientRequestId,
    jobToken,
    input: {
      byteLength: 4_000_000,
      mimeHint: "image/png",
      width: 2000,
      height: 1500,
    },
    spec: baseSpec,
    ...overrides,
  };
}

describe("image.optimize@1", () => {
  it("accepts a same-format smart request without a filename", () => {
    const parsed = imageOptimizeCreateRequestSchema.parse(createRequest());

    expect(parsed.toolContract).toBe("image.optimize@1");
    expect("name" in parsed.input).toBe(false);
  });

  it("rejects HEIC, excessive dimensions, and unknown keys", () => {
    expect(() =>
      imageOptimizeCreateRequestSchema.parse({
        jobContract: "tool-job@1",
        toolContract: "image.optimize@1",
        anonymousSessionId: crypto.randomUUID(),
        clientRequestId: crypto.randomUUID(),
        jobToken,
        input: {
          byteLength: 31 * 1024 * 1024,
          mimeHint: "image/heic",
          width: 50_000,
          height: 50_000,
          name: "private.heic",
        },
        spec: imageOptimizeSpecV1Schema.parse(baseSpec),
      }),
    ).toThrow();
  });

  it("publishes the exact contract and input limits", () => {
    expect({
      contract: IMAGE_OPTIMIZE_CONTRACT_ID,
      maxFiles: IMAGE_OPTIMIZE_MAX_FILES,
      maxBytes: IMAGE_OPTIMIZE_MAX_FILE_BYTES,
      maxPixels: IMAGE_OPTIMIZE_MAX_PIXELS,
      maxDimension: IMAGE_OPTIMIZE_MAX_DIMENSION,
    }).toEqual({
      contract: "image.optimize@1",
      maxFiles: 20,
      maxBytes: 30 * 1024 * 1024,
      maxPixels: 40_000_000,
      maxDimension: 32_768,
    });
  });

  it("defaults the minimum savings percentage", () => {
    const { minimumSavingsPercent: _, ...specWithoutMinimum } = baseSpec;
    const parsed = imageOptimizeSpecV1Schema.parse(specWithoutMinimum);

    expect(parsed.minimumSavingsPercent).toBe(1);
  });

  it.each([
    ["HEIC", { mimeHint: "image/heic" }],
    ["an oversized file", { byteLength: 30 * 1024 * 1024 + 1 }],
    ["zero bytes", { byteLength: 0 }],
    ["an excessive width", { width: 32_769 }],
    ["an excessive height", { height: 32_769 }],
    ["too many pixels", { width: 8000, height: 5001 }],
    ["a filename", { name: "private.png" }],
  ])("rejects input with %s", (_case, inputOverride) => {
    expect(
      imageOptimizeCreateRequestSchema.safeParse({
        ...createRequest(),
        input: {
          byteLength: 4_000_000,
          mimeHint: "image/png",
          width: 2000,
          height: 1500,
          ...inputOverride,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["a non-UUID session", { anonymousSessionId: "session-1" }],
    ["a non-UUID request ID", { clientRequestId: "request-1" }],
    ["a padded token", { jobToken: `${jobToken}=` }],
    ["a short token", { jobToken: jobToken.slice(0, -1) }],
    ["a long token", { jobToken: `${jobToken}A` }],
    ["a non-base64url token", { jobToken: `${jobToken.slice(0, -1)}+` }],
    ["an unknown request key", { filename: "private.png" }],
  ])("rejects %s", (_case, override) => {
    expect(imageOptimizeCreateRequestSchema.safeParse(createRequest(override)).success).toBe(false);
  });

  it.each([
    ["a fractional savings target", { minimumSavingsPercent: 1.5 }],
    ["a savings target above 50", { minimumSavingsPercent: 51 }],
    ["caller-selected output", { output: "image/webp" }],
    ["retained metadata", { metadata: "retain" }],
    ["an unknown key", { quality: 82 }],
  ])("rejects a spec with %s", (_case, override) => {
    expect(imageOptimizeSpecV1Schema.safeParse({ ...baseSpec, ...override }).success).toBe(false);
  });
});

describe("image.optimize@1 results", () => {
  it("models no-size-reduction as a successful terminal result", () => {
    const parsed = imageOptimizeStatusResponseSchema.parse({
      contract: "tool-job@1",
      jobId: crypto.randomUUID(),
      state: "succeeded",
      phase: "completed",
      phaseFraction: 1,
      sequence: 8,
      attempt: 1,
      result: {
        kind: "original-retained",
        reason: "NO_SIZE_REDUCTION",
        testedCandidates: 3,
        engineBuildId: "engine-test",
        codecBuildId: "mozjpeg-4.1.1",
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
        timing: { queueMs: 10, processingMs: 20, totalMs: 30 },
      },
      actualWeightedUnits: 12_000,
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(parsed.result?.kind).toBe("original-retained");
  });

  it("accepts a verified download descriptor", () => {
    const parsed = imageOptimizeResultDescriptorSchema.parse({
      kind: "download",
      mime: "image/webp",
      byteLength: 2_000_000,
      width: 2000,
      height: 1500,
      engineBuildId: "engine-test",
      codecBuildId: "libwebp-1.6.0",
      warnings: ["COLOR_PROFILE_NORMALIZED"],
      timing: { queueMs: 10, processingMs: 20, totalMs: 30 },
      expiresAt: "2026-07-16T00:30:00+00:00",
    });

    expect(parsed.kind).toBe("download");
  });

  it.each([
    [
      "negative timing",
      {
        kind: "original-retained",
        reason: "NO_SIZE_REDUCTION",
        testedCandidates: 3,
        engineBuildId: "engine-test",
        codecBuildId: "mozjpeg-4.1.1",
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
        timing: { queueMs: -1, processingMs: 20, totalMs: 30 },
      },
    ],
    [
      "a missing leading retained warning",
      {
        kind: "original-retained",
        reason: "NO_SIZE_REDUCTION",
        testedCandidates: 3,
        engineBuildId: "engine-test",
        codecBuildId: "mozjpeg-4.1.1",
        warnings: ["COLOR_PROFILE_NORMALIZED"],
        timing: { queueMs: 10, processingMs: 20, totalMs: 30 },
      },
    ],
    [
      "an unknown descriptor key",
      {
        kind: "download",
        mime: "image/png",
        byteLength: 2_000_000,
        width: 2000,
        height: 1500,
        engineBuildId: "engine-test",
        codecBuildId: "oxipng-9.1.5",
        warnings: [],
        timing: { queueMs: 10, processingMs: 20, totalMs: 30 },
        expiresAt: "2026-07-16T00:30:00.000Z",
        objectKey: "outputs/private",
      },
    ],
  ])("rejects %s", (_case, descriptor) => {
    expect(imageOptimizeResultDescriptorSchema.safeParse(descriptor).success).toBe(false);
  });
});

describe("image.optimize@1 policy", () => {
  it("accepts strict server disclosure and exact limits", () => {
    const parsed = imageOptimizePolicyResponseSchema.parse({
      contract: "tool-job@1",
      toolContract: "image.optimize@1",
      execution: "server",
      reason: null,
      maintainer: true,
      disclosure: {
        upload: true,
        inputDeletion: "terminal",
        resultDeletion: {
          mode: "server-temporary",
          acknowledged: "immediate-delete-attempt",
          unacknowledgedDueSeconds: 1800,
          applicationSloSeconds: 2100,
          lifecycleExpirationDays: 1,
          exceptionalDelayPossible: true,
        },
      },
      limits: {
        maxFiles: 20,
        maxBytesPerFile: 31_457_280,
        maxPixelsPerFile: 40_000_000,
      },
    });

    expect(parsed.disclosure.resultDeletion.mode).toBe("server-temporary");
  });

  it("accepts local fallback disclosure without an upload", () => {
    const parsed = imageOptimizePolicyResponseSchema.parse({
      contract: "tool-job@1",
      toolContract: "image.optimize@1",
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
      maintainer: false,
      disclosure: {
        upload: false,
        inputDeletion: "not-uploaded",
        resultDeletion: { mode: "not-uploaded" },
      },
      limits: {
        maxFiles: 20,
        maxBytesPerFile: 31_457_280,
        maxPixelsPerFile: 40_000_000,
      },
    });

    expect(parsed.execution).toBe("local");
  });

  it("rejects invalid policy callers and unknown disclosure fields", () => {
    expect(
      imageOptimizePolicyRequestSchema.safeParse({
        contract: "tool-job@1",
        toolContract: "image.optimize@1",
        anonymousSessionId: "anonymous",
      }).success,
    ).toBe(false);

    expect(
      imageOptimizePolicyResponseSchema.safeParse({
        contract: "tool-job@1",
        toolContract: "image.optimize@1",
        execution: "local",
        reason: "SERVER_PROCESSING_DISABLED",
        maintainer: false,
        disclosure: {
          upload: false,
          inputDeletion: "not-uploaded",
          resultDeletion: { mode: "not-uploaded", bucket: "private" },
        },
        limits: {
          maxFiles: 20,
          maxBytesPerFile: 31_457_280,
          maxPixelsPerFile: 40_000_000,
        },
      }).success,
    ).toBe(false);
  });
});
