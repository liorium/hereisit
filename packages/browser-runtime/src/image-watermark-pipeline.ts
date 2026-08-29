import {
  computeWatermarkRect,
  fitWatermarkSize,
  inspectImageHeader,
  resolveImageWatermarkOutput,
  type SupportedImageFormat,
  suggestWatermarkedImageName,
} from "@hereisit/image-tool";
import {
  type ImageWatermarkErrorCode,
  type ImageWatermarkErrorPayload,
  type ImageWatermarkInput,
  type ImageWatermarkLogoInput,
  type ImageWatermarkPhase,
  type ImageWatermarkResult,
  type ImageWatermarkWarning,
  imageWatermarkSpecSchema,
  type ParsedImageWatermarkSpecV1,
} from "@hereisit/tool-contracts";

const MEBIBYTE = 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * MEBIBYTE;
const MAX_SOURCE_DIMENSION = 16_384;
const MAX_SOURCE_PIXELS = 25_000_000;
const MAX_LOGO_BYTES = 10 * MEBIBYTE;
const MAX_LOGO_DIMENSION = 8_192;
const MAX_LOGO_PIXELS = 16_000_000;
const MAX_OUTPUT_BYTES = 100 * MEBIBYTE;

const CANCELLED_MESSAGE = "이미지 워터마크 작업을 중단했어요.";
const WORKER_CRASH_MESSAGE = "이미지 워터마크 작업을 완료하지 못했어요.";

export interface PreparedImageWatermarkLogo {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export type ImageWatermarkProgressReporter = (phase: ImageWatermarkPhase, fraction: number) => void;

export class ImageWatermarkPipelineError extends Error {
  constructor(
    readonly code: ImageWatermarkErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ImageWatermarkPipelineError";
  }
}

function cancelled(): ImageWatermarkPipelineError {
  return new ImageWatermarkPipelineError("CANCELLED", CANCELLED_MESSAGE);
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function normalizePipelineError(error: unknown, signal?: AbortSignal): ImageWatermarkPipelineError {
  if (error instanceof ImageWatermarkPipelineError) return error;
  if (signal?.aborted || isAbortError(error)) return cancelled();
  return new ImageWatermarkPipelineError("WORKER_CRASH", WORKER_CRASH_MESSAGE, true);
}

function closeBitmap(bitmap: ImageBitmap | undefined): void {
  if (bitmap === undefined) return;
  try {
    bitmap.close();
  } catch {
    // Cleanup must not replace a bounded result or the original typed failure.
  }
}

function releaseCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas === undefined) return;
  try {
    canvas.width = 0;
  } catch {
    // Both dimensions receive an independent release attempt.
  }
  try {
    canvas.height = 0;
  } catch {
    // Both dimensions receive an independent release attempt.
  }
}

function validateByteLength(
  input: ImageWatermarkInput,
  maximum: number,
  limitMessage: string,
): number {
  const actualByteLength = input.bytes.byteLength;
  if (
    !Number.isSafeInteger(actualByteLength) ||
    actualByteLength < 1 ||
    actualByteLength > maximum
  ) {
    throw new ImageWatermarkPipelineError("MEMORY_LIMIT", limitMessage);
  }
  if (input.byteLength !== actualByteLength) {
    throw new ImageWatermarkPipelineError(
      "CORRUPT_INPUT",
      "파일 크기 정보가 실제 이미지 데이터와 다릅니다.",
    );
  }
  return actualByteLength;
}

function hasBoundedGeometry(
  width: number,
  height: number,
  maximumDimension: number,
  maximumPixels: number,
): boolean {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > maximumDimension ||
    height > maximumDimension
  ) {
    return false;
  }
  const pixels = width * height;
  return Number.isSafeInteger(pixels) && pixels <= maximumPixels;
}

