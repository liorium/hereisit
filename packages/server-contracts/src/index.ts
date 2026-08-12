import type {
  ImageOptimizeSpecV1,
  ImageOptimizeWarningCode,
  PdfOptimizeResultDescriptor,
  PdfOptimizeSpecV1,
} from "@hereisit/tool-contracts";
import {
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
  imageOptimizeMimeSchema,
  imageOptimizeSpecV1Schema,
  imageOptimizeWarningCodeSchema,
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  PDF_OPTIMIZE_MAX_PAGES,
  pdfOptimizeMimeSchema,
  pdfOptimizeResultDescriptorSchema,
  pdfOptimizeSpecV1Schema,
} from "@hereisit/tool-contracts";
import { z } from "zod";

export type ImageResourceClass = "image-standard-v1" | "image-large-v1";
export type ImageJobAttempt = 1 | 2 | 3;
export const IMAGE_ENGINE_MAX_TESTED_CANDIDATES = 3 as const;
export const PDF_ENGINE_MAX_TESTED_CANDIDATES = 2 as const;

export type ImageContentClass =
  | "photo"
  | "screenshot-text"
  | "flat-graphic"
  | "transparent-graphic"
  | "noisy"
  | "already-optimized";

export interface ImageJobMessage {
  jobId: string;
  contractId: "image.optimize@1";
  specHash: string;
  inputKey: string;
  inputEtag: string;
  outputKey: string;
  resourceClass: ImageResourceClass;
  attempt: ImageJobAttempt;
  queueEpoch: string;
  queueGeneration: number;
}

export interface ImageEngineCreateJobRequest {
  protocol: 1;
  jobId: string;
  attempt: ImageJobAttempt;
  tool: "image.optimize";
  toolVersion: 1;
  spec: ImageOptimizeSpecV1;
  specHash: string;
  input: {
    byteLength: number;
    etag: string;
    mimeHint: "image/jpeg" | "image/png" | "image/webp";
  };
  resourceClass: ImageResourceClass;
}

export type EngineState =
  | "created"
  | "uploading"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type EnginePhase =
  | "validating"
  | "inspecting"
  | "normalizing"
  | "optimizing"
  | "verifying"
  | "preparing-output";

export interface EngineMeasurements {
  processedInputBytes: number;
  processedPixels: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  peakMemoryBytes: number;
  testedCandidates: number;
  processingMs: number;
}

export interface EngineInspectionSummary {
  verifiedInputMime: "image/jpeg" | "image/png" | "image/webp";
  inputHasAlpha: boolean;
  contentClass: ImageContentClass;
}

export type EngineResult =
  | {
      kind: "download";
      mime: "image/jpeg" | "image/png" | "image/webp";
      byteLength: number;
      width: number;
      height: number;
      testedCandidates: number;
      engineBuildId: string;
      codecBuildId: string;
      warnings: readonly ImageOptimizeWarningCode[];
    }
  | {
      kind: "original-retained";
      testedCandidates: number;
      engineBuildId: string;
      codecBuildId: string;
      warnings: readonly ["ORIGINAL_RETAINED_UNMODIFIED", ...ImageOptimizeWarningCode[]];
    };

export type ImageEngineJobStatus =
  | {
      protocol: 1;
      jobId: string;
      state: "created" | "uploading" | "ready";
      phase: null;
      fraction: null;
      sequence: number;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "running";
      phase: EnginePhase;
      fraction: number | null;
      sequence: number;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "succeeded";
      phase: "preparing-output";
      fraction: 1;
      sequence: number;
      result: EngineResult;
      inspection: EngineInspectionSummary;
      measurements: EngineMeasurements;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "failed";
      phase: EnginePhase | null;
      fraction: number | null;
      sequence: number;
      measurements: EngineMeasurements;
      inspection: EngineInspectionSummary | null;
      error: {
        code:
          | "UNSUPPORTED_INPUT"
          | "UNSUPPORTED_FEATURE"
          | "INPUT_LIMIT_EXCEEDED"
          | "PIXEL_LIMIT_EXCEEDED"
          | "RESOURCE_CLASS_UPGRADE"
          | "ENGINE_TIMEOUT"
          | "ENGINE_OOM"
          | "ENGINE_CRASH"
          | "VERIFICATION_FAILED";
        retryable: boolean;
        guidance?: "TRY_BALANCED_PRESET";
      };
    }
  | {
      protocol: 1;
      jobId: string;
      state: "cancelled";
      phase: EnginePhase | null;
      fraction: number | null;
      sequence: number;
      measurements: EngineMeasurements;
      inspection: EngineInspectionSummary | null;
      error: {
        code: "CANCELLED";
        retryable: false;
      };
    };

