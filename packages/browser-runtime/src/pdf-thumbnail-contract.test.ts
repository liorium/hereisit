import {
  PDF_THUMBNAIL_TOOL_ID,
  PDF_THUMBNAIL_TOOL_VERSION,
  type PdfThumbnailWorkerEvent,
} from "@hereisit/tool-contracts";
import { describe, expect, it } from "vitest";

describe("PDF thumbnail contract", () => {
  it("keeps thumbnail payloads free of file identity and URLs", () => {
    const event = {
      protocol: 1,
      type: "thumbnail",
      jobId: "job-1",
      sequence: 0,
      update: {
        status: "ready",
        sourcePage: 1,
        width: 124,
        height: 160,
        mime: "image/webp",
        bytes: new ArrayBuffer(12),
      },
    } satisfies PdfThumbnailWorkerEvent;

    expect(PDF_THUMBNAIL_TOOL_ID).toBe("pdf.thumbnail");
    expect(PDF_THUMBNAIL_TOOL_VERSION).toBe(1);
    expect(event.update).not.toHaveProperty("name");
    expect(event.update).not.toHaveProperty("url");
  });
});
