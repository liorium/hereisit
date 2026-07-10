import type { ResizeSpec } from "@hereisit/tool-contracts";

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

function roundDimension(value: number): number {
  return Math.max(1, Math.round(value));
}

export function computeDrawGeometry(
  sourceWidth: number,
  sourceHeight: number,
  resize: ResizeSpec,
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