const nonEmptyStringSchema = z.string().min(1);
const uuidSchema = z.uuid();
const specHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "Spec hash must be exactly 64 hexadecimal characters.");
const safeEtagSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x20-\x7e]+$/, "ETag must contain only printable ASCII characters.");
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const inputObjectKeySchema = z
  .string()
  .regex(new RegExp(`^inputs/${uuidPattern}$`, "i"), "Input key must be an opaque UUID key.");
const outputObjectKeySchema = z
  .string()
  .regex(new RegExp(`^outputs/${uuidPattern}$`, "i"), "Output key must be an opaque UUID key.");
const nonNegativeSafeIntegerSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.min(1);
const fractionSchema = z.number().finite().min(0).max(1);

export const imageResourceClassSchema = z.enum(["image-standard-v1", "image-large-v1"]);
export const imageJobAttemptSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const imageContentClassSchema = z.enum([
  "photo",
  "screenshot-text",
  "flat-graphic",
  "transparent-graphic",
  "noisy",
  "already-optimized",
]);
export const engineStateSchema = z.enum([
  "created",
  "uploading",
  "ready",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const enginePhaseSchema = z.enum([
  "validating",
  "inspecting",
  "normalizing",
  "optimizing",
  "verifying",
  "preparing-output",
]);

export const imageJobMessageSchema = z
  .object({
    jobId: uuidSchema,
    contractId: z.literal("image.optimize@1"),
    specHash: specHashSchema,
    inputKey: inputObjectKeySchema,
    inputEtag: safeEtagSchema,
    outputKey: outputObjectKeySchema,
    resourceClass: imageResourceClassSchema,
    attempt: imageJobAttemptSchema,
    queueEpoch: uuidSchema,
    queueGeneration: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const pdfResourceClassSchema = z.literal("pdf-standard-v1");

export const pdfJobMessageSchema = z
  .object({
    jobId: uuidSchema,
    contractId: z.literal("pdf.optimize@1"),
    specHash: specHashSchema,
    inputKey: inputObjectKeySchema,
    inputEtag: safeEtagSchema,
    outputKey: outputObjectKeySchema,
    resourceClass: pdfResourceClassSchema,
    attempt: imageJobAttemptSchema,
    queueEpoch: uuidSchema,
    queueGeneration: nonNegativeSafeIntegerSchema,
  })
  .strict();

export type PdfJobMessage = z.infer<typeof pdfJobMessageSchema>;
export type ServerJobMessage = ImageJobMessage | PdfJobMessage;

export const serverJobMessageSchema = z.discriminatedUnion("contractId", [
  imageJobMessageSchema,
  pdfJobMessageSchema,
]);

export const imageEngineCreateJobRequestSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    attempt: imageJobAttemptSchema,
    tool: z.literal("image.optimize"),
    toolVersion: z.literal(1),
    spec: imageOptimizeSpecV1Schema,
    specHash: specHashSchema,
    input: z
      .object({
        byteLength: positiveSafeIntegerSchema,
        etag: safeEtagSchema,
        mimeHint: imageOptimizeMimeSchema,
      })
      .strict(),
    resourceClass: imageResourceClassSchema,
  })
  .strict();

export const engineCreatePdfJobRequestSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    attempt: imageJobAttemptSchema,
    tool: z.literal("pdf.optimize"),
    toolVersion: z.literal(1),
    spec: pdfOptimizeSpecV1Schema,
    specHash: specHashSchema,
    input: z
      .object({
        byteLength: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
        etag: safeEtagSchema,
        mimeHint: pdfOptimizeMimeSchema,
        pageCount: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
      })
      .strict(),
    resourceClass: pdfResourceClassSchema,
  })
  .strict();

export interface EngineCreatePdfJobRequest {
  protocol: 1;
  jobId: string;
  attempt: ImageJobAttempt;
  tool: "pdf.optimize";
  toolVersion: 1;
  spec: PdfOptimizeSpecV1;
  specHash: string;
  input: {
    byteLength: number;
    etag: string;
    mimeHint: "application/pdf";
    pageCount: number;
  };
  resourceClass: "pdf-standard-v1";
}

