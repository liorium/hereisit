import { describe, expect, it } from "vitest";
import { isPdfEditingIntent, pdfToolList, pdfTools } from "./site";

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
