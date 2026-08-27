import { computeDrawGeometry, inspectImageHeader, suggestOutputName } from "@hereisit/image-tool";
import {
  type ImagePhase,
  type ImagePipelineResult,
  type ImageWarning,
  imagePipelineSpecSchema,
  type ParsedImagePipelineSpec,
  type ToolErrorCode,
} from "@hereisit/tool-contracts";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_OUTPUT_PIXELS = 25_000_000;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_DIMENSION = 16_384;

export class ImagePipelineError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ImagePipelineError";
  }
}

interface PipelineInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  bytes: ArrayBuffer;
}

type ProgressReporter = (phase: ImagePhase, fraction: number) => void;
type ResolvedOutput = Exclude<ParsedImagePipelineSpec["output"], { format: "source" }>;
type LossyCompression = Extract<ResolvedOutput, { format: "jpeg" | "webp" }>["compression"];

function outputMime(format: ResolvedOutput["format"]): ImagePipelineResult["mime"] {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function resolveOutput(
  output: ParsedImagePipelineSpec["output"],
  sourceFormat: "jpeg" | "png" | "webp",
): ResolvedOutput {
  if (output.format !== "source") return output;
  if (sourceFormat === "jpeg") {
    return {
      format: "jpeg",
      compression: output.compression,
      matte: "#ffffff",
    };
  }
  if (sourceFormat === "webp") {
    return { format: "webp", compression: output.compression };
  }
  return { format: "png", compression: { mode: "lossless" } };
}

function decodeHexColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff";
}

async function encodeCanvas(
  canvas: OffscreenCanvas,
  mime: ImagePipelineResult["mime"],
  quality?: number,
): Promise<Blob> {
  const blob = await canvas.convertToBlob({
    type: mime,
    ...(quality === undefined ? {} : { quality: quality / 100 }),
  });

  if (blob.type !== mime) {
    throw new ImagePipelineError(
      "ENCODE_FAILED",
      `${mime} 형식 인코딩을 이 브라우저가 지원하지 않습니다.`,
    );
  }

  return blob;
}

async function encodeWithTarget(
  canvas: OffscreenCanvas,
  mime: "image/jpeg" | "image/webp",
  compression: LossyCompression,
): Promise<{ blob: Blob; attempts: number; targetReached: boolean }> {
  if (compression.mode === "quality") {
    return {
      blob: await encodeCanvas(canvas, mime, compression.quality),
      attempts: 1,
      targetReached: true,
    };
  }

  let low = compression.minQuality;
  let high = compression.maxQuality;
  let attempts = 0;
  let bestUnderTarget: Blob | undefined;
  let smallest: Blob | undefined;

  while (low <= high && attempts < compression.maxAttempts) {
    const current = Math.round((low + high) / 2);
    const candidate = await encodeCanvas(canvas, mime, current);
    attempts += 1;

    if (smallest === undefined || candidate.size < smallest.size) smallest = candidate;

    if (candidate.size <= compression.maxBytes) {
      bestUnderTarget = candidate;
      low = current + 1;
    } else {
      high = current - 1;
    }
  }

  const blob = bestUnderTarget ?? smallest;
  if (blob === undefined) {
    throw new ImagePipelineError("ENCODE_FAILED", "이미지 인코딩 결과를 만들지 못했습니다.");
  }

  return { blob, attempts, targetReached: bestUnderTarget !== undefined };
}

function smallerOnlyTargetBytes(
  inputByteLength: number,
  sizeGoal: ParsedImagePipelineSpec["sizeGoal"],
): number | undefined {
  if (sizeGoal.mode !== "smaller-only") return undefined;
  const ratioSavings = Math.ceil((inputByteLength * sizeGoal.minSavingsPercent) / 100);
  return Math.max(0, inputByteLength - Math.max(1, ratioSavings));
}

