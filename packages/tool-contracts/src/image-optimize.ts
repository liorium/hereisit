import { z } from "zod";
import { createToolJobStatusEnvelopeSchema, TOOL_JOB_CONTRACT_ID } from "./tool-job";

export const IMAGE_OPTIMIZE_CONTRACT_ID = "image.optimize@1" as const;
export const IMAGE_OPTIMIZE_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const IMAGE_OPTIMIZE_MAX_PIXELS = 40_000_000;
export const IMAGE_OPTIMIZE_MAX_DIMENSION = 32_768;
export const IMAGE_OPTIMIZE_MAX_FILES = 20;

export const imageOptimizeMimeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const imageOptimizeWarningCodeSchema = z.enum([
  "COLOR_PROFILE_NORMALIZED",
  "SMART_PNG_FELL_BACK_TO_LOSSLESS",
  "ORIGINAL_RETAINED_UNMODIFIED",
]);

export type ImageOptimizeWarningCode = z.infer<typeof imageOptimizeWarningCodeSchema>;

const nonNegativeFiniteNumberSchema = z.number().finite().min(0);
const positiveDimensionSchema = z.number().int().min(1).max(IMAGE_OPTIMIZE_MAX_DIMENSION);
const offsetDateTimeSchema = z.iso.datetime({ offset: true });
const buildIdSchema = z.string().min(1);

const imageInputSchema = z
  .object({
    byteLength: z.number().int().min(1).max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
    mimeHint: imageOptimizeMimeSchema,
    width: positiveDimensionSchema,
    height: positiveDimensionSchema,
  })
  .strict()
  .refine(({ width, height }) => width * height <= IMAGE_OPTIMIZE_MAX_PIXELS, {
    message: "이미지는 4천만 픽셀을 초과할 수 없습니다.",
  });

export const imageOptimizeSpecV1Schema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["lossless", "smart"]),
    preset: z.enum(["balanced", "smallest"]),
    output: z.literal("same-format"),
    metadata: z.literal("strip"),
    orientation: z.literal("apply"),
    colorSpace: z.literal("srgb"),
    minimumSavingsPercent: z.number().int().min(0).max(50).default(1),
  })
  .strict();

export type ImageOptimizeSpecV1 = z.infer<typeof imageOptimizeSpecV1Schema>;

const unpaddedBase64Url32BytesSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "작업 토큰은 패딩 없는 base64url이어야 합니다.")
  .refine((token) => /[AEIMQUYcgkosw048]$/.test(token), {
    message: "작업 토큰은 정확히 32바이트여야 합니다.",
  });

export const imageOptimizeCreateRequestSchema = z
  .object({
    jobContract: z.literal(TOOL_JOB_CONTRACT_ID),
    toolContract: z.literal(IMAGE_OPTIMIZE_CONTRACT_ID),
    anonymousSessionId: z.uuid(),
    clientRequestId: z.uuid(),
    jobToken: unpaddedBase64Url32BytesSchema,
    input: imageInputSchema,
    spec: imageOptimizeSpecV1Schema,
  })
  .strict();

export type ImageOptimizeCreateRequestV1 = z.infer<typeof imageOptimizeCreateRequestSchema>;

export const imageOptimizePhaseSchema = z.enum([
  "uploading",
  "queued",
  "validating",
  "inspecting",
  "normalizing",
  "optimizing",
  "verifying",
  "preparing-output",
  "completed",
]);

export type ImageOptimizePhase = z.infer<typeof imageOptimizePhaseSchema>;

export const imageOptimizeTimingSchema = z
  .object({
    queueMs: nonNegativeFiniteNumberSchema,
    processingMs: nonNegativeFiniteNumberSchema,
    totalMs: nonNegativeFiniteNumberSchema,
  })
  .strict();

