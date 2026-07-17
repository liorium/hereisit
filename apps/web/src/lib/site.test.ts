import { describe, expect, it } from "vitest";
import {
  imageToolList,
  imageTools,
  isPdfEditingIntent,
  pdfToolList,
  pdfTools,
  relatedImageTools,
} from "./site";

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

  it("describes processing location and retention per image tool", () => {
    expect(imageTools.compress.description).toContain("HereIsIt 처리 서버");
    expect(imageTools.compress.description).toContain("자동 삭제");
    expect(imageTools.resize.description).toContain("업로드 없이");
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
