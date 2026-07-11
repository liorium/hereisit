export const MAX_WATERMARK_TILES_PER_PAGE = 12;

const MAX_PAGE_POINTS = 14_400;
const PAGE_PADDING_RATIO = 0.04;
const TILE_GAP_RATIO = 0.2;

export type WatermarkRotation = number;
export type WatermarkPlacement = "center" | "tile";

export interface WatermarkPlacementInput {
  pageWidth: number;
  pageHeight: number;
  imageAspectRatio: number;
  fontSize: number;
  rotation: WatermarkRotation;
  placement: WatermarkPlacement;
}

export interface WatermarkDrawPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: WatermarkRotation;
}

interface RotatedBounds {
  width: number;
  height: number;
  minimumX: number;
  minimumY: number;
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label}는 유한한 양수여야 합니다.`);
  }
}

function assertInput(input: WatermarkPlacementInput): void {
  assertFinitePositive(input.pageWidth, "페이지 너비");
  assertFinitePositive(input.pageHeight, "페이지 높이");
  if (input.pageWidth > MAX_PAGE_POINTS || input.pageHeight > MAX_PAGE_POINTS) {
    throw new RangeError(`페이지 크기는 ${MAX_PAGE_POINTS}pt를 넘을 수 없습니다.`);
  }
  assertFinitePositive(input.imageAspectRatio, "워터마크 이미지 비율");
  assertFinitePositive(input.fontSize, "워터마크 글자 크기");
  if (
    !Number.isFinite(input.rotation) ||
    !Number.isInteger(input.rotation) ||
    input.rotation < -180 ||
    input.rotation > 180
  ) {
    throw new RangeError("워터마크 배치 회전은 -180도부터 180도 사이의 정수여야 합니다.");
  }
  if (input.placement !== "center" && input.placement !== "tile") {
    throw new RangeError("지원하지 않는 워터마크 배치입니다.");
  }
}

function rotatedBounds(width: number, height: number, rotation: WatermarkRotation): RotatedBounds {
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const xCoordinates = [0, width * cosine, -height * sine, width * cosine - height * sine];
  const yCoordinates = [0, width * sine, height * cosine, width * sine + height * cosine];
  const minimumX = Math.min(...xCoordinates);
  const maximumX = Math.max(...xCoordinates);
  const minimumY = Math.min(...yCoordinates);
  const maximumY = Math.max(...yCoordinates);
  return {
    width: maximumX - minimumX,
    height: maximumY - minimumY,
    minimumX,
    minimumY,
  };
}

function fitToPage(
  width: number,
  height: number,
  rotation: WatermarkRotation,
  availableWidth: number,
  availableHeight: number,
): { width: number; height: number; bounds: RotatedBounds } {
  const initialBounds = rotatedBounds(width, height, rotation);
  const scale = Math.min(
    1,
    availableWidth / initialBounds.width,
    availableHeight / initialBounds.height,
  );
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  const bounds = rotatedBounds(fittedWidth, fittedHeight, rotation);
  if (
    !Number.isFinite(fittedWidth) ||
    !Number.isFinite(fittedHeight) ||
    fittedWidth <= 0 ||
    fittedHeight <= 0 ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    throw new RangeError("워터마크 배치 크기를 안전하게 계산할 수 없습니다.");
  }
  return { width: fittedWidth, height: fittedHeight, bounds };
}

function placementAtBoundsCenter(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  bounds: RotatedBounds,
  rotation: WatermarkRotation,
): WatermarkDrawPlacement {
  return {
    x: centerX - bounds.width / 2 - bounds.minimumX,
    y: centerY - bounds.height / 2 - bounds.minimumY,
    width,
    height,
    rotation,
  };
}

/**
 * Plans watermark image draws in PDF page coordinates. `x` and `y` are the
 * unrotated image's lower-left anchor, matching `PDFPage.drawImage` semantics.
 */
export function calculateWatermarkPlacements(
  input: WatermarkPlacementInput,
): readonly WatermarkDrawPlacement[] {
  assertInput(input);
  const naturalWidth = input.fontSize * input.imageAspectRatio;
  const naturalHeight = input.fontSize;
  if (!Number.isFinite(naturalWidth)) {
    throw new RangeError("워터마크 이미지 크기를 안전하게 계산할 수 없습니다.");
  }

  const padding = Math.min(input.pageWidth, input.pageHeight) * PAGE_PADDING_RATIO;
  const availableWidth = input.pageWidth - padding * 2;
  const availableHeight = input.pageHeight - padding * 2;
  const fitted = fitToPage(
    naturalWidth,
    naturalHeight,
    input.rotation,
    availableWidth,
    availableHeight,
  );

  if (input.placement === "center") {
    return [
      placementAtBoundsCenter(
        input.pageWidth / 2,
        input.pageHeight / 2,
        fitted.width,
        fitted.height,
        fitted.bounds,
        input.rotation,
      ),
    ];
  }

  const gapX = fitted.bounds.width * TILE_GAP_RATIO;
  const gapY = fitted.bounds.height * TILE_GAP_RATIO;
  const maximumColumns = input.pageWidth >= input.pageHeight ? 4 : 3;
  const maximumRows = input.pageWidth >= input.pageHeight ? 3 : 4;
  const columns = Math.max(
    1,
    Math.min(maximumColumns, Math.floor((availableWidth + gapX) / (fitted.bounds.width + gapX))),
  );
  const rows = Math.max(
    1,
    Math.min(maximumRows, Math.floor((availableHeight + gapY) / (fitted.bounds.height + gapY))),
  );
  const cellWidth = availableWidth / columns;
  const cellHeight = availableHeight / rows;
  const placements: WatermarkDrawPlacement[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (placements.length >= MAX_WATERMARK_TILES_PER_PAGE) return placements;
      placements.push(
        placementAtBoundsCenter(
          padding + (column + 0.5) * cellWidth,
          padding + (row + 0.5) * cellHeight,
          fitted.width,
          fitted.height,
          fitted.bounds,
          input.rotation,
        ),
      );
    }
  }

  return placements;
}
