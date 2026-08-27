import { z } from "zod";

export * from "./image-optimize.ts";
export * from "./pdf-optimize.ts";
export * from "./product-usage.ts";
export * from "./tool-job.ts";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const IMAGE_TOOL_ID = "image.pipeline" as const;
export const IMAGE_TOOL_VERSION = 2 as const;
export const IMAGE_WATERMARK_TOOL_ID = "image.watermark" as const;
export const IMAGE_WATERMARK_TOOL_VERSION = 1 as const;
export const JSON_FORMAT_TOOL_ID = "json.format" as const;
export const JSON_FORMAT_TOOL_VERSION = 1 as const;
export const PDF_MERGE_TOOL_ID = "pdf.merge" as const;
export const PDF_SPLIT_TOOL_ID = "pdf.split" as const;
export const PDF_IMAGES_TO_PDF_TOOL_ID = "pdf.images-to-pdf" as const;
export const PDF_ORGANIZE_TOOL_ID = "pdf.organize" as const;
export const PDF_THUMBNAIL_TOOL_ID = "pdf.thumbnail" as const;
export const PDF_THUMBNAIL_TOOL_VERSION = 1 as const;
export const PDF_WATERMARK_TOOL_ID = "pdf.watermark" as const;
export const PDF_TOOL_VERSION = 1 as const;
export const PDF_TO_IMAGES_TOOL_ID = "pdf.to-images" as const;
export const PDF_TO_IMAGES_TOOL_VERSION = 1 as const;
export const PDF_COMPRESS_SCANNED_TOOL_ID = "pdf.compress-scanned" as const;
export const PDF_COMPRESS_SCANNED_TOOL_VERSION = 2 as const;

const positiveDimension = z.number().int().min(1).max(16_384);
const quality = z.number().int().min(1).max(100);
export const imageRotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type ImageRotation = z.infer<typeof imageRotationSchema>;

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

export const imagePipelineSpecV1Schema = z.object({
  version: z.literal(1),
  resize: resizeSpecSchema,
  output: imageOutputV1Schema,
  sizeGoal: imageSizeGoalSchema.default({ mode: "allow-growth" }),
  autoOrient: z.literal(true),
  metadata: z.literal("strip"),
});

export const imagePipelineSpecV2Schema = z.object({
  version: z.literal(2),
  resize: resizeSpecSchema,
  rotation: imageRotationSchema.default(0),
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

const pdfPageNumbersSchema = z
  .array(z.number().int().min(1).max(500))
  .min(1)
  .max(500)
  .refine((pages) => new Set(pages).size === pages.length, {
    message: "페이지 번호는 중복될 수 없습니다.",
  });

export const pdfPageSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("every-page") }),
  z.object({
    mode: z.literal("extract"),
    pages: pdfPageNumbersSchema,
  }),
]);

export const pdfImagePageSchema = z.discriminatedUnion("size", [
  z.object({
    size: z.literal("a4"),
    margin: z.number().int().min(0).max(72).default(24),
  }),
  z.object({ size: z.literal("image"), margin: z.literal(0).default(0) }),
]);

