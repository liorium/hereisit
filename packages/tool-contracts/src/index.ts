import { z } from "zod";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const IMAGE_TOOL_ID = "image.pipeline" as const;
export const IMAGE_TOOL_VERSION = 1 as const;

const positiveDimension = z.number().int().min(1).max(16_384);
const quality = z.number().int().min(1).max(100);

export const imageSizeGoalSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("allow-growth") }),
  z.object({
    mode: z.literal("smaller-only"),
    minSavingsPercent: z.number().min(0).max(50).default(1),
    minQuality: quality.default(35),
    maxAttempts: z.number().int().min(1).max(10).default(6),
  }),
]);

export const resizeSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z
    .object({
      kind: z.literal("inside"),
      maxWidth: positiveDimension.optional(),
      maxHeight: positiveDimension.optional(),
      allowUpscale: z.boolean().default(false),
    })
    .refine((value) => value.maxWidth !== undefined || value.maxHeight !== undefined, {
      message: "최대 너비 또는 높이 중 하나가 필요합니다.",
    }),
  z.object({
    kind: z.literal("cover"),
    width: positiveDimension,
    height: positiveDimension,
    focalPoint: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("stretch"),
    width: positiveDimension,
    height: positiveDimension,
  }),
]);

export const lossyCompressionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("quality"), quality }),
  z
    .object({
      mode: z.literal("maxBytes"),
      maxBytes: z
        .number()
        .int()
        .min(4_096)
        .max(100 * 1024 * 1024),
      minQuality: quality.default(35),
      maxQuality: quality.default(92),
      maxAttempts: z.number().int().min(1).max(10).default(6),
    })
    .refine((value) => value.minQuality <= value.maxQuality, {
      message: "최소 품질은 최대 품질보다 클 수 없습니다.",
      path: ["maxQuality"],
    }),
]);

export const imageOutputSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("jpeg"),
    compression: lossyCompressionSchema,
    matte: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#ffffff"),
  }),
  z.object({
    format: z.literal("webp"),
    compression: lossyCompressionSchema,
  }),
  z.object({
    format: z.literal("png"),
    compression: z.object({ mode: z.literal("lossless") }),
  }),
]);

export const imagePipelineSpecSchema = z.object({
  version: z.literal(1),
  resize: resizeSpecSchema,
  output: imageOutputSchema,
  sizeGoal: imageSizeGoalSchema.default({ mode: "allow-growth" }),
  autoOrient: z.literal(true),
  metadata: z.literal("strip"),
});

export type ResizeSpec = z.input<typeof resizeSpecSchema>;
export type ImageOutput = z.input<typeof imageOutputSchema>;
export type ImagePipelineSpecV1 = z.input<typeof imagePipelineSpecSchema>;
export type ParsedImagePipelineSpecV1 = z.output<typeof imagePipelineSpecSchema>;

export type ImagePhase = "validating" | "decoding" | "transforming" | "encoding" | "finalizing";

export type ImageWarning =
  | "TARGET_SIZE_NOT_REACHED"
  | "UPSCALING_SKIPPED"
  | "COLOR_PROFILE_NORMALIZED";

export interface ImagePipelineResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  byteLength: number;
  warnings: ImageWarning[];
  timing: {
    inspectMs: number;
    decodeMs: number;
    transformMs: number;
    encodeMs: number;
    totalMs: number;
    encodeAttempts: number;
  };
}

export type ToolErrorCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_INPUT"
  | "ANIMATED_INPUT"
  | "CORRUPT_INPUT"
  | "DIMENSION_LIMIT"
  | "MEMORY_LIMIT"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "NO_SIZE_REDUCTION"
  | "CANCELLED"
  | "WORKER_CRASH";

export interface ToolErrorPayload {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
}

export interface ImageRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "image.pipeline";
  toolVersion: 1;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  };
  spec: ImagePipelineSpecV1;
}

export interface CancelRequest {
  protocol: 1;
  type: "cancel";
  jobId: string;
}

export type WorkerRequest = ImageRunRequest | CancelRequest;

export type WorkerEvent =
  | {
      protocol: 1;
      type: "ready";
      capabilities: {
        decode: readonly string[];
        encode: readonly string[];
        offscreenCanvas: boolean;
      };
    }
  | {
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
      phase: ImagePhase;
      fraction: number;
    }
  | {
      protocol: 1;
      type: "complete";
      jobId: string;
      result: ImagePipelineResult;
    }
  | {
      protocol: 1;
      type: "failed";
      jobId: string;
      error: ToolErrorPayload;
    };

export interface BatchImageItem {
  itemId: string;
  file: File;
  spec: ImagePipelineSpecV1;
}

export type BatchItemResult =
  | { itemId: string; status: "fulfilled"; value: ImagePipelineResult }
  | { itemId: string; status: "rejected"; error: ToolErrorPayload }
  | { itemId: string; status: "cancelled" };

export type BatchRuntimeEvent =
  | {
      type: "item-progress";
      itemId: string;
      phase: ImagePhase;
      fraction: number;
    }
  | { type: "item-complete"; itemId: string; result: BatchItemResult }
  | { type: "batch-progress"; completed: number; total: number };

export interface BatchHandle {
  result: Promise<readonly BatchItemResult[]>;
  cancel(): void;
}

export interface ToolPreset {
  id: string;
  name: string;
  description: string;
  badge: string;
  spec: ImagePipelineSpecV1;
}