function inspectSource(input: ImageWatermarkInput): ReturnType<typeof inspectImageHeader> {
  let inspected: ReturnType<typeof inspectImageHeader>;
  try {
    inspected = inspectImageHeader(input.bytes);
  } catch {
    throw new ImageWatermarkPipelineError(
      "UNSUPPORTED_INPUT",
      "JPG, PNG, WebP 또는 HEIC 이미지만 지원합니다.",
    );
  }
  if (inspected.animated) {
    throw new ImageWatermarkPipelineError(
      "ANIMATED_INPUT",
      "움직이는 이미지는 워터마크 처리할 수 없어요.",
    );
  }
  if (
    !hasBoundedGeometry(inspected.width, inspected.height, MAX_SOURCE_DIMENSION, MAX_SOURCE_PIXELS)
  ) {
    throw new ImageWatermarkPipelineError(
      "DIMENSION_LIMIT",
      "이미지는 한 변 16,384px, 전체 25,000,000픽셀 이하여야 해요.",
    );
  }
  return inspected;
}

function inspectLogo(input: ImageWatermarkLogoInput): ReturnType<typeof inspectImageHeader> {
  let inspected: ReturnType<typeof inspectImageHeader>;
  try {
    inspected = inspectImageHeader(input.bytes);
  } catch {
    throw new ImageWatermarkPipelineError(
      "UNSUPPORTED_INPUT",
      "로고는 JPG, PNG 또는 WebP 이미지만 사용할 수 있어요.",
    );
  }
  if (inspected.format === "heic") {
    throw new ImageWatermarkPipelineError(
      "UNSUPPORTED_INPUT",
      "로고는 JPG, PNG 또는 WebP 이미지만 사용할 수 있어요.",
    );
  }
  if (inspected.animated) {
    throw new ImageWatermarkPipelineError(
      "ANIMATED_INPUT",
      "움직이는 로고 이미지는 사용할 수 없어요.",
    );
  }
  if (!hasBoundedGeometry(inspected.width, inspected.height, MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS)) {
    throw new ImageWatermarkPipelineError(
      "DIMENSION_LIMIT",
      "로고는 한 변 8,192px, 전체 16,000,000픽셀 이하여야 해요.",
    );
  }
  return inspected;
}

async function decodeBitmap(
  input: ImageWatermarkInput,
  format: { mime: string; format: SupportedImageFormat },
  signal: AbortSignal,
  kind: "source" | "logo",
): Promise<ImageBitmap> {
  signal.throwIfAborted();
  let bitmap: ImageBitmap | undefined;
  try {
    const source = new Blob([input.bytes], { type: format.mime });
    bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
    signal.throwIfAborted();
    const decoded = bitmap;
    bitmap = undefined;
    return decoded;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw cancelled();
    const heicMessage =
      format.format === "heic"
        ? "이 브라우저는 HEIC 이미지를 읽을 수 없어요. 다른 브라우저나 형식을 사용해 주세요."
        : kind === "logo"
          ? "로고 이미지를 읽지 못했습니다."
          : "이미지를 읽지 못했습니다.";
    throw new ImageWatermarkPipelineError("DECODE_FAILED", heicMessage);
  } finally {
    closeBitmap(bitmap);
  }
}

export async function prepareImageWatermarkLogo(
  input: ImageWatermarkLogoInput,
  signal: AbortSignal,
): Promise<PreparedImageWatermarkLogo> {
  try {
    validateByteLength(input, MAX_LOGO_BYTES, "로고 파일은 10MB 이하만 사용할 수 있어요.");
    const inspected = inspectLogo(input);
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await decodeBitmap(input, inspected, signal, "logo");
      if (!hasBoundedGeometry(bitmap.width, bitmap.height, MAX_LOGO_DIMENSION, MAX_LOGO_PIXELS)) {
        throw new ImageWatermarkPipelineError(
          "DIMENSION_LIMIT",
          "로고는 한 변 8,192px, 전체 16,000,000픽셀 이하여야 해요.",
        );
      }
      const prepared = { bitmap, width: bitmap.width, height: bitmap.height };
      bitmap = undefined;
      return prepared;
    } finally {
      closeBitmap(bitmap);
    }
  } catch (error) {
    throw normalizePipelineError(error, signal);
  }
}

