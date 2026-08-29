import type { ImageRotation, ImageSourceRect, ResizeSpec } from "@hereisit/tool-contracts";

export interface DrawGeometry {
  canvasWidth: number;
  canvasHeight: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  destinationX: number;
  destinationY: number;
  destinationWidth: number;
  destinationHeight: number;
  upscalingSkipped: boolean;
}

export type CropFocalPointPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

const CROP_FOCAL_POINTS: Readonly<
  Record<CropFocalPointPosition, Readonly<{ x: number; y: number }>>
> = Object.freeze({
  "top-left": { x: 0, y: 0 },
  "top-center": { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  "center-left": { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  "center-right": { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  "bottom-center": { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
});

const MAX_IMAGE_DIMENSION = 16_384;

function clampUnit(value: number, fallback = 0.5): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

export function clampImageDimension(value: number, fallback = 1): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.round(fallback)))
    : 1;
  if (!Number.isFinite(value) || value <= 0) return safeFallback;
  return Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.round(value)));
}

export function focalPointForCropPosition(position: CropFocalPointPosition): {
  x: number;
  y: number;
} {
  const focalPoint = CROP_FOCAL_POINTS[position];
  return { x: focalPoint.x, y: focalPoint.y };
}

export function focalPointFromNormalizedPosition(
  x: number,
  y: number,
): {
  x: number;
  y: number;
} {
  return { x: clampUnit(x), y: clampUnit(y) };
}

export function normalizedSourceRectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  minimumWidth = 0.01,
  minimumHeight = 0.01,
): ImageSourceRect {
  const minWidth = Math.max(0.000001, clampUnit(minimumWidth, 0.01));
  const minHeight = Math.max(0.000001, clampUnit(minimumHeight, 0.01));
  const normalizedStartX = clampUnit(startX);
  const normalizedStartY = clampUnit(startY);
  const normalizedEndX = clampUnit(endX);
  const normalizedEndY = clampUnit(endY);
  const left = Math.min(normalizedStartX, normalizedEndX);
  const top = Math.min(normalizedStartY, normalizedEndY);
  const right = Math.max(normalizedStartX, normalizedEndX);
  const bottom = Math.max(normalizedStartY, normalizedEndY);
  const width = Math.max(minWidth, right - left);
  const height = Math.max(minHeight, bottom - top);

  const roundUnit = (value: number) => Number(value.toFixed(6));
  const normalizedWidth = roundUnit(Math.min(width, 1));
  const normalizedHeight = roundUnit(Math.min(height, 1));

  return {
    x: roundUnit(Math.min(left, 1 - normalizedWidth)),
    y: roundUnit(Math.min(top, 1 - normalizedHeight)),
    width: normalizedWidth,
    height: normalizedHeight,
  };
}

function roundDimension(value: number): number {
  return Math.max(1, Math.round(value));
}

export function computeDrawGeometry(
  sourceWidth: number,
  sourceHeight: number,
  resize: ResizeSpec,
  rotation: ImageRotation = 0,
): DrawGeometry {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
    throw new Error("이미지 크기가 올바르지 않습니다.");
  }

  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("이미지 크기는 1픽셀 이상이어야 합니다.");
  }

  const base = {
    sourceX: 0,
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    destinationX: 0,
    destinationY: 0,
    upscalingSkipped: false,
  };

  if (resize.kind === "none" && rotation % 180 === 90) {
    return {
      ...base,
      canvasWidth: sourceHeight,
      canvasHeight: sourceWidth,
      destinationWidth: sourceHeight,
      destinationHeight: sourceWidth,
    };
  }

  if (resize.kind === "none" && rotation === 180) {
    return {
      ...base,
      canvasWidth: sourceWidth,
      canvasHeight: sourceHeight,
      destinationWidth: sourceWidth,
      destinationHeight: sourceHeight,
    };
  }

  if (resize.kind === "none") {
    return {
      ...base,
      canvasWidth: sourceWidth,
      canvasHeight: sourceHeight,
      destinationWidth: sourceWidth,
      destinationHeight: sourceHeight,
    };
  }

  if (resize.kind === "stretch") {
    return {
      ...base,
      canvasWidth: resize.width,
      canvasHeight: resize.height,
      destinationWidth: resize.width,
      destinationHeight: resize.height,
    };
  }

  if (resize.kind === "inside") {
    const widthScale =
      resize.maxWidth === undefined ? Number.POSITIVE_INFINITY : resize.maxWidth / sourceWidth;
    const heightScale =
      resize.maxHeight === undefined ? Number.POSITIVE_INFINITY : resize.maxHeight / sourceHeight;
    const requestedScale = Math.min(widthScale, heightScale);
    const allowUpscale = resize.allowUpscale ?? false;
    const scale = allowUpscale ? requestedScale : Math.min(1, requestedScale);
    const width = roundDimension(sourceWidth * scale);
    const height = roundDimension(sourceHeight * scale);

    return {
      ...base,
      canvasWidth: width,
      canvasHeight: height,
      destinationWidth: width,
      destinationHeight: height,
      upscalingSkipped: !allowUpscale && requestedScale > 1,
    };
  }

  if (resize.kind === "percentage") {
    const requestedScale = resize.percent / 100;
    const allowUpscale = resize.allowUpscale ?? false;
    const scale = allowUpscale ? requestedScale : Math.min(1, requestedScale);
    const width = roundDimension(sourceWidth * scale);
    const height = roundDimension(sourceHeight * scale);

    return {
      ...base,
      canvasWidth: width,
      canvasHeight: height,
      destinationWidth: width,
      destinationHeight: height,
      upscalingSkipped: !allowUpscale && requestedScale > 1,
    };
  }

  const focalX = clampUnit(resize.focalPoint?.x ?? 0.5);
  const focalY = clampUnit(resize.focalPoint?.y ?? 0.5);

  if (resize.sourceRect !== undefined) {
    return {
      ...base,
      canvasWidth: resize.width,
      canvasHeight: resize.height,
      sourceX: sourceWidth * resize.sourceRect.x,
      sourceY: sourceHeight * resize.sourceRect.y,
      sourceWidth: sourceWidth * resize.sourceRect.width,
      sourceHeight: sourceHeight * resize.sourceRect.height,
      destinationWidth: resize.width,
      destinationHeight: resize.height,
    };
  }

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = resize.width / resize.height;

  if (sourceRatio > targetRatio) {
    const croppedWidth = sourceHeight * targetRatio;
    return {
      ...base,
      canvasWidth: resize.width,
      canvasHeight: resize.height,
      sourceX: (sourceWidth - croppedWidth) * focalX,
      sourceWidth: croppedWidth,
      destinationWidth: resize.width,
      destinationHeight: resize.height,
    };
  }

  const croppedHeight = sourceWidth / targetRatio;
  return {
    ...base,
    canvasWidth: resize.width,
    canvasHeight: resize.height,
    sourceY: (sourceHeight - croppedHeight) * focalY,
    sourceHeight: croppedHeight,
    destinationWidth: resize.width,
    destinationHeight: resize.height,
  };
}
