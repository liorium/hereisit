import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { JSON_FORMAT_LIMITS } from "./json-format.ts";

export type ToolBundleProfile =
  | "json-quick"
  | "image"
  | "image-compression-server"
  | "image-extra"
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

export type ImageToolIntent = "compress" | "resize" | "crop" | "convert" | "rotate" | "watermark";
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
  "image.crop": {
    family: "image",
    bundleProfile: "image",
    intent: "crop",
    sourceFileLimits: imageSourceFileLimits,
    eyebrow: "IMAGE CROPPER",
    defaultSummary: "원하는 비율로 이미지의 필요한 부분만 잘라내고 원본 형식으로 저장해요.",
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
  "image.rotate": {
    family: "image",
    bundleProfile: "image",
    intent: "rotate",
    sourceFileLimits: imageSourceFileLimits,
    eyebrow: "IMAGE ROTATOR",
    defaultSummary: "이미지를 90도 단위로 회전하고 원본 형식으로 저장해요.",
    notices: [],
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
  "image.convert-to-jpg": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "convert-to-jpg",
    sourceFileLimits: imageSourceFileLimits,
    eyebrow: "JPG CONVERTER",
    defaultSummary: "PNG·GIF·WebP·SVG 이미지를 JPG로 바꾸고 여러 결과를 ZIP으로 받을 수 있어요.",
    notices: [{ tone: "support", text: "브라우저가 직접 읽을 수 있는 형식만 변환할 수 있어요." }],
  },
  "image.convert-from-jpg": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "convert-from-jpg",
    sourceFileLimits: {
      minFiles: 1,
      maxFiles: 20,
      maxFileBytes: 30 * MEBIBYTE,
      maxTotalBytes: 200 * MEBIBYTE,
    },
    eyebrow: "JPG EXPORTER",
    defaultSummary: "JPG를 PNG로 바꾸거나 여러 장을 움직이는 GIF로 만들어 내 기기에 저장해요.",
    notices: [],
  },
  "image.editor": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "editor",
    sourceFileLimits: {
      minFiles: 1,
      maxFiles: 1,
      maxFileBytes: 30 * MEBIBYTE,
      maxTotalBytes: 30 * MEBIBYTE,
    },
    eyebrow: "PHOTO EDITOR",
    defaultSummary: "밝기·대비·채도·필터와 문구를 조절해 사진을 가볍게 편집해요.",
    notices: [],
  },
  "image.meme": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "meme",
    sourceFileLimits: {
      minFiles: 1,
      maxFiles: 1,
      maxFileBytes: 30 * MEBIBYTE,
      maxTotalBytes: 30 * MEBIBYTE,
    },
    eyebrow: "MEME MAKER",
    defaultSummary: "사진 위아래에 짧은 문구를 넣어 밈을 만들어요.",
    notices: [],
  },
  "image.html-to-image": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "html-to-image",
    sourceFileLimits: {
      minFiles: 0,
      maxFiles: 0,
      maxFileBytes: 0,
      maxTotalBytes: 0,
    },
    eyebrow: "HTML TO IMAGE",
    defaultSummary:
      "HTML과 CSS를 브라우저 안에서 PNG로 렌더링해요. 외부 URL이나 리소스는 읽지 않아요.",
    notices: [
      { tone: "support", text: "외부 이미지·스크립트·링크는 보안상 제거하고 렌더링합니다." },
    ],
  },
  "image.upscale": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "upscale",
    sourceFileLimits: {
      minFiles: 1,
      maxFiles: 20,
      maxFileBytes: 20 * MEBIBYTE,
      maxTotalBytes: 200 * MEBIBYTE,
    },
    eyebrow: "IMAGE UPSCALER",
    defaultSummary: "브라우저의 고품질 보간으로 이미지를 2배 또는 4배 확대해요.",
    notices: [
      { tone: "support", text: "AI 복원이 아닌 고품질 픽셀 보간 방식이며 원본은 보존해요." },
    ],
  },
  "image.blur-face": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "blur-face",
    sourceFileLimits: {
      minFiles: 1,
      maxFiles: 1,
      maxFileBytes: 30 * MEBIBYTE,
      maxTotalBytes: 30 * MEBIBYTE,
    },
    eyebrow: "PRIVACY BLUR",
    defaultSummary: "얼굴·번호판·이름 등 가릴 영역을 드래그해 흐리게 처리해요.",
    notices: [
      { tone: "warning", text: "자동 얼굴 인식 대신 지정한 사각형 영역을 확실하게 흐립니다." },
    ],
  },
  "image.remove-background": {
    family: "image",
    bundleProfile: "image-extra",
    intent: "remove-background",
    sourceFileLimits: {
      minFiles: 1,
      maxFiles: 20,
      maxFileBytes: 20 * MEBIBYTE,
      maxTotalBytes: 200 * MEBIBYTE,
    },
    eyebrow: "BACKGROUND REMOVER",
    defaultSummary: "가장자리와 연결된 배경색을 제거해 투명 PNG로 만들어요.",
    notices: [
      { tone: "support", text: "단색에 가까운 배경에 가장 잘 맞으며 원본은 바꾸지 않아요." },
    ],
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
    defaultSummary: "기본은 고성능 처리 서버에서 압축하고, 원하면 내 기기에서 처리할 수 있어요.",
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
