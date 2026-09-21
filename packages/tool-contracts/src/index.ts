import { z } from "zod";

export * from "./image-optimize.ts";
export * from "./product-usage.ts";
export * from "./tool-job.ts";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const IMAGE_TOOL_ID = "image.pipeline" as const;
export const IMAGE_TOOL_VERSION = 2 as const;
export const IMAGE_WATERMARK_TOOL_ID = "image.watermark" as const;
export const IMAGE_WATERMARK_TOOL_VERSION = 1 as const;
export const JSON_FORMAT_TOOL_ID = "json.format" as const;
export const JSON_FORMAT_TOOL_VERSION = 1 as const;

const positiveDimension = z.number().int().min(1).max(16_384);
const quality = z.number().int().min(1).max(100);
const sourceRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .strict()
  .refine((value) => value.x + value.width <= 1, {
    message: "자르기 영역이 이미지 너비를 벗어날 수 없습니다.",
    path: ["width"],
  })
  .refine((value) => value.y + value.height <= 1, {
    message: "자르기 영역이 이미지 높이를 벗어날 수 없습니다.",
    path: ["height"],
  });

export type ImageSourceRect = z.input<typeof sourceRectSchema>;
export const imageRotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type ImageRotation = z.infer<typeof imageRotationSchema>;
export const imageRotationScopeSchema = z.enum(["all", "portrait", "landscape"]);
export type ImageRotationScope = z.infer<typeof imageRotationScopeSchema>;

function isSafeWatermarkText(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code > 31 &&
      code !== 127 &&
      (code < 0x202a || code > 0x202e) &&
      (code < 0x2066 || code > 0x2069)
    );
  });
}

const safeWatermarkTextSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.normalize("NFC"))
  .refine((value) => Array.from(value).length <= 80, {
    message: "워터마크는 80자를 초과할 수 없습니다.",
  })
  .refine(isSafeWatermarkText, {
    message: "워터마크에는 제어 문자를 사용할 수 없습니다.",
  });

function isSingleLineImageWatermarkText(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x80 || code > 0x9f) && code !== 0x2028 && code !== 0x2029;
  });
}

const imageWatermarkTextSchema = safeWatermarkTextSchema.refine(isSingleLineImageWatermarkText, {
  message: "이미지 워터마크는 한 줄로 입력해야 합니다.",
});

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
    kind: z.literal("percentage"),
    percent: z.number().int().min(1).max(400),
    allowUpscale: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("cover"),
    width: positiveDimension,
    height: positiveDimension,
    sourceRect: sourceRectSchema.optional(),
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

const jpegImageOutputSchema = z.object({
  format: z.literal("jpeg"),
  compression: lossyCompressionSchema,
  matte: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#ffffff"),
});
const webpImageOutputSchema = z.object({
  format: z.literal("webp"),
  compression: lossyCompressionSchema,
});
const pngImageOutputSchema = z.object({
  format: z.literal("png"),
  compression: z.object({ mode: z.literal("lossless") }),
});

export const imageOutputV1Schema = z.discriminatedUnion("format", [
  jpegImageOutputSchema,
  webpImageOutputSchema,
  pngImageOutputSchema,
]);

export const imageOutputSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("source"),
    compression: z.object({ mode: z.literal("quality"), quality }),
  }),
  jpegImageOutputSchema,
  webpImageOutputSchema,
  pngImageOutputSchema,
]);

export const imagePipelineSpecV1Schema = z
  .object({
    version: z.literal(1),
    resize: resizeSpecSchema,
    output: imageOutputV1Schema,
    rotationScope: imageRotationScopeSchema.optional(),
    sizeGoal: imageSizeGoalSchema.default({ mode: "allow-growth" }),
    autoOrient: z.literal(true),
    metadata: z.literal("strip"),
  })
  .superRefine((value, context) => {
    if (value.rotationScope !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["rotationScope"],
        message: "회전 방향 필터는 이미지 파이프라인 v2에서만 사용할 수 있습니다.",
      });
    }
    if (
      (value.resize.kind === "cover" && value.resize.sourceRect !== undefined) ||
      value.resize.kind === "percentage"
    ) {
      context.addIssue({
        code: "custom",
        path: ["resize", "sourceRect"],
        message: "자유 자르기 영역은 이미지 파이프라인 v2에서만 사용할 수 있습니다.",
      });
    }
  });

export const imagePipelineSpecV2Schema = z.object({
  version: z.literal(2),
  resize: resizeSpecSchema,
  rotation: imageRotationSchema.default(0),
  rotationScope: imageRotationScopeSchema.default("all"),
  output: imageOutputSchema,
  sizeGoal: imageSizeGoalSchema.default({ mode: "allow-growth" }),
  autoOrient: z.literal(true),
  metadata: z.literal("strip"),
});

export const imagePipelineSpecSchema = z.discriminatedUnion("version", [
  imagePipelineSpecV1Schema,
  imagePipelineSpecV2Schema,
]);

export const imageWatermarkSpecSchema = z
  .object({
    version: z.literal(1),
    watermark: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("text"),
          text: imageWatermarkTextSchema,
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          sizePercent: z.number().int().min(4).max(30),
          shadow: z
            .object({
              color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
              blurPercent: z.number().int().min(0).max(20),
              offsetPercent: z.number().int().min(0).max(10),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("logo"),
          widthPercent: z.number().int().min(5).max(50),
        })
        .strict(),
    ]),
    position: z.enum([
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "center",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]),
    marginPercent: z.number().int().min(0).max(10),
    opacity: z.number().min(0.05).max(1),
    output: z.discriminatedUnion("format", [
      z
        .object({
          format: z.literal("source"),
          quality: z.number().int().min(40).max(95),
        })
        .strict(),
      z
        .object({
          format: z.literal("jpeg"),
          quality: z.number().int().min(40).max(95),
          matte: z.literal("#ffffff"),
        })
        .strict(),
      z
        .object({
          format: z.literal("webp"),
          quality: z.number().int().min(40).max(95),
        })
        .strict(),
      z.object({ format: z.literal("png") }).strict(),
    ]),
    autoOrient: z.literal(true),
    metadata: z.literal("strip"),
  })
  .strict();

