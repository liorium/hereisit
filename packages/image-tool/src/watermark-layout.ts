import type { ImageWatermarkPosition } from "@hereisit/tool-contracts";

export interface WatermarkSize {
  width: number;
  height: number;
}

export interface WatermarkRect extends WatermarkSize {
  x: number;
  y: number;
}

type AxisAnchor = "start" | "center" | "end";

const anchors: Record<ImageWatermarkPosition, { horizontal: AxisAnchor; vertical: AxisAnchor }> = {
  "top-left": { horizontal: "start", vertical: "start" },
  "top-center": { horizontal: "center", vertical: "start" },
  "top-right": { horizontal: "end", vertical: "start" },
  "middle-left": { horizontal: "start", vertical: "center" },
  center: { horizontal: "center", vertical: "center" },
  "middle-right": { horizontal: "end", vertical: "center" },
  "bottom-left": { horizontal: "start", vertical: "end" },
  "bottom-center": { horizontal: "center", vertical: "end" },
  "bottom-right": { horizontal: "end", vertical: "end" },
};

function assertPositiveFiniteDimension(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function assertFittedSize(size: WatermarkSize): void {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new RangeError("Watermark dimensions cannot be fitted safely");
  }
}

export function fitWatermarkSize(
  contentWidth: number,
  contentHeight: number,
  maximumWidth: number,
  maximumHeight: number,
): WatermarkSize {
  assertPositiveFiniteDimension(contentWidth, "contentWidth");
  assertPositiveFiniteDimension(contentHeight, "contentHeight");
  assertPositiveFiniteDimension(maximumWidth, "maximumWidth");
  assertPositiveFiniteDimension(maximumHeight, "maximumHeight");

  const scale = Math.min(1, maximumWidth / contentWidth, maximumHeight / contentHeight);
  const size = {
    width: Math.min(maximumWidth, contentWidth * scale),
    height: Math.min(maximumHeight, contentHeight * scale),
  };
  assertFittedSize(size);
  return size;
}

function resolveAxisCoordinate(
  anchor: AxisAnchor,
  canvasSize: number,
  watermarkSize: number,
  margin: number,
): number {
  const maximumCoordinate = Math.max(0, canvasSize - watermarkSize);
  const coordinate =
    anchor === "center"
      ? maximumCoordinate / 2
      : anchor === "start"
        ? margin
        : canvasSize - margin - watermarkSize;
  return Math.min(maximumCoordinate, Math.max(0, coordinate));
}

export function computeWatermarkRect(input: {
  canvasWidth: number;
  canvasHeight: number;
  watermarkWidth: number;
  watermarkHeight: number;
  position: ImageWatermarkPosition;
  marginPercent: number;
}): WatermarkRect {
  assertPositiveFiniteDimension(input.canvasWidth, "canvasWidth");
  assertPositiveFiniteDimension(input.canvasHeight, "canvasHeight");
  assertPositiveFiniteDimension(input.watermarkWidth, "watermarkWidth");
  assertPositiveFiniteDimension(input.watermarkHeight, "watermarkHeight");
  if (input.canvasWidth < 1 || input.canvasHeight < 1) {
    throw new RangeError("Canvas dimensions must be at least one pixel");
  }
  if (!Number.isFinite(input.marginPercent) || input.marginPercent < 0) {
    throw new RangeError("marginPercent must be a non-negative finite number");
  }

  const anchor = anchors[input.position];
  if (!anchor) {
    throw new RangeError("position must be a supported watermark anchor");
  }

  const margin = Math.round(
    (Math.min(input.canvasWidth, input.canvasHeight) * input.marginPercent) / 100,
  );
  if (!Number.isFinite(margin)) {
    throw new RangeError("Watermark margin cannot be represented safely");
  }

  const maximumWidth = Math.max(1, input.canvasWidth - margin * 2);
  const maximumHeight = Math.max(1, input.canvasHeight - margin * 2);
  const size = fitWatermarkSize(
    input.watermarkWidth,
    input.watermarkHeight,
    maximumWidth,
    maximumHeight,
  );
  const rectangle = {
    x: resolveAxisCoordinate(anchor.horizontal, input.canvasWidth, size.width, margin),
    y: resolveAxisCoordinate(anchor.vertical, input.canvasHeight, size.height, margin),
    ...size,
  };

  if (
    !Number.isFinite(rectangle.x) ||
    !Number.isFinite(rectangle.y) ||
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.x + rectangle.width > input.canvasWidth ||
    rectangle.y + rectangle.height > input.canvasHeight
  ) {
    throw new RangeError("Watermark rectangle cannot be placed inside the canvas");
  }

  return rectangle;
}
