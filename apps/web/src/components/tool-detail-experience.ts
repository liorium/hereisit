import type { Experience } from "@hereisit/tool-registry/catalog";

const workAreaPresentation = Object.freeze({
  quick: { label: "빠른 작업 영역", style: "quick" },
  file: { label: "파일 작업 영역", style: "file" },
  workspace: { label: "편집 작업 공간", style: "workspace" },
} as const satisfies Record<Experience, { label: string; style: string }>);

export function getToolWorkAreaPresentation(experience: Experience) {
  return workAreaPresentation[experience];
}
