import type { FileKind } from "@hereisit/tool-registry/catalog";
import {
  groupDetectedKinds,
  recommendAvailableTools,
  type ToolRecommendation,
} from "@hereisit/tool-registry/discovery";
import type { FileDetectionItem } from "./file-selection-detection";

export interface DetectedFileItem {
  file: File;
  detectedKind: FileKind;
}

export interface FileRecommendationGroup {
  kind: FileKind | "mixed";
  items: readonly DetectedFileItem[];
  recommendations: readonly ToolRecommendation[];
}

export type FileRecommendationPlan =
  | { state: "unsupported"; unknownCount: number; groups: readonly [] }
  | {
      state: "complete";
      unknownCount: number;
      groups: readonly [FileRecommendationGroup];
    }
  | {
      state: "grouped";
      unknownCount: number;
      groups: readonly FileRecommendationGroup[];
    };

interface IndexedDetectedFileItem {
  index: number;
  item: DetectedFileItem;
}

function createGroup(
  kind: FileRecommendationGroup["kind"],
  items: readonly DetectedFileItem[],
  recommendations: readonly ToolRecommendation[],
): FileRecommendationGroup {
  return Object.freeze({
    kind,
    items: Object.freeze([...items]),
    recommendations,
  });
}

export function planFileRecommendations(
  items: readonly FileDetectionItem[],
): FileRecommendationPlan {
  const knownItems: IndexedDetectedFileItem[] = [];
  let unknownCount = 0;

  for (const [index, item] of items.entries()) {
    if (item.detectedKind === null) {
      unknownCount += 1;
    } else {
      knownItems.push({
        index,
        item: { file: item.file, detectedKind: item.detectedKind },
      });
    }
  }

  const detectedKinds = knownItems.map(({ index, item }) => ({
    index,
    kind: item.detectedKind,
  }));

  if (unknownCount === 0) {
    const recommendations = recommendAvailableTools(detectedKinds);
    if (recommendations.length > 0) {
      const completeItems = knownItems.map(({ item }) => item);
      const firstKind = completeItems[0]?.detectedKind;
      const kind = completeItems.every(({ detectedKind }) => detectedKind === firstKind)
        ? (firstKind ?? "mixed")
        : "mixed";
      const group = createGroup(kind, completeItems, recommendations);
      return {
        state: "complete",
        unknownCount,
        groups: Object.freeze([group] as const),
      };
    }
  }

  const knownItemsByIndex = new Map(knownItems.map(({ index, item }) => [index, item]));
  const groups = groupDetectedKinds(detectedKinds).flatMap((detectedGroup) => {
    const recommendations = recommendAvailableTools(
      detectedGroup.indexes.map((index) => ({ index, kind: detectedGroup.kind })),
    );
    if (recommendations.length === 0) return [];

    const groupItems = detectedGroup.indexes.flatMap((index) => {
      const item = knownItemsByIndex.get(index);
      return item === undefined ? [] : [item];
    });
    return [createGroup(detectedGroup.kind, groupItems, recommendations)];
  });

  if (groups.length === 0) {
    return { state: "unsupported", unknownCount, groups: Object.freeze([]) };
  }
  return { state: "grouped", unknownCount, groups: Object.freeze(groups) };
}
