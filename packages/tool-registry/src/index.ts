import type { ImagePipelineSpecV1, ToolPreset } from "@hereisit/tool-contracts";

const base: Pick<ImagePipelineSpecV1, "version" | "autoOrient" | "metadata"> = {
  version: 1,
  autoOrient: true,
  metadata: "strip",
};

const defaultImagePreset: ToolPreset = {
  id: "web-1920",
  name: "웹용 이미지",
  description: "긴 변을 최대 1920px로 줄여 웹에서 빠르게 열려요.",
  badge: "추천",
  spec: {
    ...base,
    resize: { kind: "inside", maxWidth: 1920, maxHeight: 1920 },
    output: { format: "webp", compression: { mode: "quality", quality: 84 } },
  },
};

export const imagePresets: readonly ToolPreset[] = [
  {
    id: "balanced",
    name: "용량만 줄이기",
    description: "크기는 유지하고 선명도와 용량의 균형을 맞춰요.",
    badge: "빠름",
    spec: {
      ...base,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
    },
  },
  defaultImagePreset,
  {
    id: "product-square",
    name: "상품 정사각형",
    description: "가운데를 기준으로 1000×1000px 정사각형을 만들어요.",
    badge: "판매자",
    spec: {
      ...base,
      resize: { kind: "cover", width: 1000, height: 1000 },
      output: {
        format: "jpeg",
        compression: { mode: "quality", quality: 85 },
        matte: "#ffffff",
      },
    },
  },
  {
    id: "social-square",
    name: "SNS 정사각형",
    description: "피드에 쓰기 좋은 1080×1080px 이미지로 잘라요.",
    badge: "콘텐츠",
    spec: {
      ...base,
      resize: { kind: "cover", width: 1080, height: 1080 },
      output: {
        format: "jpeg",
        compression: { mode: "quality", quality: 86 },
        matte: "#ffffff",
      },
    },
  },
];

export function findImagePreset(id: string): ToolPreset {
  return imagePresets.find((preset) => preset.id === id) ?? defaultImagePreset;
}