export const serverEngineCreateJobRequestSchema = z.discriminatedUnion("tool", [
  imageEngineCreateJobRequestSchema,
  engineCreatePdfJobRequestSchema,
]);

export const anyEngineCreateJobRequestSchema = serverEngineCreateJobRequestSchema;
export const engineCreateJobRequestSchema = imageEngineCreateJobRequestSchema;

export type ServerEngineCreateJobRequest = ImageEngineCreateJobRequest | EngineCreatePdfJobRequest;
export type AnyEngineCreateJobRequest = ServerEngineCreateJobRequest;
export type EngineCreateJobRequest = ImageEngineCreateJobRequest;

export const engineMeasurementsSchema = z
  .object({
    processedInputBytes: nonNegativeSafeIntegerSchema.max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
    processedPixels: nonNegativeSafeIntegerSchema.max(IMAGE_OPTIMIZE_MAX_PIXELS),
    cpuMs: nonNegativeSafeIntegerSchema,
    memoryByteMilliseconds: nonNegativeSafeIntegerSchema,
    peakMemoryBytes: nonNegativeSafeIntegerSchema,
    testedCandidates: nonNegativeSafeIntegerSchema.max(IMAGE_ENGINE_MAX_TESTED_CANDIDATES),
    processingMs: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const engineInspectionSummarySchema = z
  .object({
    verifiedInputMime: imageOptimizeMimeSchema,
    inputHasAlpha: z.boolean(),
    contentClass: imageContentClassSchema,
  })
  .strict();

const engineDownloadResultSchema = z
  .object({
    kind: z.literal("download"),
    mime: imageOptimizeMimeSchema,
    byteLength: positiveSafeIntegerSchema,
    width: positiveSafeIntegerSchema,
    height: positiveSafeIntegerSchema,
    testedCandidates: nonNegativeSafeIntegerSchema.max(IMAGE_ENGINE_MAX_TESTED_CANDIDATES),
    engineBuildId: nonEmptyStringSchema,
    codecBuildId: nonEmptyStringSchema,
    warnings: z.array(imageOptimizeWarningCodeSchema).readonly(),
  })
  .strict();

const originalRetainedWarningsSchema = z
  .tuple([z.literal("ORIGINAL_RETAINED_UNMODIFIED")], imageOptimizeWarningCodeSchema)
  .readonly();

const engineOriginalRetainedResultSchema = z
  .object({
    kind: z.literal("original-retained"),
    testedCandidates: nonNegativeSafeIntegerSchema.max(IMAGE_ENGINE_MAX_TESTED_CANDIDATES),
    engineBuildId: nonEmptyStringSchema,
    codecBuildId: nonEmptyStringSchema,
    warnings: originalRetainedWarningsSchema,
  })
  .strict();

export const engineResultSchema = z
  .discriminatedUnion("kind", [engineDownloadResultSchema, engineOriginalRetainedResultSchema])
  .superRefine((result, context) => {
    if (
      result.kind === "download" &&
      result.width > Math.floor(IMAGE_OPTIMIZE_MAX_PIXELS / result.height)
    ) {
      context.addIssue({
        code: "custom",
        message: "Download dimensions must not exceed 40,000,000 pixels.",
        path: ["height"],
      });
    }
  });

const inactiveEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.enum(["created", "uploading", "ready"]),
    phase: z.null(),
    fraction: z.null(),
    sequence: nonNegativeSafeIntegerSchema,
  })
  .strict();

const runningEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("running"),
    phase: enginePhaseSchema,
    fraction: fractionSchema.nullable(),
    sequence: nonNegativeSafeIntegerSchema,
  })
  .strict();

const succeededEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("succeeded"),
    phase: z.literal("preparing-output"),
    fraction: z.literal(1),
    sequence: nonNegativeSafeIntegerSchema,
    result: engineResultSchema,
    inspection: engineInspectionSummarySchema,
    measurements: engineMeasurementsSchema,
  })
  .strict();

const engineFailureCodeSchema = z.enum([
  "UNSUPPORTED_INPUT",
  "UNSUPPORTED_FEATURE",
  "INPUT_LIMIT_EXCEEDED",
  "PIXEL_LIMIT_EXCEEDED",
  "RESOURCE_CLASS_UPGRADE",
  "ENGINE_TIMEOUT",
  "ENGINE_OOM",
  "ENGINE_CRASH",
  "VERIFICATION_FAILED",
]);

const failedEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("failed"),
    phase: enginePhaseSchema.nullable(),
    fraction: fractionSchema.nullable(),
    sequence: nonNegativeSafeIntegerSchema,
    measurements: engineMeasurementsSchema,
    inspection: engineInspectionSummarySchema.nullable(),
    error: z
      .object({
        code: engineFailureCodeSchema,
        retryable: z.boolean(),
        guidance: z.literal("TRY_BALANCED_PRESET").optional(),
      })
      .strict(),
  })
  .strict();

const cancelledEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("cancelled"),
    phase: enginePhaseSchema.nullable(),
    fraction: fractionSchema.nullable(),
    sequence: nonNegativeSafeIntegerSchema,
    measurements: engineMeasurementsSchema,
    inspection: engineInspectionSummarySchema.nullable(),
    error: z
      .object({
        code: z.literal("CANCELLED"),
        retryable: z.literal(false),
      })
      .strict(),
  })
  .strict();

export const imageEngineJobStatusSchema = z
  .discriminatedUnion("state", [
    inactiveEngineJobStatusSchema,
    runningEngineJobStatusSchema,
    succeededEngineJobStatusSchema,
    failedEngineJobStatusSchema,
    cancelledEngineJobStatusSchema,
  ])
  .superRefine((status, context) => {
    if (status.state !== "succeeded") {
      return;
    }

    if (status.result.testedCandidates !== status.measurements.testedCandidates) {
      context.addIssue({
        code: "custom",
        message: "Result and measurement candidate counts must match.",
        path: ["result", "testedCandidates"],
      });
    }

    if (
      status.result.kind === "download" &&
      status.result.mime !== status.inspection.verifiedInputMime
    ) {
      context.addIssue({
        code: "custom",
        message: "Download MIME must match the verified input MIME.",
        path: ["result", "mime"],
      });
    }
  });

export type PdfEnginePhase = "validating" | "optimizing" | "verifying" | "preparing-output";

export interface PdfEngineMeasurements {
  processedInputBytes: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  peakMemoryBytes: number;
  testedCandidates: number;
  processingMs: number;
}

export interface PdfEngineInspectionSummary {
  verifiedInputMime: "application/pdf";
  verifiedPageCount: number;
  encrypted: false;
}

export type PdfEngineResult = PdfOptimizeResultDescriptor;

export type PdfEngineJobStatus =
  | {
      protocol: 1;
      jobId: string;
      state: "created" | "uploading" | "ready";
      phase: null;
      fraction: null;
      sequence: number;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "running";
      phase: PdfEnginePhase;
      fraction: number | null;
      sequence: number;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "succeeded";
      phase: "preparing-output";
      fraction: 1;
      sequence: number;
      result: PdfEngineResult;
      inspection: PdfEngineInspectionSummary;
      measurements: PdfEngineMeasurements;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "failed";
      phase: PdfEnginePhase | null;
      fraction: number | null;
      sequence: number;
      measurements: PdfEngineMeasurements;
      inspection: PdfEngineInspectionSummary | null;
      error: {
        code:
          | "UNSUPPORTED_INPUT"
          | "UNSUPPORTED_FEATURE"
          | "INPUT_LIMIT_EXCEEDED"
          | "RESOURCE_CLASS_UPGRADE"
          | "ENGINE_TIMEOUT"
          | "ENGINE_OOM"
          | "ENGINE_CRASH"
          | "VERIFICATION_FAILED";
        retryable: boolean;
        guidance?: "TRY_BALANCED_PRESET";
      };
    }
  | {
      protocol: 1;
      jobId: string;
      state: "cancelled";
      phase: PdfEnginePhase | null;
      fraction: number | null;
      sequence: number;
      measurements: PdfEngineMeasurements;
      inspection: PdfEngineInspectionSummary | null;
      error: {
        code: "CANCELLED";
        retryable: false;
      };
    };

export const pdfEnginePhaseSchema = z.enum([
  "validating",
  "optimizing",
  "verifying",
  "preparing-output",
]);