export type ResizeSpec = z.input<typeof resizeSpecSchema>;
export type ImageOutput = z.input<typeof imageOutputSchema>;
export type ImagePipelineSpecV1 = z.input<typeof imagePipelineSpecV1Schema>;
export type ParsedImagePipelineSpecV1 = z.output<typeof imagePipelineSpecV1Schema>;
export type ImagePipelineSpecV2 = z.input<typeof imagePipelineSpecV2Schema>;
export type ParsedImagePipelineSpecV2 = z.output<typeof imagePipelineSpecV2Schema>;
export type ImagePipelineSpec = z.input<typeof imagePipelineSpecSchema>;
export type ParsedImagePipelineSpec = z.output<typeof imagePipelineSpecSchema>;
export type ImageWatermarkSpecV1 = z.input<typeof imageWatermarkSpecSchema>;
export type ParsedImageWatermarkSpecV1 = z.output<typeof imageWatermarkSpecSchema>;
export type ImageWatermarkPosition = ImageWatermarkSpecV1["position"];

export type ImagePhase = "validating" | "decoding" | "transforming" | "encoding" | "finalizing";

export type ImageWarning =
  | "TARGET_SIZE_NOT_REACHED"
  | "UPSCALING_SKIPPED"
  | "COLOR_PROFILE_NORMALIZED";

export interface ImagePipelineResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
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

export interface WorkerFileInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  file: File;
}

export type ImageWorkerFileInput = WorkerFileInput;
export type ImageWatermarkWorkerFileInput = WorkerFileInput;

export interface ImageRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "image.pipeline";
  toolVersion: typeof IMAGE_TOOL_VERSION;
  input: ImageWorkerFileInput;
  spec: ImagePipelineSpec;
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
  spec: ImagePipelineSpec;
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

export interface ImageWatermarkInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  bytes: ArrayBuffer;
}

export type ImageWatermarkLogoInput = ImageWatermarkInput;

export type ImageWatermarkPhase =
  | "validating"
  | "decoding"
  | "compositing"
  | "encoding"
  | "finalizing";

export type ImageWatermarkWarning = "SOURCE_FORMAT_CONVERTED" | "COLOR_PROFILE_NORMALIZED";

export interface ImageWatermarkResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  sourceByteLength: number;
  byteLength: number;
  format: "jpeg" | "png" | "webp";
  warnings: ImageWatermarkWarning[];
  timing: {
    inspectMs: number;
    decodeMs: number;
    compositeMs: number;
    encodeMs: number;
    totalMs: number;
  };
}

export type ImageWatermarkErrorCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_INPUT"
  | "ANIMATED_INPUT"
  | "CORRUPT_INPUT"
  | "DIMENSION_LIMIT"
  | "MEMORY_LIMIT"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "LOGO_REQUIRED"
  | "CANCELLED"
  | "WORKER_CRASH";

export interface ImageWatermarkErrorPayload {
  code: ImageWatermarkErrorCode;
  message: string;
  retryable: boolean;
}

export type ImageWatermarkWorkerRequest =
  | {
      protocol: 1;
      type: "configure-logo";
      assetId: string;
      tool: typeof IMAGE_WATERMARK_TOOL_ID;
      toolVersion: typeof IMAGE_WATERMARK_TOOL_VERSION;
      input: ImageWatermarkWorkerFileInput;
    }
  | {
      protocol: 1;
      type: "run";
      jobId: string;
      tool: typeof IMAGE_WATERMARK_TOOL_ID;
      toolVersion: typeof IMAGE_WATERMARK_TOOL_VERSION;
      input: ImageWatermarkWorkerFileInput;
      spec: ImageWatermarkSpecV1;
      logoAssetId?: string;
    }
  | {
      protocol: 1;
      type: "cancel";
      jobId: string;
    };

export type ImageWatermarkWorkerEvent =
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
      type: "logo-ready";
      assetId: string;
    }
  | {
      protocol: 1;
      type: "logo-failed";
      assetId: string;
      error: ImageWatermarkErrorPayload;
    }
  | {
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
      phase: ImageWatermarkPhase;
      fraction: number;
    }
  | {
      protocol: 1;
      type: "complete";
      jobId: string;
      result: ImageWatermarkResult;
    }
  | {
      protocol: 1;
      type: "failed";
      jobId: string;
      error: ImageWatermarkErrorPayload;
    };

export interface ImageWatermarkBatchItem {
  itemId: string;
  file: File;
  spec: ImageWatermarkSpecV1;
}

export type ImageWatermarkBatchItemResult =
  | { itemId: string; status: "fulfilled"; value: ImageWatermarkResult }
  | { itemId: string; status: "rejected"; error: ImageWatermarkErrorPayload }
  | { itemId: string; status: "cancelled" };

export type ImageWatermarkRuntimeEvent =
  | { type: "item-progress"; itemId: string; phase: ImageWatermarkPhase; fraction: number }
  | { type: "item-complete"; itemId: string; result: ImageWatermarkBatchItemResult }
  | { type: "batch-progress"; completed: number; total: number };

export interface ImageWatermarkBatchHandle {
  result: Promise<readonly ImageWatermarkBatchItemResult[]>;
  cancel(): void;
}

export interface ToolPreset {
  id: string;
  name: string;
  description: string;
  badge: string;
  spec: ImagePipelineSpecV2;
}
