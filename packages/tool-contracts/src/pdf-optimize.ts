import { z } from "zod";
import {
  createToolJobCreateResponseSchema,
  createToolJobUploadDescriptorSchema,
  TOOL_JOB_CONTRACT_ID,
} from "./tool-job";

export const PDF_OPTIMIZE_CONTRACT_ID = "pdf.optimize@1" as const;
export const PDF_OPTIMIZE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PDF_OPTIMIZE_MAX_PAGES = 100;

export const pdfOptimizeMimeSchema = z.literal("application/pdf");

export type PdfOptimizeMime = z.infer<typeof pdfOptimizeMimeSchema>;

const positiveSafeIntegerSchema = z.number().finite().int().min(1).max(Number.MAX_SAFE_INTEGER);
const buildIdSchema = z.string().min(1);
const anonymousSessionIdSchema = z.uuid();
const jobTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const pdfOptimizeSpecV1Schema = z
  .object({
    version: z.literal(1),
    preset: z.enum(["balanced", "minimum"]),
  })
  .strict();

export type PdfOptimizeSpecV1 = z.infer<typeof pdfOptimizeSpecV1Schema>;

const pdfOptimizeInputSchema = z
  .object({
    byteLength: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
    mime: pdfOptimizeMimeSchema,
    pageCount: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
  })
  .strict();

export const pdfOptimizeCreateRequestSchema = z
  .object({
    contract: z.literal(TOOL_JOB_CONTRACT_ID),
    toolContract: z.literal(PDF_OPTIMIZE_CONTRACT_ID),
    anonymousSessionId: anonymousSessionIdSchema,
    clientRequestId: z.uuid(),
    jobToken: jobTokenSchema,
    spec: pdfOptimizeSpecV1Schema,
    input: pdfOptimizeInputSchema,
  })
  .strict();

export type PdfOptimizeCreateRequestV1 = z.infer<typeof pdfOptimizeCreateRequestSchema>;

export const pdfOptimizeUploadDescriptorSchema =
  createToolJobUploadDescriptorSchema(pdfOptimizeMimeSchema);

export type PdfOptimizeUploadDescriptor = z.infer<typeof pdfOptimizeUploadDescriptorSchema>;

export const pdfOptimizeCreateResponseSchema =
  createToolJobCreateResponseSchema(pdfOptimizeMimeSchema);

export type PdfOptimizeCreateResponse = z.infer<typeof pdfOptimizeCreateResponseSchema>;

export const pdfOptimizeWarningCodeSchema = z.enum([
  "SIGNATURES_INVALIDATED",
  "EMBEDDED_IMAGE_QUALITY_CHANGED",
  "ORIGINAL_RETAINED_UNMODIFIED",
]);

export type PdfOptimizeWarningCode = z.infer<typeof pdfOptimizeWarningCodeSchema>;

const structuralDownloadResultSchema = z
  .object({
    kind: z.literal("download"),
    mime: pdfOptimizeMimeSchema,
    sourceByteLength: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
    byteLength: positiveSafeIntegerSchema,
    pageCount: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
    profile: z.literal("structural"),
    engineBuildId: buildIdSchema,
    warnings: z.tuple([z.literal("SIGNATURES_INVALIDATED")]).readonly(),
  })
  .strict();

const imageOptimizedDownloadResultSchema = z
  .object({
    kind: z.literal("download"),
    mime: pdfOptimizeMimeSchema,
    sourceByteLength: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
    byteLength: positiveSafeIntegerSchema,
    pageCount: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
    profile: z.literal("image-optimized"),
    engineBuildId: buildIdSchema,
    warnings: z
      .tuple([z.literal("SIGNATURES_INVALIDATED"), z.literal("EMBEDDED_IMAGE_QUALITY_CHANGED")])
      .readonly(),
  })
  .strict();

const originalRetainedResultSchema = z
  .object({
    kind: z.literal("original-retained"),
    sourceByteLength: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
    pageCount: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
    engineBuildId: buildIdSchema,
    warnings: z.tuple([z.literal("ORIGINAL_RETAINED_UNMODIFIED")]).readonly(),
  })
  .strict();