export async function processImagePipeline(
  input: PipelineInput,
  rawSpec: unknown,
  report: ProgressReporter,
): Promise<ImagePipelineResult> {
  const totalStarted = performance.now();
  report("validating", 0.02);

  const parsed = imagePipelineSpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    throw new ImagePipelineError("INVALID_SPEC", "이미지 변환 설정이 올바르지 않습니다.");
  }
  const spec = parsed.data;

  const actualByteLength = input.bytes.byteLength;
  if (actualByteLength < 1 || actualByteLength > MAX_INPUT_BYTES) {
    throw new ImagePipelineError("MEMORY_LIMIT", "파일은 50MB 이하만 처리할 수 있습니다.");
  }
  if (input.byteLength !== actualByteLength) {
    throw new ImagePipelineError("CORRUPT_INPUT", "파일 크기 정보가 실제 데이터와 다릅니다.");
  }

  const inspectStarted = performance.now();
  let inspected: ReturnType<typeof inspectImageHeader>;
  try {
    inspected = inspectImageHeader(input.bytes);
  } catch {
    throw new ImagePipelineError(
      "UNSUPPORTED_INPUT",
      "JPG, PNG, WebP 또는 HEIC 이미지만 지원합니다.",
    );
  }

  if (inspected.animated) {
    throw new ImagePipelineError("ANIMATED_INPUT", "움직이는 이미지는 아직 지원하지 않습니다.");
  }
  let output: ResolvedOutput;
  if (spec.output.format === "source") {
    if (inspected.format === "heic") {
      throw new ImagePipelineError(
        "UNSUPPORTED_INPUT",
        "HEIC는 형식을 유지한 채 다시 저장할 수 없습니다. 이미지 형식 변환 도구를 이용해 주세요.",
      );
    }
    output = resolveOutput(spec.output, inspected.format);
  } else {
    output = spec.output;
  }
  if (
    inspected.width > MAX_DIMENSION ||
    inspected.height > MAX_DIMENSION ||
    inspected.width * inspected.height > MAX_INPUT_PIXELS
  ) {
    throw new ImagePipelineError("DIMENSION_LIMIT", "이미지 해상도가 너무 큽니다.");
  }
  const inspectMs = performance.now() - inspectStarted;

  report("decoding", 0.2);
  const decodeStarted = performance.now();
  let bitmap: ImageBitmap;
  try {
    const sourceBlob = new Blob([input.bytes], { type: inspected.mime });
    bitmap = await createImageBitmap(sourceBlob, { imageOrientation: "from-image" });
  } catch {
    if (inspected.format === "heic") {
      throw new ImagePipelineError(
        "DECODE_FAILED",
        "이 브라우저는 HEIC 디코딩을 지원하지 않아요. Safari 17 이상에서 다시 시도해 주세요.",
      );
    }
    throw new ImagePipelineError("DECODE_FAILED", "이미지를 읽지 못했습니다.");
  }
  const decodeMs = performance.now() - decodeStarted;

  try {
    if (
      bitmap.width > MAX_DIMENSION ||
      bitmap.height > MAX_DIMENSION ||
      bitmap.width * bitmap.height > MAX_INPUT_PIXELS
    ) {
      throw new ImagePipelineError("DIMENSION_LIMIT", "이미지 해상도가 너무 큽니다.");
    }

    report("transforming", 0.55);
    const transformStarted = performance.now();
    const rotation = "rotation" in spec ? spec.rotation : 0;
    const geometry = computeDrawGeometry(bitmap.width, bitmap.height, spec.resize, rotation);

    if (
      geometry.canvasWidth > MAX_DIMENSION ||
      geometry.canvasHeight > MAX_DIMENSION ||
      geometry.canvasWidth * geometry.canvasHeight > MAX_OUTPUT_PIXELS
    ) {
      throw new ImagePipelineError("DIMENSION_LIMIT", "출력 이미지 해상도가 너무 큽니다.");
    }

    const canvas = new OffscreenCanvas(geometry.canvasWidth, geometry.canvasHeight);
    const context = canvas.getContext("2d", {
      alpha: output.format !== "jpeg",
      desynchronized: true,
    });
    if (context === null) {
      throw new ImagePipelineError("MEMORY_LIMIT", "이미지 작업 공간을 만들지 못했습니다.");
    }

    if (output.format === "jpeg") {
      context.fillStyle = decodeHexColor(output.matte);
      context.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (rotation === 90) {
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      context.translate(canvas.width, canvas.height);
      context.rotate(Math.PI);
    } else if (rotation === 270) {
      context.translate(0, canvas.height);
      context.rotate(-Math.PI / 2);
    }
    const drawGeometry =
      rotation === 0 || spec.resize.kind !== "none"
        ? geometry
        : {
            ...geometry,
            destinationWidth: bitmap.width,
            destinationHeight: bitmap.height,
          };
    context.drawImage(
      bitmap,
      drawGeometry.sourceX,
      drawGeometry.sourceY,
      drawGeometry.sourceWidth,
      drawGeometry.sourceHeight,
      drawGeometry.destinationX,
      drawGeometry.destinationY,
      drawGeometry.destinationWidth,
      drawGeometry.destinationHeight,
    );
    const transformMs = performance.now() - transformStarted;

    report("encoding", 0.9);
    const encodeStarted = performance.now();
    const mime = outputMime(output.format);
    const sizeTarget = smallerOnlyTargetBytes(actualByteLength, spec.sizeGoal);
    let blob: Blob;
    let encodeAttempts = 1;
    let targetReached = true;

    if (output.format === "png") {
      blob = await encodeCanvas(canvas, mime);
      if (sizeTarget !== undefined) targetReached = blob.size <= sizeTarget;
    } else {
      const lossyMime = output.format === "jpeg" ? "image/jpeg" : "image/webp";
      const compression: LossyCompression = output.compression;
      let encoded: { blob: Blob; attempts: number; targetReached: boolean };

      if (
        sizeTarget !== undefined &&
        spec.sizeGoal.mode === "smaller-only" &&
        compression.mode === "quality"
      ) {
        const preferred = await encodeCanvas(canvas, lossyMime, compression.quality);
        const minQuality = Math.min(spec.sizeGoal.minQuality, compression.quality);
        if (preferred.size <= sizeTarget || compression.quality <= minQuality) {
          encoded = {
            blob: preferred,
            attempts: 1,
            targetReached: preferred.size <= sizeTarget,
          };
        } else {
          const adaptive = await encodeWithTarget(canvas, lossyMime, {
            mode: "maxBytes",
            maxBytes: sizeTarget,
            minQuality,
            maxQuality: compression.quality - 1,
            maxAttempts: spec.sizeGoal.maxAttempts,
          });
          encoded = {
            blob: adaptive.blob.size < preferred.size ? adaptive.blob : preferred,
            attempts: adaptive.attempts + 1,
            targetReached: adaptive.targetReached,
          };
        }
      } else {
        let targetCompression = compression;
        if (
          sizeTarget !== undefined &&
          spec.sizeGoal.mode === "smaller-only" &&
          compression.mode === "maxBytes"
        ) {
          targetCompression = {
            ...compression,
            maxBytes: Math.min(sizeTarget, compression.maxBytes),
            minQuality: Math.min(
              compression.maxQuality,
              Math.max(compression.minQuality, spec.sizeGoal.minQuality),
            ),
            maxAttempts: Math.min(compression.maxAttempts, spec.sizeGoal.maxAttempts),
          };
        }
        encoded = await encodeWithTarget(canvas, lossyMime, targetCompression);
      }

      blob = encoded.blob;
      encodeAttempts = encoded.attempts;
      targetReached = encoded.targetReached;
    }
    const encodeMs = performance.now() - encodeStarted;
    if (sizeTarget !== undefined && blob.size > sizeTarget) {
      throw new ImagePipelineError("NO_SIZE_REDUCTION", "이미 충분히 작아 더 줄이지 못했어요.");
    }
    if (blob.size > MAX_OUTPUT_BYTES) {
      throw new ImagePipelineError("MEMORY_LIMIT", "결과 파일이 100MB 제한을 넘었습니다.");
    }
    if (!Number.isSafeInteger(blob.size) || blob.size < 1) {
      throw new ImagePipelineError("ENCODE_FAILED", "유효한 이미지 결과를 만들지 못했습니다.");
    }

    report("finalizing", 0.98);
    const warnings: ImageWarning[] = [];
    if (geometry.upscalingSkipped) warnings.push("UPSCALING_SKIPPED");
    if (!targetReached) warnings.push("TARGET_SIZE_NOT_REACHED");

    let bytes: ArrayBuffer;
    try {
      bytes = await blob.arrayBuffer();
    } catch {
      throw new ImagePipelineError("ENCODE_FAILED", "이미지 결과를 읽지 못했습니다.");
    }
    if (bytes.byteLength !== blob.size) {
      throw new ImagePipelineError("ENCODE_FAILED", "이미지 결과 크기를 확인하지 못했습니다.");
    }
    let inspectedOutput: ReturnType<typeof inspectImageHeader>;
    try {
      inspectedOutput = inspectImageHeader(bytes);
    } catch {
      throw new ImagePipelineError("ENCODE_FAILED", "이미지 결과 형식을 확인하지 못했습니다.");
    }
    if (
      inspectedOutput.format !== output.format ||
      inspectedOutput.mime !== mime ||
      inspectedOutput.width !== geometry.canvasWidth ||
      inspectedOutput.height !== geometry.canvasHeight ||
      inspectedOutput.animated
    ) {
      throw new ImagePipelineError(
        "ENCODE_FAILED",
        "이미지 결과의 형식이나 크기가 요청과 다릅니다.",
      );
    }
    report("finalizing", 1);

    return {
      bytes,
      suggestedName: suggestOutputName(input.name, output.format, {
        preserveMatchingExtension: spec.output.format === "source",
      }),
      mime,
      width: geometry.canvasWidth,
      height: geometry.canvasHeight,
      byteLength: bytes.byteLength,
      warnings,
      timing: {
        inspectMs,
        decodeMs,
        transformMs,
        encodeMs,
        totalMs: performance.now() - totalStarted,
        encodeAttempts,
      },
    };
  } finally {
    bitmap.close();
  }
}
