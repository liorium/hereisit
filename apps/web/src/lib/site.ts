export const SITE_NAME = "HereIsIt";
export const SITE_URL = "https://hereisit.pages.dev";

export const HOME_TITLE = "HereIsIt — 이미지·PDF 작업, 여기서 끝";
export const HOME_DESCRIPTION =
  "이미지 압축·크기 조절·형식 변환과 PDF 합치기·분할·페이지 정리·워터마크·PDF 이미지 변환·이미지 PDF 변환·스캔 PDF 용량 줄이기를 업로드 없이 내 기기에서 빠르게 처리하세요.";
export const HOME_OPEN_GRAPH_DESCRIPTION =
  "파일은 기기 밖으로 나가지 않아요. 이미지와 PDF 작업을 브라우저에서 빠르게 처리하세요.";
export const PDF_COMPRESS_SCANNED_WARNING =
  "모든 페이지가 이미지로 바뀝니다. 검색·복사 가능한 텍스트와 OCR, 링크·양식·주석·북마크·첨부파일·레이어가 제거되거나 평면화되고 전자서명은 무효가 됩니다. 스캔 문서에 적합하며 원본 파일은 수정하지 않아요.";

export type ImageToolIntent = "compress" | "resize" | "convert";

export interface ToolStep {
  title: string;
  description: string;
}

export interface ImageToolConfig {
  intent: ImageToolIntent;
  path: `/image/${ImageToolIntent}`;
  navLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  defaultSummary: string;
  steps: readonly [ToolStep, ToolStep, ToolStep];
  heicNote?: string;
}

export const imageTools = {
  compress: {
    intent: "compress",
    path: "/image/compress",
    navLabel: "용량 줄이기",
    eyebrow: "IMAGE COMPRESSOR",
    title: "이미지 용량 줄이기",
    description:
      "JPG, PNG, WebP, HEIC 이미지를 무료로 압축하세요. 파일을 서버에 올리지 않고 브라우저에서 바로 처리합니다.",
    defaultSummary:
      "기본값은 WebP로 변환해 원본보다 작게 만들고, 초고해상도만 최대 5000px로 조정해요.",
    heicNote: "HEIC 압축은 Safari 17 이상에서 지원해요.",
    steps: [
      { title: "이미지 선택", description: "압축할 이미지를 한 장 또는 여러 장 선택하세요." },
      {
        title: "용량 줄이기",
        description: "기기 안에서 품질을 조정해 원본보다 작은 결과를 찾아요.",
      },
      {
        title: "결과 저장",
        description: "기본 WebP 결과 한 장은 바로 저장하고 여러 장은 ZIP으로 받아요.",
      },
    ],
  },
  resize: {
    intent: "resize",
    path: "/image/resize",
    navLabel: "크기 조절",
    eyebrow: "IMAGE RESIZER",
    title: "이미지 크기 조절",
    description:
      "사진의 가로·세로 크기를 빠르게 바꾸세요. 업로드 없이 긴 변 축소와 정사각형 자르기를 한 번에 처리합니다.",
    defaultSummary: "기본값은 비율을 유지해 긴 변을 최대 1920px로 줄이고 WebP로 저장해요.",
    steps: [
      { title: "이미지 선택", description: "크기를 바꿀 사진을 기기에서 선택하세요." },
      {
        title: "크기 설정",
        description: "최대 크기 또는 정사각형 프리셋을 고르고 결과를 확인하세요.",
      },
      {
        title: "결과 저장",
        description: "원본은 그대로 두고 기본 WebP 결과를 새 파일로 저장해요.",
      },
    ],
  },
  convert: {
    intent: "convert",
    path: "/image/convert",
    navLabel: "형식 변환",
    eyebrow: "IMAGE CONVERTER",
    title: "이미지 형식 변환",
    description:
      "JPG, PNG, WebP, HEIC 이미지를 원하는 형식으로 변환하세요. 파일은 서버로 전송되지 않습니다.",
    defaultSummary: "기본값은 이미지 크기를 유지하면서 가벼운 WebP 파일로 변환해요.",
    steps: [
      { title: "이미지 선택", description: "형식을 바꿀 이미지를 한 번에 최대 100장 선택하세요." },
      {
        title: "출력 형식 선택",
        description: "JPG, PNG 또는 WebP 중 필요한 형식과 품질을 골라요.",
      },
      { title: "결과 저장", description: "변환이 끝난 파일만 기기에 안전하게 저장해요." },
    ],
    heicNote: "HEIC 변환은 Safari 17 이상에서 지원해요.",
  },
} as const satisfies Record<ImageToolIntent, ImageToolConfig>;