function enforceSmallerOnly(
  result:
    | z.output<typeof structuralDownloadResultSchema>
    | z.output<typeof imageOptimizedDownloadResultSchema>,
  context: z.RefinementCtx,
): void {
  const maximumByteLength =
    result.sourceByteLength - Math.max(1, Math.ceil(result.sourceByteLength / 100));
  if (result.byteLength > maximumByteLength) {
    context.addIssue({
      code: "custom",
      message: "PDF 결과는 원본보다 최소 1% 작아야 합니다.",
      path: ["byteLength"],
    });
  }
}

export const pdfOptimizeResultDescriptorSchema = z
  .union([
    structuralDownloadResultSchema,
    imageOptimizedDownloadResultSchema,
    originalRetainedResultSchema,
  ])
  .superRefine((result, context) => {
    if (result.kind === "download") {
      enforceSmallerOnly(result, context);
    }
  });

export type PdfOptimizeResult = z.infer<typeof pdfOptimizeResultDescriptorSchema>;
export type PdfOptimizeResultDescriptor = PdfOptimizeResult;

export const pdfOptimizePhaseSchema = z.enum([
  "uploading",
  "queued",
  "validating",
  "optimizing",
  "verifying",
  "preparing-output",
  "completed",
]);

export type PdfOptimizePhase = z.infer<typeof pdfOptimizePhaseSchema>;

function createPdfOptimizeErrorSchema<
  Code extends string,
  Message extends string,
  Retryable extends boolean,
>(code: Code, message: Message, retryable: Retryable) {
  return z
    .object({
      code: z.literal(code),
      message: z.literal(message),
      retryable: z.literal(retryable),
    })
    .strict();
}

const pdfOptimizeFailureErrorSchemas = [
  createPdfOptimizeErrorSchema(
    "UNSUPPORTED_INPUT",
    "이 PDF는 처리 서버에서 압축할 수 없습니다.",
    false,
  ),
  createPdfOptimizeErrorSchema(
    "UNSUPPORTED_FEATURE",
    "이 PDF 기능은 처리 서버에서 지원하지 않습니다.",
    false,
  ),
  createPdfOptimizeErrorSchema("INPUT_LIMIT_EXCEEDED", "PDF가 처리 제한을 초과했습니다.", false),
  createPdfOptimizeErrorSchema(
    "SERVER_PROCESSING_DISABLED",
    "처리 서버를 현재 사용할 수 없습니다.",
    true,
  ),
  createPdfOptimizeErrorSchema(
    "LOCAL_FALLBACK_REQUIRED",
    "브라우저에서 원본 PDF를 유지합니다.",
    false,
  ),
  createPdfOptimizeErrorSchema("UPLOAD_EXPIRED", "PDF 업로드 시간이 만료되었습니다.", true),
  createPdfOptimizeErrorSchema("UPLOAD_MISMATCH", "업로드한 PDF를 확인할 수 없습니다.", true),
  createPdfOptimizeErrorSchema("QUEUE_UNAVAILABLE", "처리 서버를 현재 사용할 수 없습니다.", true),
  createPdfOptimizeErrorSchema(
    "ENGINE_TIMEOUT",
    "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
    true,
  ),
  createPdfOptimizeErrorSchema("ENGINE_OOM", "처리 서버에서 PDF 압축을 완료하지 못했습니다.", true),
  createPdfOptimizeErrorSchema(
    "ENGINE_CRASH",
    "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
    true,
  ),
  createPdfOptimizeErrorSchema("STORAGE_FAILURE", "PDF 처리 결과를 저장할 수 없습니다.", true),
  createPdfOptimizeErrorSchema("VERIFICATION_FAILED", "PDF 처리 결과를 확인할 수 없습니다.", true),
] as const;

const pdfOptimizeCancelledErrorSchema = createPdfOptimizeErrorSchema(
  "CANCELLED",
  "PDF 압축을 취소했습니다.",
  false,
);
const pdfOptimizeExpiredErrorSchema = createPdfOptimizeErrorSchema(
  "EXPIRED",
  "PDF 압축 결과가 만료되었습니다.",
  false,
);

export const pdfOptimizeFailureErrorPayloadSchema = z.discriminatedUnion(
  "code",
  pdfOptimizeFailureErrorSchemas,
);

export const pdfOptimizeErrorPayloadSchema = z.discriminatedUnion("code", [
  ...pdfOptimizeFailureErrorSchemas,
  pdfOptimizeCancelledErrorSchema,
  pdfOptimizeExpiredErrorSchema,
]);

export type PdfOptimizeErrorPayload = z.infer<typeof pdfOptimizeErrorPayloadSchema>;

