import { inspectImageHeader } from "@hereisit/image-tool";
import type { SourceFileLimits } from "./tool-implementations";

const MAX_INPUT_PIXELS = 50_000_000;
const MAX_OUTPUT_PIXELS = 25_000_000;
const MAX_SIDE = 16_384;
export const EXTRA_RESULT_BYTE_LIMIT = 100 * 1024 * 1024;

export function assertExtraFileSizes(
  files: readonly { size: number }[],
  limits: SourceFileLimits,
): void {
  if (files.length < limits.minFiles || files.length > limits.maxFiles)
    throw new Error(`이미지는 ${limits.minFiles}~${limits.maxFiles}개 선택해 주세요.`);
  if (files.some((file) => file.size < 1 || file.size > limits.maxFileBytes))
    throw new Error(
      `파일 하나는 최대 ${Math.floor(limits.maxFileBytes / 1024 / 1024)}MB까지 선택할 수 있어요.`,
    );
  if (files.reduce((total, file) => total + file.size, 0) > limits.maxTotalBytes)
    throw new Error(
      `파일 합계는 최대 ${Math.floor(limits.maxTotalBytes / 1024 / 1024)}MB까지 선택할 수 있어요.`,
    );
}

function assertInputDimensions(width: number, height: number): void {
  if (
    ![width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_SIDE,
    ) ||
    width * height > MAX_INPUT_PIXELS
  )
    throw new Error("이미지는 최대 5천만 픽셀, 한 변 16384px까지 처리할 수 있어요.");
}

export async function inspectExtraInput(file: Blob, allowAnimatedGif = false) {
  const inspected = inspectImageHeader(await file.arrayBuffer());
  assertInputDimensions(inspected.width, inspected.height);
  if (inspected.animated && !(allowAnimatedGif && inspected.format === "gif"))
    throw new Error("움직이는 이미지는 이 도구에서 지원하지 않아요. 정지 이미지를 선택해 주세요.");
  // ponytail: the shared inspector caps GIFs at 20 frames; expose its frame count if larger GIFs are needed.
  const decodedPixels = inspected.width * inspected.height * (inspected.animated ? 20 : 1);
  if (decodedPixels > MAX_INPUT_PIXELS)
    throw new Error(
      "움직이는 GIF는 프레임당 최대 250만 픽셀까지 변환할 수 있어요. 크기를 줄여 주세요.",
    );
  return { ...inspected, decodedPixels };
}

export function planExtraDimensions(width: number, height: number, scale: number) {
  assertInputDimensions(width, height);
  const output = { width: width * scale, height: height * scale };
  if (
    ![1, 2, 4].includes(scale) ||
    output.width > MAX_SIDE ||
    output.height > MAX_SIDE ||
    output.width * output.height > MAX_OUTPUT_PIXELS
  )
    throw new Error(
      "결과는 최대 2500만 픽셀, 한 변 16384px까지 만들 수 있어요. 더 작은 이미지나 낮은 확대 배율을 선택해 주세요.",
    );
  return output;
}

export function assertExtraResultsFit(bytes: number, pixels = 0): void {
  if (!Number.isSafeInteger(pixels) || pixels < 0 || pixels > 50_000_000)
    throw new Error(
      "결과 미리보기 합계는 최대 5천만 픽셀까지 보관할 수 있어요. 파일 수나 확대 배율을 줄여 주세요.",
    );
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > EXTRA_RESULT_BYTE_LIMIT)
    throw new Error(
      "결과 합계는 최대 100MB까지 보관·다운로드할 수 있어요. 파일 수나 크기를 줄여 주세요.",
    );
}

export async function validateExtraOutput(
  blob: Blob,
  dimensions: { width: number; height: number },
  mime: string,
): Promise<void> {
  assertExtraResultsFit(blob.size);
  const actual = inspectImageHeader(await blob.arrayBuffer());
  if (
    actual.width !== dimensions.width ||
    actual.height !== dimensions.height ||
    actual.mime !== mime ||
    blob.type !== mime
  )
    throw new Error("결과의 크기 또는 형식을 확인하지 못했어요. 다시 처리해 주세요.");
}

export function loadExtraImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      image.removeAttribute("src");
      reject(new Error("이미지를 읽지 못했습니다."));
    };
    image.src = url;
  });
}

export async function loadRenderSource(
  file: File,
  scale: number,
  allowAnimatedGif = false,
): Promise<{
  source: CanvasImageSource;
  image?: HTMLImageElement;
  width: number;
  height: number;
  release: () => void;
}> {
  const inspected = await inspectExtraInput(file, allowAnimatedGif);
  planExtraDimensions(inspected.width, inspected.height, scale);
  if ((scale > 1 || inspected.animated) && typeof createImageBitmap === "function") {
    let original: ImageBitmap | undefined;
    try {
      original = await createImageBitmap(file);
    } catch {
      /* Use the image decoder below. */
    }
    if (original !== undefined) {
      try {
        const dimensions = planExtraDimensions(original.width, original.height, scale);
        // Canvas applies the exact output plan for both decoders.
        const bitmap = original;
        return { source: bitmap, ...dimensions, release: () => bitmap.close() };
      } catch (error) {
        original.close();
        throw error;
      }
    }
  }
  if (inspected.animated)
    throw new Error(
      "이 브라우저에서는 GIF 첫 프레임을 읽을 수 없어요. 다른 브라우저나 정지 이미지를 사용해 주세요.",
    );
  const image = await loadExtraImage(file);
  try {
    const dimensions = planExtraDimensions(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      scale,
    );
    return { source: image, image, ...dimensions, release: () => image.removeAttribute("src") };
  } catch (error) {
    image.removeAttribute("src");
    throw error;
  }
}
