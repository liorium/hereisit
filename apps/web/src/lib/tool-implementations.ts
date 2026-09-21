import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { JSON_FORMAT_LIMITS } from "./json-format.ts";

export type ToolBundleProfile =
  | "json-quick"
  | "image"
  | "image-compression-server"
  | "image-extra"
  | "image-watermark";

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
    defaultSummary: "밝기·대비·채도·필터·프레임·스티커와 문구를 조절해 사진을 편집해요.",
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
    defaultSummary: "얼굴·번호판·이름을 자동으로 찾거나 가릴 영역을 드래그해 흐리게 처리해요.",
    notices: [
      {
        tone: "support",
        text: "지원 브라우저에서는 얼굴 자동 감지를 먼저 시도하고, 필요하면 사각형을 직접 지정할 수 있어요.",
      },
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
} as const satisfies Record<AvailableToolId, ToolImplementationConfig>);

export function getToolImplementation<const Id extends AvailableToolId>(
  id: Id,
): (typeof toolImplementationConfig)[Id] {
  const implementation = toolImplementationConfig[id];
  if (implementation === undefined) throw new Error(`Missing tool implementation: ${id}`);
  return implementation;
}
