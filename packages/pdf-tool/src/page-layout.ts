export interface PdfImagePageLayout {
  pageWidth: number;
  pageHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PdfImageOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type PdfImageDrawMatrix = [number, number, number, number, number, number];

export interface OrientedPdfImageLayout extends PdfImagePageLayout {
  drawMatrix: PdfImageDrawMatrix;
}

export type PdfImagePageSettings = { size: "a4"; margin: number } | { size: "image"; margin: 0 };

const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
const PIXEL_TO_POINT = 72 / 96;
const MAX_PAGE_POINTS = 14_400;

export function calculatePdfImageLayout(
  imageWidth: number,
  imageHeight: number,
  settings: PdfImagePageSettings,
): PdfImagePageLayout {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    throw new RangeError("이미지 크기는 0보다 커야 합니다.");
  }

  if (settings.size === "image") {
    const naturalWidth = imageWidth * PIXEL_TO_POINT;
    const naturalHeight = imageHeight * PIXEL_TO_POINT;
    const scale = Math.min(1, MAX_PAGE_POINTS / Math.max(naturalWidth, naturalHeight));
    const pageWidth = Math.max(1, naturalWidth * scale);
    const pageHeight = Math.max(1, naturalHeight * scale);
    return { pageWidth, pageHeight, x: 0, y: 0, width: pageWidth, height: pageHeight };
  }

  const landscape = imageWidth > imageHeight;
  const pageWidth = landscape ? A4_PORTRAIT.height : A4_PORTRAIT.width;
  const pageHeight = landscape ? A4_PORTRAIT.width : A4_PORTRAIT.height;
  const margin = Math.max(0, Math.min(72, settings.margin));
  const availableWidth = Math.max(1, pageWidth - margin * 2);
  const availableHeight = Math.max(1, pageHeight - margin * 2);
  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    pageWidth,
    pageHeight,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
}

export function calculatePdfImageDrawMatrix(
  layout: PdfImagePageLayout,
  orientation: PdfImageOrientation,
): PdfImageDrawMatrix {
  const { x, y, width, height } = layout;
  switch (orientation) {
    case 1:
      return [width, 0, 0, height, x, y];
    case 2:
      return [-width, 0, 0, height, x + width, y];
    case 3:
      return [-width, 0, 0, -height, x + width, y + height];
    case 4:
      return [width, 0, 0, -height, x, y + height];
    case 5:
      return [0, -height, -width, 0, x + width, y + height];
    case 6:
      return [0, -height, width, 0, x, y + height];
    case 7:
      return [0, height, width, 0, x, y];
    case 8:
      return [0, height, -width, 0, x + width, y];
  }
}

export function calculateOrientedPdfImageLayout(
  imageWidth: number,
  imageHeight: number,
  settings: PdfImagePageSettings,
  orientation: PdfImageOrientation,
): OrientedPdfImageLayout {
  const swapsAxes = orientation >= 5;
  const layout = calculatePdfImageLayout(
    swapsAxes ? imageHeight : imageWidth,
    swapsAxes ? imageWidth : imageHeight,
    settings,
  );
  return { ...layout, drawMatrix: calculatePdfImageDrawMatrix(layout, orientation) };
}