const pdfOptimizeStatusCommonShape = {
  contract: z.literal(TOOL_JOB_CONTRACT_ID),
  jobId: z.uuid(),
  sequence: z.number().int().min(0),
  attempt: z.number().int().min(0),
  actualWeightedUnits: z.number().finite().min(0).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
};

const pendingPdfOptimizeStatusSchema = z
  .object({
    ...pdfOptimizeStatusCommonShape,
    state: z.enum(["created", "uploading", "queued", "running"]),
    phase: pdfOptimizePhaseSchema,
    phaseFraction: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

const succeededPdfOptimizeStatusSchema = z
  .object({
    ...pdfOptimizeStatusCommonShape,
    state: z.literal("succeeded"),
    phase: z.literal("completed"),
    phaseFraction: z.literal(1),
    result: pdfOptimizeResultDescriptorSchema,
  })
  .strict();

const failedPdfOptimizeStatusSchema = z
  .object({
    ...pdfOptimizeStatusCommonShape,
    state: z.literal("failed"),
    phase: pdfOptimizePhaseSchema,
    phaseFraction: z.number().finite().min(0).max(1).nullable(),
    error: pdfOptimizeFailureErrorPayloadSchema,
  })
  .strict();

const cancelledPdfOptimizeStatusSchema = z
  .object({
    ...pdfOptimizeStatusCommonShape,
    state: z.literal("cancelled"),
    phase: pdfOptimizePhaseSchema,
    phaseFraction: z.number().finite().min(0).max(1).nullable(),
    error: pdfOptimizeCancelledErrorSchema,
  })
  .strict();

const expiredPdfOptimizeStatusSchema = z
  .object({
    ...pdfOptimizeStatusCommonShape,
    state: z.literal("expired"),
    phase: pdfOptimizePhaseSchema,
    phaseFraction: z.number().finite().min(0).max(1).nullable(),
    error: pdfOptimizeExpiredErrorSchema,
  })
  .strict();

export const pdfOptimizeStatusResponseSchema = z.discriminatedUnion("state", [
  pendingPdfOptimizeStatusSchema,
  succeededPdfOptimizeStatusSchema,
  failedPdfOptimizeStatusSchema,
  cancelledPdfOptimizeStatusSchema,
  expiredPdfOptimizeStatusSchema,
]);

export type PdfOptimizeStatusResponseV1 = z.infer<typeof pdfOptimizeStatusResponseSchema>;

export const pdfOptimizePolicyRequestSchema = z
  .object({
    contract: z.literal(TOOL_JOB_CONTRACT_ID),
    toolContract: z.literal(PDF_OPTIMIZE_CONTRACT_ID),
    anonymousSessionId: anonymousSessionIdSchema,
  })
  .strict();

export type PdfOptimizePolicyRequestV1 = z.infer<typeof pdfOptimizePolicyRequestSchema>;

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

const pdfOptimizePolicyLimitsSchema = z
  .object({
    maxFiles: z.literal(1),
    maxBytesPerFile: z.literal(PDF_OPTIMIZE_MAX_FILE_BYTES),
    maxPagesPerFile: z.literal(PDF_OPTIMIZE_MAX_PAGES),
  })
  .strict();

const policyCommonShape = {
  contract: z.literal(TOOL_JOB_CONTRACT_ID),
  toolContract: z.literal(PDF_OPTIMIZE_CONTRACT_ID),
  maintainer: z.boolean(),
  limits: pdfOptimizePolicyLimitsSchema,
};

export const pdfOptimizePolicyResponseSchema = z.discriminatedUnion("execution", [
  z
    .object({
      ...policyCommonShape,
      execution: z.literal("server"),
      reason: z.null(),
      maintainer: z.boolean(),
      disclosure: z
        .object({
          upload: z.literal(true),
          inputDeletion: z.literal("terminal"),
          resultDeletion: serverTemporaryResultDeletionSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...policyCommonShape,
      execution: z.literal("local"),
      reason: z.enum(["SERVER_PROCESSING_DISABLED", "LOCAL_FALLBACK_REQUIRED"]),
      disclosure: z
        .object({
          upload: z.literal(false),
          inputDeletion: z.literal("not-uploaded"),
          resultDeletion: notUploadedResultDeletionSchema,
        })
        .strict(),
    })
    .strict(),
]);

export type PdfOptimizePolicyResponseV1 = z.infer<typeof pdfOptimizePolicyResponseSchema>;