export const pdfEngineMeasurementsSchema = z
  .object({
    processedInputBytes: nonNegativeSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
    cpuMs: nonNegativeSafeIntegerSchema,
    memoryByteMilliseconds: nonNegativeSafeIntegerSchema,
    peakMemoryBytes: nonNegativeSafeIntegerSchema,
    testedCandidates: nonNegativeSafeIntegerSchema.max(PDF_ENGINE_MAX_TESTED_CANDIDATES),
    processingMs: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const pdfEngineInspectionSummarySchema = z
  .object({
    verifiedInputMime: pdfOptimizeMimeSchema,
    verifiedPageCount: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
    encrypted: z.literal(false),
  })
  .strict();

const inactivePdfEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.enum(["created", "uploading", "ready"]),
    phase: z.null(),
    fraction: z.null(),
    sequence: nonNegativeSafeIntegerSchema,
  })
  .strict();

const runningPdfEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("running"),
    phase: pdfEnginePhaseSchema,
    fraction: fractionSchema.nullable(),
    sequence: nonNegativeSafeIntegerSchema,
  })
  .strict();

const succeededPdfEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("succeeded"),
    phase: z.literal("preparing-output"),
    fraction: z.literal(1),
    sequence: nonNegativeSafeIntegerSchema,
    result: pdfOptimizeResultDescriptorSchema,
    inspection: pdfEngineInspectionSummarySchema,
    measurements: pdfEngineMeasurementsSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.result.pageCount !== status.inspection.verifiedPageCount) {
      context.addIssue({
        code: "custom",
        message: "Result and inspection page counts must match.",
        path: ["result", "pageCount"],
      });
    }
  });

const pdfEngineFailureCodeSchema = z.enum([
  "UNSUPPORTED_INPUT",
  "UNSUPPORTED_FEATURE",
  "INPUT_LIMIT_EXCEEDED",
  "RESOURCE_CLASS_UPGRADE",
  "ENGINE_TIMEOUT",
  "ENGINE_OOM",
  "ENGINE_CRASH",
  "VERIFICATION_FAILED",
]);

const failedPdfEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("failed"),
    phase: pdfEnginePhaseSchema.nullable(),
    fraction: fractionSchema.nullable(),
    sequence: nonNegativeSafeIntegerSchema,
    measurements: pdfEngineMeasurementsSchema,
    inspection: pdfEngineInspectionSummarySchema.nullable(),
    error: z
      .object({
        code: pdfEngineFailureCodeSchema,
        retryable: z.boolean(),
        guidance: z.literal("TRY_BALANCED_PRESET").optional(),
      })
      .strict(),
  })
  .strict();

const cancelledPdfEngineJobStatusSchema = z
  .object({
    protocol: z.literal(1),
    jobId: uuidSchema,
    state: z.literal("cancelled"),
    phase: pdfEnginePhaseSchema.nullable(),
    fraction: fractionSchema.nullable(),
    sequence: nonNegativeSafeIntegerSchema,
    measurements: pdfEngineMeasurementsSchema,
    inspection: pdfEngineInspectionSummarySchema.nullable(),
    error: z
      .object({
        code: z.literal("CANCELLED"),
        retryable: z.literal(false),
      })
      .strict(),
  })
  .strict();

export const pdfEngineJobStatusSchema = z.discriminatedUnion("state", [
  inactivePdfEngineJobStatusSchema,
  runningPdfEngineJobStatusSchema,
  succeededPdfEngineJobStatusSchema,
  failedPdfEngineJobStatusSchema,
  cancelledPdfEngineJobStatusSchema,
]);

function createServerEngineStatusSchema<StatusSchema extends z.ZodType>(
  tool: "image.optimize" | "pdf.optimize",
  statusSchema: StatusSchema,
) {
  return z
    .object({ tool: z.literal(tool) })
    .passthrough()
    .superRefine((value, context) => {
      const { tool: _, ...status } = value;
      const parsed = statusSchema.safeParse(status);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          message: "Engine status must match its tool contract.",
        });
      }
    });
}

const imageServerEngineJobStatusSchema = createServerEngineStatusSchema(
  "image.optimize",
  imageEngineJobStatusSchema,
);
const pdfServerEngineJobStatusSchema = createServerEngineStatusSchema(
  "pdf.optimize",
  pdfEngineJobStatusSchema,
);

export const serverEngineJobStatusSchema = z.discriminatedUnion("tool", [
  imageServerEngineJobStatusSchema,
  pdfServerEngineJobStatusSchema,
]);

export type ServerEngineJobStatus =
  | (ImageEngineJobStatus & { tool: "image.optimize" })
  | (PdfEngineJobStatus & { tool: "pdf.optimize" });
export type EngineJobStatus = ImageEngineJobStatus;
export const engineJobStatusSchema = imageEngineJobStatusSchema;
