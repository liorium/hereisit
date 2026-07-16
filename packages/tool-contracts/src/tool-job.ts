import { z } from "zod";

export const TOOL_JOB_CONTRACT_ID = "tool-job@1" as const;

export const toolJobStateSchema = z.enum([
  "created",
  "uploading",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export type ToolJobState = z.infer<typeof toolJobStateSchema>;

export const toolJobErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNSUPPORTED_INPUT",
  "UNSUPPORTED_FEATURE",
  "INPUT_LIMIT_EXCEEDED",
  "PIXEL_LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "SERVER_PROCESSING_DISABLED",
  "LOCAL_FALLBACK_REQUIRED",
  "UPLOAD_EXPIRED",
  "UPLOAD_MISMATCH",
  "QUEUE_UNAVAILABLE",
  "ENGINE_TIMEOUT",
  "ENGINE_OOM",
  "ENGINE_CRASH",
  "STORAGE_FAILURE",
  "VERIFICATION_FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export type ToolJobErrorCode = z.infer<typeof toolJobErrorCodeSchema>;

export const toolJobErrorPayloadSchema = z
  .object({
    code: toolJobErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    guidance: z.literal("TRY_BALANCED_PRESET").optional(),
  })
  .strict();

export type ToolJobErrorPayload = z.infer<typeof toolJobErrorPayloadSchema>;

const offsetDateTimeSchema = z.iso.datetime({ offset: true });
const nonNegativeFiniteNumberSchema = z.number().finite().min(0);
const positiveByteLengthSchema = z.number().int().min(1);
const jobUploadPathSchema = z
  .templateLiteral(["/v1/jobs/", z.string(), "/input"])
  .refine((path) => /^\/v1\/jobs\/[^/]+\/input$/.test(path), {
    message: "업로드 경로는 작업 입력 경로여야 합니다.",
  });

export type ToolJobUploadDescriptor<ContentType extends string = string> = {
  kind: "worker-stream-put";
  method: "PUT";
  path: `/v1/jobs/${string}/input`;
  contentType: ContentType;
  byteLength: number;
  expiresAt: string;
};

export function createToolJobUploadDescriptorSchema<ContentTypeSchema extends z.ZodType<string>>(
  contentTypeSchema: ContentTypeSchema,
) {
  return z
    .object({
      kind: z.literal("worker-stream-put"),
      method: z.literal("PUT"),
      path: jobUploadPathSchema,
      contentType: contentTypeSchema,
      byteLength: positiveByteLengthSchema,
      expiresAt: offsetDateTimeSchema,
    })
    .strict();
}

export const toolJobUploadDescriptorSchema = createToolJobUploadDescriptorSchema(z.string().min(1));

const existingToolJobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export type ToolJobCreateResponse<ContentType extends string = string> =
  | {
      contract: typeof TOOL_JOB_CONTRACT_ID;
      mode: "upload-required";
      jobId: string;
      upload: ToolJobUploadDescriptor<ContentType>;
      reservedWeightedUnits: number;
    }
  | {
      contract: typeof TOOL_JOB_CONTRACT_ID;
      mode: "existing-job";
      jobId: string;
      state: Exclude<ToolJobState, "created" | "uploading">;
      reservedWeightedUnits: number;
    };

export function createToolJobCreateResponseSchema<ContentTypeSchema extends z.ZodType<string>>(
  contentTypeSchema: ContentTypeSchema,
) {
  const uploadDescriptorSchema = createToolJobUploadDescriptorSchema(contentTypeSchema);

  return z
    .discriminatedUnion("mode", [
      z
        .object({
          contract: z.literal(TOOL_JOB_CONTRACT_ID),
          mode: z.literal("upload-required"),
          jobId: z.uuid(),
          upload: uploadDescriptorSchema,
          reservedWeightedUnits: nonNegativeFiniteNumberSchema,
        })
        .strict(),
      z
        .object({
          contract: z.literal(TOOL_JOB_CONTRACT_ID),
          mode: z.literal("existing-job"),
          jobId: z.uuid(),
          state: existingToolJobStateSchema,
          reservedWeightedUnits: nonNegativeFiniteNumberSchema,
        })
        .strict(),
    ])
    .superRefine((response, context) => {
      if (
        response.mode === "upload-required" &&
        response.upload.path !== `/v1/jobs/${response.jobId}/input`
      ) {
        context.addIssue({
          code: "custom",
          message: "업로드 경로는 응답의 작업 ID와 일치해야 합니다.",
          path: ["upload", "path"],
        });
      }
    });
}

export const toolJobCreateResponseSchema = createToolJobCreateResponseSchema(z.string().min(1));

export const toolJobMutationAcknowledgementSchema = z
  .object({
    contract: z.literal(TOOL_JOB_CONTRACT_ID),
    jobId: z.uuid(),
    action: z.enum(["uploaded", "cancelled", "downloaded", "deleted"]),
    acknowledged: z.literal(true),
  })
  .strict();

export type ToolJobMutationAcknowledgement = z.infer<typeof toolJobMutationAcknowledgementSchema>;

export const toolJobErrorResponseSchema = z
  .object({
    contract: z.literal(TOOL_JOB_CONTRACT_ID),
    error: toolJobErrorPayloadSchema,
  })
  .strict();

export type ToolJobErrorResponse = z.infer<typeof toolJobErrorResponseSchema>;

export type ToolJobStatusEnvelope<Phase extends string, Result> = {
  contract: typeof TOOL_JOB_CONTRACT_ID;
  jobId: string;
  state: ToolJobState;
  phase: Phase;
  phaseFraction: number | null;
  sequence: number;
  attempt: number;
  result?: Result;
  error?: ToolJobErrorPayload;
  actualWeightedUnits?: number;
  updatedAt: string;
};

function addStatusIssue(context: z.RefinementCtx, path: "result" | "error", message: string): void {
  context.addIssue({
    code: "custom",
    message,
    path: [path],
  });
}

export function createToolJobStatusEnvelopeSchema<
  PhaseSchema extends z.ZodType<string>,
  ResultSchema extends z.ZodType,
>(phaseSchema: PhaseSchema, resultSchema: ResultSchema) {
  return z
    .object({
      contract: z.literal(TOOL_JOB_CONTRACT_ID),
      jobId: z.uuid(),
      state: toolJobStateSchema,
      phase: phaseSchema,
      phaseFraction: z.number().finite().min(0).max(1).nullable(),
      sequence: z.number().int().min(0),
      attempt: z.number().int().min(0),
      result: resultSchema.optional(),
      error: toolJobErrorPayloadSchema.optional(),
      actualWeightedUnits: nonNegativeFiniteNumberSchema.optional(),
      updatedAt: offsetDateTimeSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.state === "succeeded") {
        if (value.result === undefined) {
          addStatusIssue(context, "result", "성공한 작업에는 결과가 필요합니다.");
        }
        if (value.error !== undefined) {
          addStatusIssue(context, "error", "성공한 작업에는 오류가 없어야 합니다.");
        }
        return;
      }

      if (value.state === "failed") {
        if (value.result !== undefined) {
          addStatusIssue(context, "result", "실패한 작업에는 결과가 없어야 합니다.");
        }
        if (value.error === undefined || value.error.code === "CANCELLED") {
          addStatusIssue(context, "error", "실패한 작업에는 실패 오류가 필요합니다.");
        }
        return;
      }

      if (value.state === "cancelled") {
        if (value.result !== undefined) {
          addStatusIssue(context, "result", "취소된 작업에는 결과가 없어야 합니다.");
        }
        if (value.error?.code !== "CANCELLED") {
          addStatusIssue(context, "error", "취소된 작업에는 취소 오류가 필요합니다.");
        }
        return;
      }

      if (value.state === "expired") {
        if (value.result !== undefined) {
          addStatusIssue(context, "result", "만료된 작업에는 결과가 없어야 합니다.");
        }
        if (value.error?.code !== "EXPIRED") {
          addStatusIssue(context, "error", "만료된 작업에는 만료 오류가 필요합니다.");
        }
        return;
      }

      if (value.result !== undefined) {
        addStatusIssue(context, "result", "진행 중인 작업에는 결과가 없어야 합니다.");
      }
      if (value.error !== undefined) {
        addStatusIssue(context, "error", "진행 중인 작업에는 오류가 없어야 합니다.");
      }
    });
}

export const toolJobStatusEnvelopeSchema = createToolJobStatusEnvelopeSchema;