export const pdfOrganizePageSchema = z.object({
  sourcePage: z.number().int().min(1).max(500),
  rotateBy: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

export const pdfWatermarkSchema = z.object({
  text: safeWatermarkTextSchema,
  placement: z.enum(["center", "tile"]),
  fontSize: z.number().int().min(12).max(96),
  opacity: z.number().min(0.05).max(0.8),
  rotation: z.union([z.literal(-45), z.literal(0), z.literal(45)]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const pdfPipelineSpecSchema = z.discriminatedUnion("operation", [
  z.object({ version: z.literal(1), operation: z.literal("merge") }),
  z.object({
    version: z.literal(1),
    operation: z.literal("split"),
    selection: pdfPageSelectionSchema,
  }),
  z.object({
    version: z.literal(1),
    operation: z.literal("images-to-pdf"),
    page: pdfImagePageSchema,
  }),
  z.object({
    version: z.literal(1),
    operation: z.literal("organize"),
    pages: z
      .array(pdfOrganizePageSchema)
      .min(1)
      .max(500)
      .refine((pages) => new Set(pages.map((page) => page.sourcePage)).size === pages.length, {
        message: "같은 원본 페이지를 두 번 넣을 수 없습니다.",
      }),
  }),
  z.object({
    version: z.literal(1),
    operation: z.literal("watermark"),
    watermark: pdfWatermarkSchema,
    selection: pdfPageSelectionSchema,
  }),
]);

export type PdfPipelineSpecV1 = z.input<typeof pdfPipelineSpecSchema>;
export type ParsedPdfPipelineSpecV1 = z.output<typeof pdfPipelineSpecSchema>;
export type PdfToolId =
  | typeof PDF_MERGE_TOOL_ID
  | typeof PDF_SPLIT_TOOL_ID
  | typeof PDF_IMAGES_TO_PDF_TOOL_ID
  | typeof PDF_ORGANIZE_TOOL_ID
  | typeof PDF_WATERMARK_TOOL_ID;
export type PdfPhase = "validating" | "loading" | "processing" | "serializing" | "finalizing";

export type PdfWarning =
  | "DOCUMENT_FEATURES_MAY_CHANGE"
  | "SIGNATURES_INVALIDATED"
  | "IMAGE_COLOR_MAY_CHANGE"
  | "WATERMARK_TEXT_RASTERIZED";

export interface PdfPipelineResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "application/pdf" | "application/zip";
  byteLength: number;
  sourcePageCount: number;
  outputPageCount: number;
  outputDocumentCount: number;
  warnings: PdfWarning[];
  timing: {
    loadMs: number;
    processMs: number;
    saveMs: number;
    totalMs: number;
  };
}

export type PdfToolErrorCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_INPUT"
  | "PASSWORD_PROTECTED"
  | "CORRUPT_PDF"
  | "PAGE_RANGE_INVALID"
  | "PAGE_LIMIT"
  | "MEMORY_LIMIT"
  | "WRITE_FAILED"
  | "CANCELLED"
  | "WORKER_CRASH";

export interface PdfToolErrorPayload {
  code: PdfToolErrorCode;
  message: string;
  retryable: boolean;
}

export interface PdfRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: PdfToolId;
  toolVersion: 1;
  inputs: readonly {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  }[];
  spec: PdfPipelineSpecV1;
}

export interface PdfFileRunRequest {
  protocol: 1;
  type: "run-files";
  jobId: string;
  tool:
    | typeof PDF_MERGE_TOOL_ID
    | typeof PDF_SPLIT_TOOL_ID
    | typeof PDF_IMAGES_TO_PDF_TOOL_ID
    | typeof PDF_ORGANIZE_TOOL_ID;
  toolVersion: 1;
  inputs: readonly {
    name: string;
    mimeHint: string;
    byteLength: number;
    file: File;
  }[];
  spec: Extract<PdfPipelineSpecV1, { operation: "merge" | "split" | "images-to-pdf" | "organize" }>;
}

export interface PdfInspectRequest {
  protocol: 1;
  type: "inspect";
  jobId: string;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  };
}

export interface PdfFileInspectRequest {
  protocol: 1;
  type: "inspect";
  jobId: string;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    file: File;
  };
}

export interface PdfInspectionPage {
  sourcePage: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PdfInspectionResult {
  pageCount: number;
  pages: readonly PdfInspectionPage[];
}

export interface PdfCancelRequest {
  protocol: 1;
  type: "cancel";
  jobId: string;
}

export type PdfWorkerRequest =
  | PdfRunRequest
  | PdfFileRunRequest
  | PdfInspectRequest
  | PdfFileInspectRequest
  | PdfCancelRequest;

export type PdfWorkerEvent =
  | {
      protocol: 1;
      type: "ready";
      capabilities: { operations: readonly PdfToolId[] };
    }
  | {
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
      phase: PdfPhase;
      fraction: number;
    }
  | { protocol: 1; type: "inspected"; jobId: string; result: PdfInspectionResult }
  | { protocol: 1; type: "complete"; jobId: string; result: PdfPipelineResult }
  | { protocol: 1; type: "failed"; jobId: string; error: PdfToolErrorPayload };

export type PdfJobOutcome =
  | { status: "fulfilled"; value: PdfPipelineResult }
  | { status: "rejected"; error: PdfToolErrorPayload }
  | { status: "cancelled" };

export interface PdfJobHandle {
  result: Promise<PdfJobOutcome>;
  cancel(): void;
}

export type PdfInspectionOutcome =
  | { status: "fulfilled"; value: PdfInspectionResult }
  | { status: "rejected"; error: PdfToolErrorPayload }
  | { status: "cancelled" };

export interface PdfInspectionHandle {
  result: Promise<PdfInspectionOutcome>;
  cancel(): void;
}

export interface PdfThumbnailRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: typeof PDF_THUMBNAIL_TOOL_ID;
  toolVersion: typeof PDF_THUMBNAIL_TOOL_VERSION;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  };
}