const imageOptimizeDownloadResultSchema = z
  .object({
    kind: z.literal("download"),
    mime: imageOptimizeMimeSchema,
    byteLength: z.number().int().min(1),
    width: positiveDimensionSchema,
    height: positiveDimensionSchema,
    engineBuildId: buildIdSchema,
    codecBuildId: buildIdSchema,
    warnings: z.array(imageOptimizeWarningCodeSchema).readonly(),
    timing: imageOptimizeTimingSchema,
    expiresAt: offsetDateTimeSchema,
  })
  .strict();

const originalRetainedWarningsSchema = z
  .tuple([z.literal("ORIGINAL_RETAINED_UNMODIFIED")], imageOptimizeWarningCodeSchema)
  .readonly();

const imageOptimizeOriginalRetainedResultSchema = z
  .object({
    kind: z.literal("original-retained"),
    reason: z.literal("NO_SIZE_REDUCTION"),
    testedCandidates: z.number().int().min(0),
    engineBuildId: buildIdSchema,
    codecBuildId: buildIdSchema,
    warnings: originalRetainedWarningsSchema,
    timing: imageOptimizeTimingSchema,
  })
  .strict();

export const imageOptimizeResultDescriptorSchema = z
  .discriminatedUnion("kind", [
    imageOptimizeDownloadResultSchema,
    imageOptimizeOriginalRetainedResultSchema,
  ])
  .superRefine((result, context) => {
    if (result.kind === "download" && result.width * result.height > IMAGE_OPTIMIZE_MAX_PIXELS) {
      context.addIssue({
        code: "custom",
        message: "이미지는 4천만 픽셀을 초과할 수 없습니다.",
        path: ["height"],
      });
    }
  });

export type ImageOptimizeResultDescriptor = z.infer<typeof imageOptimizeResultDescriptorSchema>;

export const imageOptimizeStatusResponseSchema = createToolJobStatusEnvelopeSchema(
  imageOptimizePhaseSchema,
  imageOptimizeResultDescriptorSchema,
);

export type ImageOptimizeStatusResponseV1 = z.infer<typeof imageOptimizeStatusResponseSchema>;

export const imageOptimizePolicyRequestSchema = z
  .object({
    contract: z.literal(TOOL_JOB_CONTRACT_ID),
    toolContract: z.literal(IMAGE_OPTIMIZE_CONTRACT_ID),
    anonymousSessionId: z.uuid(),
  })
  .strict();

export type ImageOptimizePolicyRequestV1 = z.infer<typeof imageOptimizePolicyRequestSchema>;

const serverTemporaryResultDeletionSchema = z
  .object({
    mode: z.literal("server-temporary"),
    acknowledged: z.literal("immediate-delete-attempt"),
    unacknowledgedDueSeconds: z.literal(1800),
    applicationSloSeconds: z.literal(2100),
    lifecycleExpirationDays: z.literal(1),
    exceptionalDelayPossible: z.literal(true),
  })
  .strict();

const notUploadedResultDeletionSchema = z.object({ mode: z.literal("not-uploaded") }).strict();

export const imageOptimizePolicyResponseSchema = z
  .object({
    contract: z.literal(TOOL_JOB_CONTRACT_ID),
    toolContract: z.literal(IMAGE_OPTIMIZE_CONTRACT_ID),
    execution: z.enum(["server", "local"]),
    reason: z.enum(["SERVER_PROCESSING_DISABLED", "LOCAL_FALLBACK_REQUIRED"]).nullable(),
    maintainer: z.boolean(),
    disclosure: z
      .object({
        upload: z.boolean(),
        inputDeletion: z.enum(["terminal", "not-uploaded"]),
        resultDeletion: z.union([
          serverTemporaryResultDeletionSchema,
          notUploadedResultDeletionSchema,
        ]),
      })
      .strict(),
    limits: z
      .object({
        maxFiles: z.literal(IMAGE_OPTIMIZE_MAX_FILES),
        maxBytesPerFile: z.literal(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
        maxPixelsPerFile: z.literal(IMAGE_OPTIMIZE_MAX_PIXELS),
      })
      .strict(),
  })
  .strict();

export type ImageOptimizePolicyResponseV1 = z.infer<typeof imageOptimizePolicyResponseSchema>;
