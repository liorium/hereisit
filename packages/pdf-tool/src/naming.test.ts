import { describe, expect, it } from "vitest";
import {
  extractedPdfName,
  imagesPdfName,
  mergedPdfName,
  splitPdfArchiveName,
  splitPdfPageName,
} from "./naming";

describe("PDF output naming", () => {
  it("creates stable names without leaking paths", () => {
    expect(mergedPdfName()).toBe("merged-hereisit.pdf");
    expect(imagesPdfName()).toBe("images-hereisit.pdf");
    expect(splitPdfArchiveName("../report.pdf")).toBe("report-pages-hereisit.zip");
    expect(splitPdfPageName("folder/report.pdf", 2, 12)).toBe("report-page-002.pdf");
    expect(extractedPdfName("report.pdf")).toBe("report-selected-hereisit.pdf");
  });
});