export interface PdfThumbnailFileRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: typeof PDF_THUMBNAIL_TOOL_ID;
  toolVersion: typeof PDF_THUMBNAIL_TOOL_VERSION;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    file: File;
  };
}

export type PdfThumbnailWorkerRequest =
  | PdfThumbnailRunRequest
  | PdfThumbnailFileRunRequest
  | PdfCancelRequest;

export type PdfThumbnailUpdate =
  | {
      status: "ready";
      sourcePage: number;
      width: number;
      height: number;
      mime: "image/webp";
      bytes: ArrayBuffer;
    }
  | { status: "failed"; sourcePage: number };

export interface PdfThumbnailProgress {
  completedPages: number;
  totalPages: number;
  fraction: number;
}

export interface PdfThumbnailResult {
  pageCount: number;
  renderedPageCount: number;
  failedPageCount: number;
  omittedPageCount: number;
}

export type PdfThumbnailWorkerEvent =
  | {
      protocol: 1;
      type: "ready";
      capabilities: {
        tool: typeof PDF_THUMBNAIL_TOOL_ID;
        toolVersion: typeof PDF_THUMBNAIL_TOOL_VERSION;
      };
    }
  | ({
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
    } & PdfThumbnailProgress)
  | {
      protocol: 1;
      type: "thumbnail";
      jobId: string;
      sequence: number;
      update: PdfThumbnailUpdate;
    }
  | {
      protocol: 1;
      type: "complete";
      jobId: string;
      result: PdfThumbnailResult;
    }
  | {
      protocol: 1;
      type: "failed";
      jobId: string;
      error: PdfToolErrorPayload;
    };

export type PdfThumbnailJobOutcome =
  | { status: "fulfilled"; value: PdfThumbnailResult }
  | { status: "rejected"; error: PdfToolErrorPayload }
  | { status: "cancelled" };

export interface PdfThumbnailJobHandle {
  result: Promise<PdfThumbnailJobOutcome>;
  cancel(): void;
}

const pdfToImagesPageNumbersSchema = z
  .array(z.number().int().min(1).max(500))
  .min(1)
  .max(100)
  .refine((pages) => new Set(pages).size === pages.length, {
    message: "페이지 번호는 중복될 수 없습니다.",
  });

export const pdfToImagesSpecSchema = z.object({
  version: z.literal(1),
  selection: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("every-page") }),
    z.object({ mode: z.literal("extract"), pages: pdfToImagesPageNumbersSchema }),
  ]),
  output: z.discriminatedUnion("format", [
    z.object({
      format: z.literal("jpeg"),
      quality: z.number().int().min(40).max(95),
      background: z.literal("#ffffff"),
    }),
    z.object({ format: z.literal("png"), background: z.literal("#ffffff") }),
  ]),
  dpi: z.union([z.literal(96), z.literal(150), z.literal(300)]),
});

export type PdfToImagesSpecV1 = z.input<typeof pdfToImagesSpecSchema>;
export type ParsedPdfToImagesSpecV1 = z.output<typeof pdfToImagesSpecSchema>;

export type PdfToImagesWarning = "PDF_PAGE_RASTERIZED" | "COLOR_PROFILE_NORMALIZED";

export interface PdfToImagesResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "image/jpeg" | "image/png" | "application/zip";
  byteLength: number;
  sourcePageCount: number;
  outputPageCount: number;
  outputFileCount: number;
  format: "jpeg" | "png";
  warnings: PdfToImagesWarning[];
  timing: {
    loadMs: number;
    renderMs: number;
    encodeMs: number;
    archiveMs: number;
    totalMs: number;
  };
}

