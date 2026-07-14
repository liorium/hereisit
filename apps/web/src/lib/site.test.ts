import {
  type AvailableToolId,
  availableToolEntries,
  getAvailableToolById,
} from "@hereisit/tool-registry/catalog";
import { describe, expect, it } from "vitest";
import {
  imageToolList,
  imageTools,
  isPdfEditingIntent,
  pdfToolList,
  pdfTools,
  relatedImageTools,
} from "./site";
import {
  getToolImplementation,
  type ToolBundleProfile,
  type ToolImplementationConfig,
  toolImplementationConfig,
} from "./tool-implementations";

const completeToolImplementationConfig = toolImplementationConfig satisfies Record<
  AvailableToolId,
  ToolImplementationConfig
>;

describe("tool identity ownership", () => {
  it("defines implementation data for every available catalog tool", () => {
    expect(Object.keys(completeToolImplementationConfig).sort()).toEqual(
      availableToolEntries.map((tool) => tool.id).sort(),
    );

    for (const tool of availableToolEntries) {
      const limits = getToolImplementation(tool.id).sourceFileLimits;
      expect(tool.launcherInput?.minFiles ?? 0).toBe(limits.minFiles);
      expect(tool.launcherInput?.maxFiles ?? 0).toBe(limits.maxFiles);
    }
  });

  it("maps every available ID to one explicit intent and workbench profile", () => {
    const expected = {
      "image.compress": { intent: "compress", bundleProfile: "image" },
      "image.resize": { intent: "resize", bundleProfile: "image" },
      "image.convert": { intent: "convert", bundleProfile: "image" },
      "image.watermark": { intent: "watermark", bundleProfile: "image-watermark" },
      "pdf.merge": { intent: "merge", bundleProfile: "pdf-editing" },
      "pdf.split": { intent: "split", bundleProfile: "pdf-editing" },
      "pdf.organize": { intent: "organize", bundleProfile: "pdf-editing" },
      "pdf.watermark": { intent: "watermark", bundleProfile: "pdf-editing" },
      "pdf.image-to-pdf": { intent: "image-to-pdf", bundleProfile: "pdf-editing" },
      "pdf.to-image": { intent: "to-image", bundleProfile: "pdf-to-images" },
      "pdf.compress-scanned": {
        intent: "compress",
        bundleProfile: "pdf-compress-scanned",
      },
    } satisfies Record<AvailableToolId, { intent: string; bundleProfile: ToolBundleProfile }>;

    expect(
      Object.fromEntries(
        availableToolEntries.map(({ id }) => {
          const implementation = getToolImplementation(id);
          return [
            id,
            {
              intent: implementation.intent,
              bundleProfile: implementation.bundleProfile,
            },
          ];
        }),
      ),
    ).toEqual(expected);
  });

  it("derives legacy tool identity from the catalog", () => {
    expect(imageTools.compress.path).toBe(getAvailableToolById("image.compress").route);
    expect(pdfTools.merge.description).toBe(getAvailableToolById("pdf.merge").shortDescription);
  });
});

describe("image tool registry", () => {
  it("registers the image watermark route and approved defaults", () => {
    expect(imageTools.watermark).toMatchObject({
      intent: "watermark",
      path: "/image/watermark",
      navLabel: "이미지 워터마크",
      title: "이미지에 워터마크 넣기",
      description: "사진과 이미지에 문구 또는 로고를 넣으세요. 파일은 서버로 전송되지 않습니다.",
    });
    expect(imageTools.watermark.defaultSummary).toContain("© HereIsIt");
    expect(imageTools.watermark.defaultSummary).toContain("12%");
    expect(imageTools.watermark.defaultSummary).toContain("3%");
    expect(imageTools.watermark.defaultSummary).toContain("55%");
    expect(imageTools.watermark.defaultSummary).toContain("#111827");
    expect(imageTools.watermark.defaultSummary).toContain("품질 90");
  });

  it("keeps four unique image intents and paths in registry-derived related cards", () => {
    expect(imageToolList).toHaveLength(4);
    expect(new Set(imageToolList.map((tool) => tool.intent)).size).toBe(4);
    expect(new Set(imageToolList.map((tool) => tool.path)).size).toBe(4);
    expect(relatedImageTools("compress")).toContain(imageTools.watermark);
    expect(relatedImageTools("watermark")).toHaveLength(3);
  });
});

describe("PDF tool registry classification", () => {
  it("registers the scanned PDF compressor with its exact public route and copy", () => {
    expect(pdfTools.compress).toMatchObject({
      intent: "compress",
      intentClass: "pdf-compress-scanned",
      path: "/pdf/compress",
      navLabel: "PDF 용량 줄이기",
      title: "스캔 PDF 용량 줄이기",
    });
  });

  it("classifies every PDF route explicitly and isolates custom runtimes from editing", () => {
    expect(pdfToolList.filter((tool) => tool.intentClass === "pdf-compress-scanned")).toEqual([
      pdfTools.compress,
    ]);
    expect(isPdfEditingIntent("compress")).toBe(false);
    expect(isPdfEditingIntent("to-image")).toBe(false);
    expect(isPdfEditingIntent("merge")).toBe(true);
  });
});
