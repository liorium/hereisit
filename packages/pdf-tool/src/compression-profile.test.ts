import { describe, expect, it } from "vitest";
import {
  classifyPdfCompressionDocument,
  type PdfCompressionPageSignals,
} from "./compression-profile";

const imageOnlyPage: PdfCompressionPageSignals = {
  nonWhitespaceTextItems: 0,
  annotationCount: 0,
  imagePaintOperations: 1,
  nonImagePaintOperations: 0,
};

describe("classifyPdfCompressionDocument", () => {
  it("allows rasterization only when every page is image-only", () => {
    expect(classifyPdfCompressionDocument([imageOnlyPage, imageOnlyPage])).toBe("image-only");
  });

  it.each([
    ["an empty document", []],
    ["visible text", [{ ...imageOnlyPage, nonWhitespaceTextItems: 1 }]],
    ["an annotation", [{ ...imageOnlyPage, annotationCount: 1 }]],
    ["no painted image", [{ ...imageOnlyPage, imagePaintOperations: 0 }]],
    ["a non-image paint operation", [{ ...imageOnlyPage, nonImagePaintOperations: 1 }]],
    ["one structured page in a mixed document", [imageOnlyPage, { ...imageOnlyPage, nonWhitespaceTextItems: 1 }]],
  ] as const)("preserves structure for %s", (_label, pages) => {
    expect(classifyPdfCompressionDocument(pages)).toBe("structured");
  });
});
