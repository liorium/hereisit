import type { ImageRotation, ResizeSpec } from "@hereisit/tool-contracts";

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

  const focalX = resize.focalPoint?.x ?? 0.5;
  const focalY = resize.focalPoint?.y ?? 0.5;
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