export type PdfToImagesErrorCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_INPUT"
  | "PASSWORD_PROTECTED"
  | "CORRUPT_PDF"
  | "PAGE_RANGE_INVALID"
  | "PAGE_LIMIT"
  | "MEMORY_LIMIT"
  | "RENDER_FAILED"
  | "ENCODE_FAILED"
  | "WORKER_CRASH";

export interface PdfToImagesErrorPayload {
  code: PdfToImagesErrorCode;
  message: string;
  retryable: boolean;
}

export type PdfToImagesProgress =
  | {
      phase: "rendering" | "encoding";
      fraction: number;
      completedPages: number;
      totalPages: number;
    }
  | {
      phase: "validating" | "loading" | "archiving" | "finalizing";
      fraction: number;
    };

export interface PdfToImagesRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "pdf.to-images";
  toolVersion: 1;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  };
  spec: PdfToImagesSpecV1;
}

export interface PdfToImagesFileRunRequest {
  protocol: 1;
  type: "run-file";
  jobId: string;
  tool: "pdf.to-images";
  toolVersion: 1;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    file: File;
  };
  spec: PdfToImagesSpecV1;
}

export interface PdfToImagesCancelRequest {
  protocol: 1;
  type: "cancel";
  jobId: string;
}

export type PdfToImagesWorkerRequest =
  | PdfToImagesRunRequest
  | PdfToImagesFileRunRequest
  | PdfToImagesCancelRequest;

export type PdfToImagesWorkerEvent =
  | {
      protocol: 1;
      type: "ready";
      capabilities: {
        offscreenCanvas: boolean;
        formats: readonly ["jpeg", "png"];
      };
    }
  | (PdfToImagesProgress & {
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
    })
  | {
      protocol: 1;
      type: "complete";
      jobId: string;
      result: PdfToImagesResult;
    }
  | {
      protocol: 1;
      type: "failed";
      jobId: string;
      error: PdfToImagesErrorPayload;
    };

export type PdfToImagesJobOutcome =
  | { status: "fulfilled"; value: PdfToImagesResult }
  | { status: "rejected"; error: PdfToImagesErrorPayload }
  | { status: "cancelled" };

export interface PdfToImagesJobHandle {
  result: Promise<PdfToImagesJobOutcome>;
  cancel(): void;
}

export const pdfCompressScannedSpecV1Schema = z
  .object({
    version: z.literal(1),
    preset: z.enum(["balanced", "minimum"]),
  })
  .strict();

export const pdfCompressScannedSpecV2Schema = z
  .object({
    version: z.literal(2),
    preset: z.enum(["balanced", "minimum"]),
  })
  .strict();

export const pdfCompressScannedSpecSchema = z.discriminatedUnion("version", [
  pdfCompressScannedSpecV1Schema,
  pdfCompressScannedSpecV2Schema,
]);

export type PdfCompressScannedPreset = "balanced" | "minimum";
export type PdfCompressScannedSpecV1 = z.input<typeof pdfCompressScannedSpecV1Schema>;
export type ParsedPdfCompressScannedSpecV1 = z.output<typeof pdfCompressScannedSpecV1Schema>;
export type PdfCompressScannedSpecV2 = z.input<typeof pdfCompressScannedSpecV2Schema>;
export type ParsedPdfCompressScannedSpecV2 = z.output<typeof pdfCompressScannedSpecV2Schema>;

export type PdfCompressScannedWarning =
  | "PDF_PAGES_RASTERIZED"
  | "SEARCHABLE_CONTENT_REMOVED"
  | "INTERACTIVE_CONTENT_REMOVED"
  | "SIGNATURES_INVALIDATED"
  | "COLOR_PROFILE_NORMALIZED";

interface PdfCompressScannedResultCommon {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "application/pdf";
  sourceByteLength: number;
  byteLength: number;
  pageCount: number;
  timing: {
    loadMs: number;
    renderMs: number;
    encodeMs: number;
    assembleMs: number;
    serializeMs: number;
    totalMs: number;
  };
}

export interface PdfCompressScannedResultV1 extends PdfCompressScannedResultCommon {
  preset: PdfCompressScannedPreset;
  dpi: 96 | 150;
  quality: 55 | 72;
  warnings: PdfCompressScannedWarning[];
}

export type PdfCompressScannedMode = "structure-preserving" | "rasterized";

