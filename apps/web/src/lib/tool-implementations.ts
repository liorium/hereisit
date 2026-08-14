import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { JSON_FORMAT_LIMITS } from "./json-format.ts";

export type ToolBundleProfile =
  | "json-quick"
  | "image"
  | "image-compression-server"
  | "image-watermark"
  | "pdf-editing"
  | "pdf-organize"
  | "pdf-to-images"
  | "pdf-compress-scanned";

export interface SourceFileLimits {
  minFiles: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  constrainedMaxTotalBytes?: number;
}

export interface ToolNotice {
  tone: "support" | "warning";
  text: string;
}

export type ImageToolIntent = "compress" | "resize" | "convert" | "watermark";
export type PdfToolIntent =
  | "merge"
  | "split"
  | "organize"
  | "watermark"
  | "to-image"
  | "image-to-pdf"
  | "compress";
export type PdfEditingIntent = Exclude<PdfToolIntent, "compress" | "to-image">;
export type PdfToolIntentClass = "editing" | "pdf-to-images" | "pdf-compress-scanned";

export function isPdfEditingIntent(intent: PdfToolIntent): intent is PdfEditingIntent {
  return intent !== "compress" && intent !== "to-image";
}

interface ToolImplementationBase {
  bundleProfile: ToolBundleProfile;
  intent: string;
  eyebrow: string;
  defaultSummary: string;
  notices: readonly ToolNotice[];
}

export type ToolImplementationConfig =
  | (ToolImplementationBase & {
      family: "image";
      sourceFileLimits: SourceFileLimits;
    })
  | (ToolImplementationBase & {
      family: "pdf";
      intentClass: PdfToolIntentClass;
      sourceFileLimits: SourceFileLimits;
    })
  | (ToolImplementationBase & {
      family: "data";
      bundleProfile: "json-quick";
      sourceTextLimitBytes: number;
      maxOutputBytes: number;
      maxDepth: number;
    });

export type ToolImplementationConfigMap = Readonly<
  Record<AvailableToolId, ToolImplementationConfig>
>;

const MEBIBYTE = 1024 * 1024;

const imageSourceFileLimits = {
  minFiles: 1,
  maxFiles: 100,
  maxFileBytes: 50 * MEBIBYTE,
  maxTotalBytes: 250 * MEBIBYTE,
} as const;

const imageOptimizeSourceFileLimits = {
  minFiles: 1,
  maxFiles: 20,
  maxFileBytes: 30 * MEBIBYTE,
  maxTotalBytes: 600 * MEBIBYTE,
} as const;

const pdfEditingSourceFileLimits = {
  minFiles: 1,
  maxFiles: 1,
  maxFileBytes: 50 * MEBIBYTE,
  maxTotalBytes: 100 * MEBIBYTE,
  constrainedMaxTotalBytes: 60 * MEBIBYTE,
} as const;

const pdfSingleFileSourceLimits = {
  minFiles: 1,
  maxFiles: 1,
  maxFileBytes: 50 * MEBIBYTE,
  maxTotalBytes: 50 * MEBIBYTE,
} as const;

function defineToolImplementationConfig<
  const T extends Record<AvailableToolId, ToolImplementationConfig>,
>(entries: T): Readonly<T> {
  return Object.freeze(entries);
}

