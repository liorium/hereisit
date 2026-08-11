import { describe, expect, it } from "vitest";
import {
  PDF_OPTIMIZE_CONTRACT_ID,
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  PDF_OPTIMIZE_MAX_PAGES,
  pdfOptimizeCreateRequestSchema,
  pdfOptimizePolicyRequestSchema,
  pdfOptimizePolicyResponseSchema,
  pdfOptimizeResultDescriptorSchema,
  pdfOptimizeSpecV1Schema,
  pdfOptimizeStatusResponseSchema,
} from "./pdf-optimize";

const anonymousSessionId = "a".repeat(43);

const serverPolicy = {
  contract: "tool-job@1",
  toolContract: "pdf.optimize@1",
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
    maxFiles: 1,
    maxBytesPerFile: 50 * 1024 * 1024,
    maxPagesPerFile: 100,
  },
} as const;

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    contract: "tool-job@1",
    toolContract: "pdf.optimize@1",
    clientRequestId: crypto.randomUUID(),
    anonymousSessionId,
    spec: { version: 1, preset: "minimum" },
    input: { byteLength: 1_000, mime: "application/pdf", pageCount: 3 },
    ...overrides,
  };
}

describe("pdf.optimize@1", () => {
  it("accepts the two published presets", () => {
    expect(pdfOptimizeSpecV1Schema.parse({ version: 1, preset: "balanced" })).toEqual({
      version: 1,
      preset: "balanced",
    });
    expect(pdfOptimizeSpecV1Schema.parse({ version: 1, preset: "minimum" })).toEqual({
      version: 1,
      preset: "minimum",
    });
  });

  it("rejects an unpublished preset and unknown spec keys", () => {
    expect(() => pdfOptimizeSpecV1Schema.parse({ version: 1, preset: "fast" })).toThrow();
    expect(
      pdfOptimizeSpecV1Schema.safeParse({ version: 1, preset: "balanced", quality: 82 }).success,
    ).toBe(false);
  });

  it("accepts one bounded PDF create request", () => {
    expect(pdfOptimizeCreateRequestSchema.parse(createRequest())).toMatchObject({
      toolContract: "pdf.optimize@1",
    });
  });

  it.each([
    [
      "a second file",
      { input: { byteLength: 1_000, mime: "application/pdf", pageCount: 3, files: 2 } },
    ],
    [
      "an oversized PDF",
      { input: { byteLength: 50 * 1024 * 1024 + 1, mime: "application/pdf", pageCount: 3 } },
    ],
    ["too many pages", { input: { byteLength: 1_000, mime: "application/pdf", pageCount: 101 } }],
    ["an unsupported MIME", { input: { byteLength: 1_000, mime: "image/pdf", pageCount: 3 } }],
    ["an unknown request key", { filename: "private.pdf" }],
  ])("rejects %s", (_case, override) => {
    expect(pdfOptimizeCreateRequestSchema.safeParse(createRequest(override)).success).toBe(false);
  });

  it("publishes exact contract limits", () => {
    expect({
      contract: PDF_OPTIMIZE_CONTRACT_ID,
      maxBytes: PDF_OPTIMIZE_MAX_FILE_BYTES,
      maxPages: PDF_OPTIMIZE_MAX_PAGES,
    }).toEqual({
      contract: "pdf.optimize@1",
      maxBytes: 50 * 1024 * 1024,
      maxPages: 100,
    });
  });
});

describe("pdf.optimize@1 results", () => {
  it("accepts the smaller structural result metadata", () => {
    expect(
      pdfOptimizeResultDescriptorSchema.parse({
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 1_000,
        byteLength: 990,
        pageCount: 3,
        profile: "structural",
        engineBuildId: "qpdf-12.4.0",
        warnings: ["SIGNATURES_INVALIDATED"],
      }),
    ).toMatchObject({ kind: "download", profile: "structural" });
  });

  it("requires the exact profile-bound warning combinations", () => {
    expect(
      pdfOptimizeResultDescriptorSchema.safeParse({
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 1_000,
        byteLength: 990,
        pageCount: 3,
        profile: "image-optimized",
        engineBuildId: "qpdf-12.4.0",
        warnings: ["SIGNATURES_INVALIDATED", "EMBEDDED_IMAGE_QUALITY_CHANGED"],
      }).success,
    ).toBe(true);
    expect(
      pdfOptimizeResultDescriptorSchema.safeParse({
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 1_000,
        byteLength: 990,
        pageCount: 3,
        profile: "structural",
        engineBuildId: "qpdf-12.4.0",
        warnings: ["SIGNATURES_INVALIDATED", "EMBEDDED_IMAGE_QUALITY_CHANGED"],
      }).success,
    ).toBe(false);
  });

  it("rejects a result that is not at least one percent smaller", () => {
    expect(
      pdfOptimizeResultDescriptorSchema.safeParse({
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 100,
        byteLength: 100,
        pageCount: 3,
        profile: "structural",
        engineBuildId: "qpdf-12.4.0",
        warnings: ["SIGNATURES_INVALIDATED"],
      }).success,
    ).toBe(false);
  });

  it("models original retention as the only warning", () => {
    expect(
      pdfOptimizeStatusResponseSchema.parse({
        contract: "tool-job@1",
        jobId: crypto.randomUUID(),
        state: "succeeded",
        phase: "completed",
        phaseFraction: 1,
        sequence: 8,
        attempt: 1,
        result: {
          kind: "original-retained",
          sourceByteLength: 1_000,
          pageCount: 3,
          engineBuildId: "qpdf-12.4.0",
          warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
        },
        actualWeightedUnits: 12_000,
        updatedAt: "2026-08-11T00:00:00.000Z",
      }).result?.kind,
    ).toBe("original-retained");
  });
});

describe("pdf.optimize@1 policy", () => {
  it("accepts the strict maintainer canary policy", () => {
    expect(pdfOptimizePolicyResponseSchema.parse(serverPolicy).limits).toEqual(serverPolicy.limits);
    expect(
      pdfOptimizePolicyRequestSchema.parse({
        contract: "tool-job@1",
        toolContract: "pdf.optimize@1",
        anonymousSessionId,
      }).toolContract,
    ).toBe("pdf.optimize@1");
  });

  it("rejects unknown policy keys", () => {
    expect(
      pdfOptimizePolicyResponseSchema.safeParse({ ...serverPolicy, engine: "qpdf" }).success,
    ).toBe(false);
    expect(
      pdfOptimizePolicyResponseSchema.safeParse({ ...serverPolicy, maintainer: false }).success,
    ).toBe(false);
  });
});