export interface PdfCompressScannedStructureResultV2 extends PdfCompressScannedResultCommon {
  mode: "structure-preserving";
  warnings: ["SIGNATURES_INVALIDATED"];
}

export interface PdfCompressScannedRasterResultV2 extends PdfCompressScannedResultCommon {
  mode: "rasterized";
  preset: PdfCompressScannedPreset;
  dpi: 96 | 150;
  quality: 55 | 72;
  warnings: PdfCompressScannedWarning[];
}

export type PdfCompressScannedResultV2 =
  | PdfCompressScannedStructureResultV2
  | PdfCompressScannedRasterResultV2;
export type PdfCompressScannedResult = PdfCompressScannedResultV1 | PdfCompressScannedResultV2;

export type PdfCompressScannedErrorCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_BROWSER"
  | "UNSUPPORTED_INPUT"
  | "PASSWORD_PROTECTED"
  | "CORRUPT_PDF"
  | "PAGE_LIMIT"
  | "MEMORY_LIMIT"
  | "RENDER_FAILED"
  | "ENCODE_FAILED"
  | "ASSEMBLY_FAILED"
  | "NO_SIZE_REDUCTION"
  | "WORKER_CRASH";

export type PdfCompressScannedNoSizeReductionReason =
  | "STRUCTURED_OR_MIXED"
  | "IMAGE_ONLY_NO_SAVINGS";

interface PdfCompressScannedErrorPayloadBase {
  message: string;
  retryable: boolean;
}

export type PdfCompressScannedErrorPayload =
  | (PdfCompressScannedErrorPayloadBase & {
      code: "NO_SIZE_REDUCTION";
      reason: PdfCompressScannedNoSizeReductionReason;
    })
  | (PdfCompressScannedErrorPayloadBase & {
      code: Exclude<PdfCompressScannedErrorCode, "NO_SIZE_REDUCTION">;
    });

export type PdfCompressScannedProgress =
  | {
      phase: "rendering" | "encoding" | "assembling";
      fraction: number;
      completedPages: number;
      totalPages: number;
    }
  | {
      phase: "validating" | "loading" | "serializing" | "finalizing";
      fraction: number;
    };

interface PdfCompressScannedRunRequestCommon {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "pdf.compress-scanned";
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  };
}

export interface PdfCompressScannedRunRequestV1 extends PdfCompressScannedRunRequestCommon {
  toolVersion: 1;
  spec: PdfCompressScannedSpecV1;
}

export interface PdfCompressScannedRunRequestV2 extends PdfCompressScannedRunRequestCommon {
  toolVersion: 2;
  spec: PdfCompressScannedSpecV2;
}

export interface PdfCompressScannedFileRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "pdf.compress-scanned";
  toolVersion: 2;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    file: File;
  };
  spec: PdfCompressScannedSpecV2;
}

export type PdfCompressScannedRunRequest =
  | PdfCompressScannedRunRequestV1
  | PdfCompressScannedRunRequestV2;

export interface PdfCompressScannedCancelRequest {
  protocol: 1;
  type: "cancel";
  jobId: string;
}

export type PdfCompressScannedWorkerRequest =
  | PdfCompressScannedRunRequest
  | PdfCompressScannedFileRunRequest
  | PdfCompressScannedCancelRequest;

export type PdfCompressScannedWorkerEvent =
  | {
      protocol: 1;
      type: "ready";
      capabilities: {
        offscreenCanvas: boolean;
        jpegEncoder: boolean;
        pdfjsWorker: boolean;
        pdfAssembly: boolean;
      };
      error: PdfCompressScannedErrorPayload | null;
    }
  | (PdfCompressScannedProgress & {
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
    })
  | {
      protocol: 1;
      type: "complete";
      jobId: string;
      result: PdfCompressScannedResult;
    }
  | {
      protocol: 1;
      type: "failed";
      jobId: string;
      error: PdfCompressScannedErrorPayload;
    };

export type PdfCompressScannedJobOutcome =
  | { status: "fulfilled"; value: PdfCompressScannedResult }
  | { status: "rejected"; error: PdfCompressScannedErrorPayload }
  | { status: "cancelled" };

export interface PdfCompressScannedJobHandle {
  result: Promise<PdfCompressScannedJobOutcome>;
  cancel(): void;
}