export const toolImplementationConfig = defineToolImplementationConfig({
  "data.json-format": {
    family: "data",
    bundleProfile: "json-quick",
    intent: "json-format",
    sourceTextLimitBytes: JSON_FORMAT_LIMITS.maxInputBytes,
    maxOutputBytes: JSON_FORMAT_LIMITS.maxOutputBytes,
    maxDepth: JSON_FORMAT_LIMITS.maxDepth,
    eyebrow: "JSON FORMATTER",
    defaultSummary: "JSON 값을 바꾸지 않고 문법을 확인한 뒤 읽기 좋게 정리하거나 공백만 줄여요.",
    notices: [],
  },
  "image.compress": {
    family: "image",
    bundleProfile: "image-compression-server",
    intent: "compress",
    sourceFileLimits: imageOptimizeSourceFileLimits,
    eyebrow: "IMAGE COMPRESSOR",
    defaultSummary:
      "원본 형식과 크기를 유지한 채 프로덕션급 압축을 시도하고, 작아지지 않으면 원본을 그대로 유지해요.",
    notices: [],
  },
  "image.resize": {
    family: "image",
    bundleProfile: "image",
    intent: "resize",
    sourceFileLimits: imageSourceFileLimits,
    eyebrow: "IMAGE RESIZER",
    defaultSummary: "기본값은 비율을 유지해 긴 변을 최대 1920px로 줄이고 WebP로 저장해요.",
    notices: [],
  },
  "image.convert": {
    family: "image",
    bundleProfile: "image",
    intent: "convert",
    sourceFileLimits: imageSourceFileLimits,
    eyebrow: "IMAGE CONVERTER",
    defaultSummary: "기본값은 이미지 크기를 유지하면서 가벼운 WebP 파일로 변환해요.",
    notices: [{ tone: "support", text: "HEIC 변환은 Safari 17 이상에서 지원해요." }],
  },
  "image.watermark": {
    family: "image",
    bundleProfile: "image-watermark",
    intent: "watermark",
    sourceFileLimits: imageSourceFileLimits,
    eyebrow: "IMAGE WATERMARK",
    defaultSummary:
      "기본값은 ‘© HereIsIt’ 문구를 오른쪽 아래에 짧은 변의 12% 크기, 3% 여백, 55% 불투명도, #111827 색상으로 넣고 원본 형식(품질 90)으로 저장해요.",
    notices: [{ tone: "support", text: "HEIC 워터마크는 Safari 17 이상에서 지원해요." }],
  },
  "pdf.merge": {
    family: "pdf",
    bundleProfile: "pdf-editing",
    intent: "merge",
    intentClass: "editing",
    sourceFileLimits: {
      ...pdfEditingSourceFileLimits,
      minFiles: 2,
      maxFiles: 20,
    },
    eyebrow: "PDF MERGER",
    defaultSummary: "선택한 순서대로 페이지를 이미지로 바꾸지 않고 하나의 PDF로 합쳐요.",
    notices: [
      {
        tone: "warning",
        text: "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
      },
    ],
  },
  "pdf.split": {
    family: "pdf",
    bundleProfile: "pdf-editing",
    intent: "split",
    intentClass: "editing",
    sourceFileLimits: pdfEditingSourceFileLimits,
    eyebrow: "PDF SPLITTER",
    defaultSummary: "기본값은 각 페이지를 별도 PDF로 나누고 하나의 ZIP으로 저장해요.",
    notices: [
      {
        tone: "warning",
        text: "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
      },
    ],
  },
  "pdf.organize": {
    family: "pdf",
    bundleProfile: "pdf-organize",
    intent: "organize",
    intentClass: "editing",
    sourceFileLimits: pdfEditingSourceFileLimits,
    eyebrow: "PDF ORGANIZER",
    defaultSummary:
      "페이지 미리보기를 기기 안에서 확인하며 순서·회전·삭제 계획대로 새 PDF를 만들어요.",
    notices: [
      {
        tone: "warning",
        text: "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
      },
    ],
  },
  "pdf.watermark": {
    family: "pdf",
    bundleProfile: "pdf-editing",
    intent: "watermark",
    intentClass: "editing",
    sourceFileLimits: pdfEditingSourceFileLimits,
    eyebrow: "PDF WATERMARK",
    defaultSummary:
      "기본값은 모든 페이지에 ‘대외비’를 18% 불투명도로 가운데에 넣고, 적용 페이지·문구·배치·크기·각도·색상을 바꿀 수 있어요.",
    notices: [
      {
        tone: "warning",
        text: "워터마크 문구는 호환성을 위해 이미지로 그려져 검색하거나 선택할 수 없어요. 기존 전자서명도 새 PDF에서 무효화됩니다.",
      },
    ],
  },
  "pdf.image-to-pdf": {
    family: "pdf",
    bundleProfile: "pdf-editing",
    intent: "image-to-pdf",
    intentClass: "editing",
    sourceFileLimits: {
      ...pdfEditingSourceFileLimits,
      maxFiles: 100,
    },
    eyebrow: "IMAGE TO PDF",
    defaultSummary:
      "이미지 한 장을 PDF 한 페이지로 넣고 원본 비율과 순서를 유지하며 촬영 위치 정보는 제외해요.",
    notices: [
      {
        tone: "warning",
        text: "광색역·16비트 이미지는 PDF에서 색감이나 정밀도가 달라질 수 있어요.",
      },
    ],
  },
  "pdf.to-image": {
    family: "pdf",
    bundleProfile: "pdf-to-images",
    intent: "to-image",
    intentClass: "pdf-to-images",
    sourceFileLimits: pdfSingleFileSourceLimits,
    eyebrow: "PDF TO IMAGE",
    defaultSummary:
      "기본값은 모든 페이지를 150DPI JPG(품질 85)로 만들고, 한 장은 이미지로 여러 장은 ZIP으로 저장해요.",
    notices: [
      {
        tone: "warning",
        text: "결과는 래스터 이미지라 텍스트를 검색하거나 선택할 수 없고, 주석·양식 모양은 평면화되며 색상 프로필이 달라질 수 있어요.",
      },
    ],
  },
  "pdf.compress-scanned": {
    family: "pdf",
    bundleProfile: "pdf-compress-scanned",
    intent: "compress",
    intentClass: "pdf-compress-scanned",
    sourceFileLimits: pdfSingleFileSourceLimits,
    eyebrow: "PDF COMPRESSOR",
    defaultSummary:
      "먼저 이 기기에서 압축하고, 줄어들지 않을 때만 선택해서 처리 서버로 더 압축해요.",
    notices: [
      {
        tone: "warning",
        text: "텍스트와 링크는 유지하고, 이미지로만 된 스캔 PDF는 선택한 압축 수준으로 다시 만들어요. 전자서명은 무효가 될 수 있으며 원본 파일은 수정하지 않아요.",
      },
    ],
  },
} as const satisfies Record<AvailableToolId, ToolImplementationConfig>);

export function getToolImplementation<const Id extends AvailableToolId>(
  id: Id,
): (typeof toolImplementationConfig)[Id] {
  const implementation = toolImplementationConfig[id];
  if (implementation === undefined) throw new Error(`Missing tool implementation: ${id}`);
  return implementation;
}