export const imageToolList: readonly ImageToolConfig[] = Object.values(imageTools);

export function relatedImageTools(intent: ImageToolIntent): readonly ImageToolConfig[] {
  return imageToolList.filter((tool) => tool.intent !== intent);
}

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

export interface PdfToolConfig {
  intent: PdfToolIntent;
  intentClass: PdfToolIntentClass;
  path: `/pdf/${PdfToolIntent}`;
  navLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  defaultSummary: string;
  warning?: string;
  steps: readonly [ToolStep, ToolStep, ToolStep];
}

export const pdfTools = {
  merge: {
    intent: "merge",
    intentClass: "editing",
    path: "/pdf/merge",
    navLabel: "PDF 합치기",
    eyebrow: "PDF MERGER",
    title: "PDF 합치기",
    description:
      "여러 PDF 파일을 원하는 순서대로 하나로 합치세요. 파일을 서버에 올리지 않고 브라우저에서 바로 처리합니다.",
    defaultSummary: "선택한 순서대로 페이지를 이미지로 바꾸지 않고 하나의 PDF로 합쳐요.",
    warning:
      "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
    steps: [
      { title: "PDF 선택", description: "합칠 PDF를 2개 이상 선택하세요." },
      { title: "순서 정리", description: "위·아래 버튼으로 합쳐질 파일 순서를 정하세요." },
      { title: "하나로 저장", description: "모든 페이지를 담은 새 PDF를 기기에 저장해요." },
    ],
  },
  split: {
    intent: "split",
    intentClass: "editing",
    path: "/pdf/split",
    navLabel: "페이지 분할",
    eyebrow: "PDF SPLITTER",
    title: "PDF 페이지 분할",
    description:
      "PDF를 페이지별로 나누거나 필요한 페이지만 추출하세요. 파일은 기기 안에서만 처리됩니다.",
    defaultSummary: "기본값은 각 페이지를 별도 PDF로 나누고 하나의 ZIP으로 저장해요.",
    warning:
      "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
    steps: [
      { title: "PDF 선택", description: "나눌 PDF 한 개를 선택하세요." },
      { title: "방식 선택", description: "페이지별 분리 또는 필요한 페이지 추출을 골라요." },
      { title: "결과 저장", description: "분할 ZIP이나 추출된 새 PDF를 기기에 저장해요." },
    ],
  },
  organize: {
    intent: "organize",
    intentClass: "editing",
    path: "/pdf/organize",
    navLabel: "페이지 정리",
    eyebrow: "PDF ORGANIZER",
    title: "PDF 페이지 정리",
    description:
      "PDF 페이지 순서를 바꾸고 90도씩 회전하거나 필요 없는 페이지를 빼세요. 파일은 기기 안에서만 처리됩니다.",
    defaultSummary:
      "페이지 번호 목록을 기기 안에서 확인한 뒤 순서·회전·삭제 계획대로 새 PDF를 만들어요.",
    warning:
      "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
    steps: [
      { title: "PDF 선택", description: "정리할 PDF 한 개를 선택하세요." },
      {
        title: "페이지 정리",
        description: "페이지를 위아래로 옮기고 90도씩 회전하거나 결과에서 빼세요.",
      },
      { title: "새 PDF 저장", description: "정리 계획을 적용한 새 PDF를 기기에 저장해요." },
    ],
  },
  watermark: {
    intent: "watermark",
    intentClass: "editing",
    path: "/pdf/watermark",
    navLabel: "워터마크",
    eyebrow: "PDF WATERMARK",
    title: "PDF 워터마크 넣기",
    description:
      "PDF 모든 페이지 또는 지정한 페이지에 원하는 문구의 워터마크를 넣으세요. 업로드 없이 브라우저에서 처리합니다.",
    defaultSummary:
      "기본값은 모든 페이지에 ‘대외비’를 18% 불투명도로 가운데에 넣고, 적용 페이지·문구·배치·크기·각도·색상을 바꿀 수 있어요.",
    warning:
      "워터마크 문구는 호환성을 위해 이미지로 그려져 검색하거나 선택할 수 없어요. 기존 전자서명도 새 PDF에서 무효화됩니다.",
    steps: [
      { title: "PDF 선택", description: "워터마크를 넣을 PDF 한 개를 선택하세요." },
      {
        title: "페이지와 모양 설정",
        description: "적용 페이지·문구·배치·글자 크기·불투명도·각도·색상을 정하세요.",
      },
      {
        title: "새 PDF 저장",
        description: "선택한 페이지에 워터마크를 넣은 새 PDF를 기기에 저장해요.",
      },
    ],
  },
  "to-image": {
    intent: "to-image",
    intentClass: "pdf-to-images",
    path: "/pdf/to-image",
    navLabel: "PDF→이미지",
    eyebrow: "PDF TO IMAGE",
    title: "PDF를 JPG·PNG로 변환",
    description:
      "PDF 페이지를 JPG 또는 PNG 이미지로 변환하세요. 업로드 없이 브라우저에서 처리합니다.",
    defaultSummary:
      "기본값은 모든 페이지를 150DPI JPG(품질 85)로 만들고, 한 장은 이미지로 여러 장은 ZIP으로 저장해요.",
    warning:
      "결과는 래스터 이미지라 텍스트를 검색하거나 선택할 수 없고, 주석·양식 모양은 평면화되며 색상 프로필이 달라질 수 있어요.",
    steps: [
      { title: "PDF 선택", description: "변환할 PDF 한 개를 기기에서 선택하세요." },
      {
        title: "변환 설정",
        description: "페이지·JPG/PNG·해상도와 JPG 품질을 정하세요.",
      },
      { title: "이미지 저장", description: "한 장은 이미지로, 여러 장은 ZIP으로 저장해요." },
    ],
  },
  "image-to-pdf": {
    intent: "image-to-pdf",
    intentClass: "editing",
    path: "/pdf/image-to-pdf",
    navLabel: "이미지→PDF",
    eyebrow: "IMAGE TO PDF",
    title: "이미지를 PDF로 변환",
    description:
      "JPG와 PNG 이미지를 원하는 순서대로 한 PDF로 만드세요. 업로드 없이 내 기기에서 처리합니다.",
    defaultSummary:
      "이미지 한 장을 PDF 한 페이지로 넣고 원본 비율과 순서를 유지하며 촬영 위치 정보는 제외해요.",
    warning: "광색역·16비트 이미지는 PDF에서 색감이나 정밀도가 달라질 수 있어요.",
    steps: [
      { title: "이미지 선택", description: "JPG 또는 PNG 이미지를 최대 100장 선택하세요." },
      { title: "순서·페이지 설정", description: "페이지 순서와 A4 또는 이미지 맞춤을 골라요." },
      { title: "PDF 저장", description: "모든 이미지를 담은 PDF 한 개를 기기에 저장해요." },
    ],
  },
  compress: {
    intent: "compress",
    intentClass: "pdf-compress-scanned",
    path: "/pdf/compress",
    navLabel: "PDF 용량 줄이기",
    eyebrow: "PDF COMPRESSOR",
    title: "스캔 PDF 용량 줄이기",
    description:
      "스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로 전송되지 않습니다.",
    defaultSummary:
      "기본값은 모든 페이지를 추천 150DPI로 다시 만들고, 원본보다 1% 이상 작을 때만 새 PDF를 제공해요.",
    warning: PDF_COMPRESS_SCANNED_WARNING,
    steps: [
      { title: "PDF 선택", description: "용량을 줄일 PDF 한 개를 선택하세요." },
      {
        title: "압축 수준 선택",
        description: "균형 150DPI 또는 최소 용량 96DPI를 골라요.",
      },
      {
        title: "새 PDF 저장",
        description: "원본보다 최소 1% 작을 때만 새 PDF를 저장해요.",
      },
    ],
  },
} as const satisfies Record<PdfToolIntent, PdfToolConfig>;

export const pdfToolList: readonly PdfToolConfig[] = Object.values(pdfTools);
export const toolList = [...imageToolList, ...pdfToolList] as const;

export function relatedPdfTools(intent: PdfToolIntent): readonly PdfToolConfig[] {
  return pdfToolList.filter((tool) => tool.intent !== intent);
}

export const categoryNavigation = [
  { path: imageTools.compress.path, label: "이미지", prefix: "/image/" },
  { path: pdfTools.merge.path, label: "PDF", prefix: "/pdf/" },
] as const;
