import { describe, expect, it } from "vitest";
import {
  extractedPdfName,
  imagesPdfName,
  mergedPdfName,
  organizedPdfName,
  pdfToImagePageName,
  pdfToImagesArchiveName,
  splitPdfArchiveName,
  splitPdfPageName,
  watermarkedPdfName,
} from "./naming";

describe("PDF output naming", () => {
  it("creates stable names without leaking paths", () => {
    expect(mergedPdfName()).toBe("merged-hereisit.pdf");
    expect(imagesPdfName()).toBe("images-hereisit.pdf");
    expect(splitPdfArchiveName("../report.pdf")).toBe("report-pages-hereisit.zip");
    expect(splitPdfPageName("folder/report.pdf", 2, 12)).toBe("report-page-002.pdf");
    expect(extractedPdfName("report.pdf")).toBe("report-selected-hereisit.pdf");
    expect(organizedPdfName("../report.pdf")).toBe("report-organized-hereisit.pdf");
    expect(watermarkedPdfName("../report.pdf")).toBe("report-watermarked-hereisit.pdf");
  });

  it("creates source-relative PDF-to-image page and archive names", () => {
    expect(pdfToImagePageName("../report.pdf", 1, "jpeg")).toBe("report-page-001.jpg");
    expect(pdfToImagePageName("folder/report.pdf", 500, "png")).toBe("report-page-500.png");
    expect(pdfToImagesArchiveName("../report.pdf")).toBe("report-images-hereisit.zip");
  });

  it("sanitizes reserved and control characters for PDF-to-image names", () => {
    expect(pdfToImagePageName('\u0000bad<>:"|?*.pdf', 4, "png")).toBe("bad--------page-004.png");
  });

  it("removes bidi formatting controls from PDF-to-image names", () => {
    expect(pdfToImagePageName("safe\u202egpj\u2066.pdf", 1, "jpeg")).toBe("safegpj-page-001.jpg");
  });

  it("uses the document fallback for an empty sanitized PDF stem", () => {
    expect(pdfToImagePageName("folder/\u0000.pdf", 2, "jpeg")).toBe("document-page-002.jpg");
    expect(pdfToImagesArchiveName("folder/\u0000.pdf")).toBe("document-images-hereisit.zip");
  });
});
