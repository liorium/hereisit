import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createToolJobCreateResponseSchema,
  createToolJobStatusEnvelopeSchema,
  createToolJobUploadDescriptorSchema,
  TOOL_JOB_CONTRACT_ID,
  toolJobErrorResponseSchema,
  toolJobMutationAcknowledgementSchema,
} from "./tool-job";

const jobId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const updatedAt = "2026-07-16T00:00:00.000Z";

const testStatusSchema = createToolJobStatusEnvelopeSchema(
  z.enum(["queued", "working", "completed"]),
  z.object({ outputId: z.string().min(1) }).strict(),
);
const pdfContentTypeSchema = z.literal("application/pdf");
const pdfUploadDescriptorSchema = createToolJobUploadDescriptorSchema(pdfContentTypeSchema);
const pdfCreateResponseSchema = createToolJobCreateResponseSchema(pdfContentTypeSchema);

function status(overrides: Record<string, unknown> = {}) {
  return {
    contract: TOOL_JOB_CONTRACT_ID,
    jobId,
    state: "running",
    phase: "working",
    phaseFraction: 0.5,
    sequence: 2,
    attempt: 1,
    updatedAt,
    ...overrides,
  };
}

describe("tool-job@1 transport", () => {
  it("accepts a tool-specific content type through the generic factory", () => {
    const parsed = pdfCreateResponseSchema.parse({
      contract: "tool-job@1",
      mode: "upload-required",
      jobId,
      upload: {
        kind: "worker-stream-put",
        method: "PUT",
        path: `/v1/jobs/${jobId}/input`,
        contentType: "application/pdf",
        byteLength: 4_000_000,
        expiresAt: updatedAt,
      },
      reservedWeightedUnits: 12_000,
    });

    expect(parsed.mode).toBe("upload-required");
    if (parsed.mode === "upload-required") {
      expect(parsed.upload.path).toBe(`/v1/jobs/${jobId}/input`);
      expect(parsed.upload.contentType).toBe("application/pdf");
    }
  });

  it("accepts only post-upload states for an existing job", () => {
    const parsed = pdfCreateResponseSchema.parse({
      contract: "tool-job@1",
      mode: "existing-job",
      jobId,
      state: "queued",
      reservedWeightedUnits: 12_000,
    });

    expect(parsed.mode).toBe("existing-job");
    if (parsed.mode === "existing-job") {
      expect(parsed.state).toBe("queued");
    }

    for (const state of ["created", "uploading"]) {
      expect(
        pdfCreateResponseSchema.safeParse({
          contract: "tool-job@1",
          mode: "existing-job",
          jobId,
          state,
          reservedWeightedUnits: 12_000,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an upload path belonging to another job", () => {
    expect(
      pdfCreateResponseSchema.safeParse({
        contract: "tool-job@1",
        mode: "upload-required",
        jobId,
        upload: {
          kind: "worker-stream-put",
          method: "PUT",
          path: "/v1/jobs/cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe/input",
          contentType: "application/pdf",
          byteLength: 4_000_000,
          expiresAt: updatedAt,
        },
        reservedWeightedUnits: 12_000,
      }).success,
    ).toBe(false);
  });

  it("rejects arbitrary upload locations, local timestamps, and unknown keys", () => {
    const baseUpload = {
      kind: "worker-stream-put",
      method: "PUT",
      path: `/v1/jobs/${jobId}/input`,
      contentType: "application/pdf",
      byteLength: 4_000_000,
      expiresAt: updatedAt,
    };

    expect(
      pdfUploadDescriptorSchema.safeParse({
        ...baseUpload,
        path: "https://uploads.example/input",
      }).success,
    ).toBe(false);
    expect(
      pdfUploadDescriptorSchema.safeParse({
        ...baseUpload,
        expiresAt: "2026-07-16T00:00:00",
      }).success,
    ).toBe(false);
    expect(
      pdfUploadDescriptorSchema.safeParse({
        ...baseUpload,
        headers: { authorization: "secret" },
      }).success,
    ).toBe(false);
  });

  it("parses strict mutation acknowledgements and errors", () => {
    expect(
      toolJobMutationAcknowledgementSchema.parse({
        contract: "tool-job@1",
        jobId,
        action: "downloaded",
        acknowledged: true,
      }).action,
    ).toBe("downloaded");

    expect(
      toolJobErrorResponseSchema.parse({
        contract: "tool-job@1",
        error: {
          code: "LOCAL_FALLBACK_REQUIRED",
          message: "브라우저에서 처리해 주세요.",
          retryable: false,
          guidance: "TRY_BALANCED_PRESET",
        },
      }).error.code,
    ).toBe("LOCAL_FALLBACK_REQUIRED");

    expect(
      toolJobMutationAcknowledgementSchema.safeParse({
        contract: "tool-job@1",
        jobId,
        action: "downloaded",
        acknowledged: true,
        resultUrl: "https://example.invalid/private",
      }).success,
    ).toBe(false);
  });
});

describe("tool-job@1 lifecycle", () => {
  it.each([
    [
      "succeeded",
      {
        state: "succeeded",
        phase: "completed",
        phaseFraction: 1,
        result: { outputId: "output-1" },
        actualWeightedUnits: 20,
      },
    ],
    [
      "failed",
      {
        state: "failed",
        error: {
          code: "ENGINE_CRASH",
          message: "엔진이 종료되었습니다.",
          retryable: true,
        },
      },
    ],
    [
      "failed with a non-cancellation expiry error",
      {
        state: "failed",
        error: {
          code: "EXPIRED",
          message: "작업 기한을 초과했습니다.",
          retryable: false,
        },
      },
    ],
    [
      "cancelled",
      {
        state: "cancelled",
        error: {
          code: "CANCELLED",
          message: "작업이 취소되었습니다.",
          retryable: false,
        },
      },
    ],
    [
      "expired",
      {
        state: "expired",
        error: {
          code: "EXPIRED",
          message: "작업이 만료되었습니다.",
          retryable: false,
        },
      },
    ],
  ])("accepts a consistent %s terminal envelope", (_case, overrides) => {
    expect(testStatusSchema.safeParse(status(overrides)).success).toBe(true);
  });

  it.each([
    ["succeeded without a result", { state: "succeeded" }],
    [
      "succeeded with an error",
      {
        state: "succeeded",
        result: { outputId: "output-1" },
        error: { code: "ENGINE_CRASH", message: "failed", retryable: true },
      },
    ],
    [
      "failed with a cancellation error",
      {
        state: "failed",
        error: { code: "CANCELLED", message: "cancelled", retryable: false },
      },
    ],
    [
      "cancelled with another error",
      {
        state: "cancelled",
        error: { code: "ENGINE_TIMEOUT", message: "timeout", retryable: true },
      },
    ],
    [
      "expired with another error",
      {
        state: "expired",
        error: { code: "STORAGE_FAILURE", message: "storage", retryable: true },
      },
    ],
    ["running with a result", { result: { outputId: "output-1" } }],
    [
      "queued with an error",
      {
        state: "queued",
        phase: "queued",
        error: { code: "QUEUE_UNAVAILABLE", message: "queue", retryable: true },
      },
    ],
  ])("rejects %s", (_case, overrides) => {
    expect(testStatusSchema.safeParse(status(overrides)).success).toBe(false);
  });

  it.each([
    ["a phase fraction below zero", { phaseFraction: -0.01 }],
    ["a phase fraction above one", { phaseFraction: 1.01 }],
    ["a fractional sequence", { sequence: 1.5 }],
    ["a negative attempt", { attempt: -1 }],
    ["infinite usage", { actualWeightedUnits: Number.POSITIVE_INFINITY }],
    ["a timestamp without an offset", { updatedAt: "2026-07-16T00:00:00" }],
    ["an unknown key", { internalObjectKey: "inputs/private" }],
  ])("rejects %s", (_case, overrides) => {
    expect(testStatusSchema.safeParse(status(overrides)).success).toBe(false);
  });
});