export function closePreparedImageWatermarkLogo(
  logo: PreparedImageWatermarkLogo | undefined,
): void {
  closeBitmap(logo?.bitmap);
}

function availableWatermarkArea(
  width: number,
  height: number,
  marginPercent: number,
): { width: number; height: number } {
  const margin = Math.round((Math.min(width, height) * marginPercent) / 100);
  return {
    width: Math.max(1, width - margin * 2),
    height: Math.max(1, height - margin * 2),
  };
}

function positiveMetric(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function font(fontSize: number): string {
  return `bold ${fontSize}px sans-serif`;
}

function drawTextWatermark(
  context: OffscreenCanvasRenderingContext2D,
  spec: ParsedImageWatermarkSpecV1,
  width: number,
  height: number,
  signal: AbortSignal,
): void {
  if (spec.watermark.kind !== "text") return;
  const requestedFontSize = (Math.min(width, height) * spec.watermark.sizePercent) / 100;
  context.font = font(requestedFontSize);
  const metrics = context.measureText(spec.watermark.text);
  const measuredWidth = positiveMetric(
    metrics.width,
    Math.max(requestedFontSize, Array.from(spec.watermark.text).length * requestedFontSize * 0.6),
  );
  const measuredHeight = positiveMetric(
    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    requestedFontSize,
  );
  const available = availableWatermarkArea(width, height, spec.marginPercent);
  const fitted = fitWatermarkSize(measuredWidth, measuredHeight, available.width, available.height);
  const fontScale = Math.min(fitted.width / measuredWidth, fitted.height / measuredHeight);
  const fittedFontSize = requestedFontSize * fontScale;
  context.font = font(fittedFontSize);
  const rectangle = computeWatermarkRect({
    canvasWidth: width,
    canvasHeight: height,
    watermarkWidth: fitted.width,
    watermarkHeight: fitted.height,
    position: spec.position,
    marginPercent: spec.marginPercent,
  });

  signal.throwIfAborted();
  context.save();
  try {
    context.globalAlpha = spec.opacity;
    context.fillStyle = spec.watermark.color;
    context.textBaseline = "top";
    if (spec.watermark.shadow !== undefined) {
      context.shadowColor = spec.watermark.shadow.color;
      context.shadowBlur = (fittedFontSize * spec.watermark.shadow.blurPercent) / 100;
      const offset = (fittedFontSize * spec.watermark.shadow.offsetPercent) / 100;
      context.shadowOffsetX = offset;
      context.shadowOffsetY = offset;
    }
    context.fillText(spec.watermark.text, rectangle.x, rectangle.y);
  } finally {
    context.restore();
  }
}

function drawLogoWatermark(
  context: OffscreenCanvasRenderingContext2D,
  spec: ParsedImageWatermarkSpecV1,
  logo: PreparedImageWatermarkLogo,
  width: number,
  height: number,
  signal: AbortSignal,
): void {
  if (spec.watermark.kind !== "logo") return;
  const requestedWidth = (width * spec.watermark.widthPercent) / 100;
  const requestedHeight = requestedWidth * (logo.height / logo.width);
  const available = availableWatermarkArea(width, height, spec.marginPercent);
  const fitted = fitWatermarkSize(
    requestedWidth,
    requestedHeight,
    available.width,
    available.height,
  );
  const rectangle = computeWatermarkRect({
    canvasWidth: width,
    canvasHeight: height,
    watermarkWidth: fitted.width,
    watermarkHeight: fitted.height,
    position: spec.position,
    marginPercent: spec.marginPercent,
  });

  signal.throwIfAborted();
  context.save();
  try {
    context.globalAlpha = spec.opacity;
    context.drawImage(logo.bitmap, rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  } finally {
    context.restore();
  }
}

function outputEncodingOptions(
  output: ReturnType<typeof resolveImageWatermarkOutput>,
): ImageEncodeOptions {
  return output.quality === undefined
    ? { type: output.mime }
    : { type: output.mime, quality: output.quality / 100 };
}

async function encodeAndValidate(
  canvas: OffscreenCanvas,
  output: ReturnType<typeof resolveImageWatermarkOutput>,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  let blob: Blob;
  try {
    blob = await canvas.convertToBlob(outputEncodingOptions(output));
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw cancelled();
    throw new ImageWatermarkPipelineError("ENCODE_FAILED", "이미지를 인코딩하지 못했습니다.");
  }
  signal.throwIfAborted();

  if (blob.type !== output.mime) {
    throw new ImageWatermarkPipelineError(
      "ENCODE_FAILED",
      `${output.mime} 형식 인코딩을 이 브라우저가 지원하지 않습니다.`,
    );
  }
  if (!Number.isSafeInteger(blob.size) || blob.size < 1) {
    throw new ImageWatermarkPipelineError(
      "ENCODE_FAILED",
      "유효한 이미지 결과를 만들지 못했습니다.",
    );
  }
  if (blob.size > MAX_OUTPUT_BYTES) {
    throw new ImageWatermarkPipelineError(
      "MEMORY_LIMIT",
      "결과 파일은 100MB 이하만 만들 수 있어요.",
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw cancelled();
    throw new ImageWatermarkPipelineError("ENCODE_FAILED", "이미지 결과를 읽지 못했습니다.");
  }
  signal.throwIfAborted();
  if (bytes.byteLength !== blob.size) {
    throw new ImageWatermarkPipelineError(
      "ENCODE_FAILED",
      "이미지 결과 크기를 확인하지 못했습니다.",
    );
  }

  let inspected: ReturnType<typeof inspectImageHeader>;
  try {
    inspected = inspectImageHeader(bytes);
  } catch {
    throw new ImageWatermarkPipelineError(
      "ENCODE_FAILED",
      "이미지 결과 형식을 확인하지 못했습니다.",
    );
  }
  if (
    inspected.format !== output.format ||
    inspected.mime !== output.mime ||
    inspected.width !== width ||
    inspected.height !== height ||
    inspected.animated
  ) {
    throw new ImageWatermarkPipelineError(
      "ENCODE_FAILED",
      "이미지 결과의 형식이나 크기가 요청과 다릅니다.",
    );
  }
  return bytes;
}

export async function processImageWatermarkPipeline(
  input: ImageWatermarkInput,
  rawSpec: unknown,
  logo: PreparedImageWatermarkLogo | undefined,
  report: ImageWatermarkProgressReporter,
  signal: AbortSignal,
): Promise<ImageWatermarkResult> {
  const totalStarted = performance.now();
  try {
    report("validating", 0.02);
    let parsed: ReturnType<typeof imageWatermarkSpecSchema.safeParse>;
    try {
      parsed = imageWatermarkSpecSchema.safeParse(rawSpec);
    } catch {
      throw new ImageWatermarkPipelineError(
        "INVALID_SPEC",
        "이미지 워터마크 설정이 올바르지 않습니다.",
      );
    }
    if (!parsed.success) {
      throw new ImageWatermarkPipelineError(
        "INVALID_SPEC",
        "이미지 워터마크 설정이 올바르지 않습니다.",
      );
    }
    const spec = parsed.data;
    if (spec.watermark.kind === "logo" && logo === undefined) {
      throw new ImageWatermarkPipelineError("LOGO_REQUIRED", "사용할 로고 이미지를 선택해 주세요.");
    }

    const sourceByteLength = validateByteLength(
      input,
      MAX_SOURCE_BYTES,
      "이미지 파일은 50MB 이하만 처리할 수 있어요.",
    );
    const inspectStarted = performance.now();
    const inspected = inspectSource(input);
    const inspectMs = performance.now() - inspectStarted;
    report("validating", 0.12);

    report("decoding", 0.2);
    const decodeStarted = performance.now();
    let bitmap: ImageBitmap | undefined;
    bitmap = await decodeBitmap(input, inspected, signal, "source");

    try {
      const decodeMs = performance.now() - decodeStarted;
      if (
        !hasBoundedGeometry(bitmap.width, bitmap.height, MAX_SOURCE_DIMENSION, MAX_SOURCE_PIXELS)
      ) {
        throw new ImageWatermarkPipelineError(
          "DIMENSION_LIMIT",
          "이미지는 한 변 16,384px, 전체 25,000,000픽셀 이하여야 해요.",
        );
      }
      const width = bitmap.width;
      const height = bitmap.height;
      report("decoding", 0.4);
      report("compositing", 0.5);
      const compositeStarted = performance.now();
      signal.throwIfAborted();

      const output = resolveImageWatermarkOutput(inspected.format, spec.output);
      let canvas: OffscreenCanvas | undefined;
      try {
        try {
          canvas = new OffscreenCanvas(width, height);
        } catch {
          throw new ImageWatermarkPipelineError(
            "MEMORY_LIMIT",
            "이미지 작업 공간을 만들지 못했습니다.",
          );
        }
        let context: OffscreenCanvasRenderingContext2D | null;
        try {
          context = canvas.getContext("2d", {
            alpha: output.format !== "jpeg",
            desynchronized: true,
          });
        } catch {
          throw new ImageWatermarkPipelineError(
            "MEMORY_LIMIT",
            "이미지 작업 공간을 만들지 못했습니다.",
          );
        }
        if (context === null) {
          throw new ImageWatermarkPipelineError(
            "MEMORY_LIMIT",
            "이미지 작업 공간을 만들지 못했습니다.",
          );
        }

        if (output.matte !== undefined) {
          context.fillStyle = output.matte;
          context.fillRect(0, 0, width, height);
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, width, height);

        if (spec.watermark.kind === "text") {
          drawTextWatermark(context, spec, width, height, signal);
        } else {
          drawLogoWatermark(
            context,
            spec,
            logo as PreparedImageWatermarkLogo,
            width,
            height,
            signal,
          );
        }
        const compositeMs = performance.now() - compositeStarted;
        report("compositing", 0.72);

        signal.throwIfAborted();
        report("encoding", 0.8);
        const encodeStarted = performance.now();
        const bytes = await encodeAndValidate(canvas, output, width, height, signal);
        const encodeMs = performance.now() - encodeStarted;
        report("encoding", 0.94);

        report("finalizing", 0.98);
        const warnings: ImageWatermarkWarning[] = [];
        if (output.sourceFormatConverted) warnings.push("SOURCE_FORMAT_CONVERTED");
        warnings.push("COLOR_PROFILE_NORMALIZED");
        report("finalizing", 1);

        return {
          bytes,
          suggestedName: suggestWatermarkedImageName(input.name, output.format),
          mime: output.mime,
          width,
          height,
          sourceByteLength,
          byteLength: bytes.byteLength,
          format: output.format,
          warnings,
          timing: {
            inspectMs,
            decodeMs,
            compositeMs,
            encodeMs,
            totalMs: performance.now() - totalStarted,
          },
        };
      } finally {
        releaseCanvas(canvas);
      }
    } finally {
      closeBitmap(bitmap);
    }
  } catch (error) {
    throw normalizePipelineError(error, signal);
  }
}

export function toImageWatermarkErrorPayload(error: unknown): ImageWatermarkErrorPayload {
  if (error instanceof ImageWatermarkPipelineError) {
    return {
      code: error.code,
      message: error.code === "WORKER_CRASH" ? WORKER_CRASH_MESSAGE : error.message,
      retryable: error.retryable,
    };
  }
  if (isAbortError(error)) {
    return { code: "CANCELLED", message: CANCELLED_MESSAGE, retryable: false };
  }
  return { code: "WORKER_CRASH", message: WORKER_CRASH_MESSAGE, retryable: true };
}
