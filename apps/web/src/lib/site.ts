export const SITE_NAME = "HereItIs";
export const SITE_URL = "https://hereisit.pages.dev";

export const HOME_TITLE = "HereItIs — 이미지 작업, 여기서 끝";
export const HOME_DESCRIPTION =
  "이미지 압축, 크기 조절, 형식 변환을 업로드 없이 내 기기에서 빠르게 처리하세요.";
export const HOME_OPEN_GRAPH_DESCRIPTION =
  "파일은 기기 밖으로 나가지 않아요. 여러 이미지를 한 번에 빠르게 처리하세요.";

export type ImageToolIntent = "compress" | "resize" | "convert";

export interface ImageToolStep {
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
  steps: readonly [ImageToolStep, ImageToolStep, ImageToolStep];
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
