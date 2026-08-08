import {
  decodePDFRawStream,
  degrees,
  PDFContext,
  PDFDocument,
  PDFObjectParser,
  PDFObjectStreamParser,
  PDFPage,
  PDFRawStream,
  PDFXRefStreamParser,
} from "@cantoo/pdf-lib";
import { hasPdfSignature } from "@hereisit/pdf-tool";
import { unzipSync, zlibSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { inspectPdfInput, runPdfFilePipeline, runPdfPipeline } from "./pdf-pipeline";

const onePixelPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

const landscapeJpeg = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAKABQDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnRDGqYAAAAD/2Q==",
  ),
  (character) => character.charCodeAt(0),
);

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function withExifOrientation(jpeg: Uint8Array, orientation: number): ArrayBuffer {
  const privateMetadata = new TextEncoder().encode("GPS_PRIVATE_SENTINEL");
  const payload = new Uint8Array(32 + privateMetadata.byteLength);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1]);
  payload.set([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0], 16);
  payload.set(privateMetadata, 32);
  const segment = new Uint8Array(payload.byteLength + 4);
  segment.set([0xff, 0xe1, 0, payload.byteLength + 2]);
  segment.set(payload, 4);
  const bytes = new Uint8Array(jpeg.byteLength + segment.byteLength + 1);
  bytes.set(jpeg.subarray(0, 2));
  bytes[2] = 0xff;
  bytes.set(segment, 3);
  bytes.set(jpeg.subarray(2), 3 + segment.byteLength);
  return bytes.buffer;
}

function oversizedPng(): ArrayBuffer {
  const bytes = Uint8Array.from(onePixelPng);
  writeUint32BE(bytes, 16, 4_001);
  writeUint32BE(bytes, 20, 4_001);
  return bytes.buffer;
}

function memoryHeavyPng(): ArrayBuffer {
  const bytes = Uint8Array.from(onePixelPng);
  writeUint32BE(bytes, 16, 3_000);
  writeUint32BE(bytes, 20, 3_000);
  bytes[24] = 16;
  bytes[25] = 6;
  return bytes.buffer;
}

function animatedPng(): ArrayBuffer {
  const chunk = new Uint8Array(20);
  writeUint32BE(chunk, 0, 8);
  chunk.set(new TextEncoder().encode("acTL"), 4);
  const bytes = new Uint8Array(onePixelPng.byteLength + chunk.byteLength);
  bytes.set(onePixelPng.subarray(0, 33));
  bytes.set(chunk, 33);
  bytes.set(onePixelPng.subarray(33), 33 + chunk.byteLength);
  return bytes.buffer;
}

function pngWithPrivateMetadata(): ArrayBuffer {
  const metadata = new TextEncoder().encode("GPS_PRIVATE_SENTINEL");
  const chunk = new Uint8Array(metadata.byteLength + 12);
  writeUint32BE(chunk, 0, metadata.byteLength);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(metadata, 8);
  const bytes = new Uint8Array(onePixelPng.byteLength + chunk.byteLength);
  bytes.set(onePixelPng.subarray(0, 33));
  bytes.set(chunk, 33);
  bytes.set(onePixelPng.subarray(33), 33 + chunk.byteLength);
  return bytes.buffer;
}

function objectStreamBombPdf(decodedByteLength: number): ArrayBuffer {
  const decoded = new Uint8Array(decodedByteLength);
  decoded.fill(0x20);
  decoded.set(new TextEncoder().encode("5 0 null"));
  const compressed = zlibSync(decoded, { level: 9 });
  const prefix = new TextEncoder().encode(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressed.byteLength} >>\nstream\n`,
  );
  const suffix = new TextEncoder().encode(
    "\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF",
  );
  const bytes = new Uint8Array(prefix.byteLength + compressed.byteLength + suffix.byteLength);
  bytes.set(prefix);
  bytes.set(compressed, prefix.byteLength);
  bytes.set(suffix, prefix.byteLength + compressed.byteLength);
  return bytes.buffer;
}

function traditionalXrefPdf(entryCounts: readonly number[]): ArrayBuffer {
  const objects =
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n";
  const sections = entryCounts
    .map(
      (entryCount) =>
        `xref\n0 ${entryCount}\n${"0000000000 65535 f \n".repeat(entryCount)}` +
        `trailer\n<< /Root 1 0 R /Size ${entryCount} >>\nstartxref\n0\n%%EOF\n`,
    )
    .join("");
  return new TextEncoder().encode(objects + sections).buffer;
}

function fragmentedTraditionalXrefPdf(subsectionCount: number): ArrayBuffer {
  const objects =
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n";
  let xref = "xref\n";
  for (let index = 0; index < subsectionCount; index += 1) {
    xref += `${index * 2 + 10} 1\n0000000000 65535 f \n`;
  }
  const trailer = `trailer\n<< /Root 1 0 R /Size ${subsectionCount * 2 + 10} >>\n%%EOF`;
  return new TextEncoder().encode(objects + xref + trailer).buffer;
}

function flatPageTreePdf(pageCount: number): ArrayBuffer {
  const kids = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  let source =
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`;
  for (let index = 0; index < pageCount; index += 1) {
    source += `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n`;
  }
  source += `trailer\n<< /Root 1 0 R /Size ${pageCount + 3} >>\n%%EOF`;
  return new TextEncoder().encode(source).buffer;
}

function duplicatePageTreePdf(depth: number): ArrayBuffer {
  let source = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const leafRef = depth + 2;
  for (let index = 0; index < depth; index += 1) {
    const ref = index + 2;
    const childRef = index === depth - 1 ? leafRef : ref + 1;
    source += `${ref} 0 obj\n<< /Type /Pages /Kids [${childRef} 0 R ${childRef} 0 R] /Count 1 >>\nendobj\n`;
  }
  source += `${leafRef} 0 obj\n<< /Type /Page /Parent ${leafRef - 1} 0 R /MediaBox [0 0 100 100] >>\nendobj\n`;
  source += `trailer\n<< /Root 1 0 R /Size ${leafRef + 1} >>\n%%EOF`;
  return new TextEncoder().encode(source).buffer;
}

async function samplePdf(widths: readonly number[]): Promise<ArrayBuffer> {
  const document = await PDFDocument.create();
  for (const width of widths) document.addPage([width, 100]);
  const bytes = await document.save();
  return Uint8Array.from(bytes).buffer;
}

function input(name: string, bytes: ArrayBuffer, mimeHint = "application/pdf") {
  return { name, mimeHint, byteLength: bytes.byteLength, bytes };
}

function fileInput(name: string, bytes: ArrayBuffer, readBytes: () => Promise<ArrayBuffer>) {
  return { name, mimeHint: "application/pdf", byteLength: bytes.byteLength, readBytes };
}

describe("runPdfPipeline", () => {
  it("merges PDF pages in file order", async () => {
    const first = await samplePdf([100, 200]);
    const second = await samplePdf([300]);
    const result = await runPdfPipeline([input("first.pdf", first), input("second.pdf", second)], {
      version: 1,
      operation: "merge",
    });

    expect(result.mime).toBe("application/pdf");
    expect(result.sourcePageCount).toBe(3);
    expect(hasPdfSignature(result.bytes)).toBe(true);
    const merged = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(merged.getPages().map((page) => page.getWidth())).toEqual([100, 200, 300]);
    expect(merged.getCreator()).toBe("HereIsIt");
    expect(merged.getProducer()).toBe("HereIsIt");
  });

  it("reads the next PDF file only after copying the current source", async () => {
    const first = await samplePdf([100]);
    const second = await samplePdf([200]);
    const originalCopyPages = PDFDocument.prototype.copyPages;
    let firstCopied = false;
    const copyPages = vi
      .spyOn(PDFDocument.prototype, "copyPages")
      .mockImplementation(async function (source, indices) {
        const pages = await originalCopyPages.call(this, source, indices);
        firstCopied = true;
        return pages;
      });

    try {
      const result = await runPdfFilePipeline(
        [
          fileInput("first.pdf", first, async () => first),
          fileInput("second.pdf", second, async () => {
            expect(firstCopied).toBe(true);
            return second;
          }),
        ],
        { version: 1, operation: "merge" },
      );

      const merged = await PDFDocument.load(result.bytes, { updateMetadata: false });
      expect(merged.getPages().map((page) => page.getWidth())).toEqual([100, 200]);
      expect(copyPages).toHaveBeenCalledTimes(2);
    } finally {
      copyPages.mockRestore();
    }
  });

  it("splits every page into a zero-compression ZIP", async () => {
    const source = await samplePdf([100, 200, 300]);
    const result = await runPdfPipeline([input("report.pdf", source)], {
      version: 1,
      operation: "split",
      selection: { mode: "every-page" },
    });

    expect(result.mime).toBe("application/zip");
    expect(result.outputDocumentCount).toBe(3);
    const entries = unzipSync(new Uint8Array(result.bytes));
    expect(Object.keys(entries)).toEqual([
      "report-page-001.pdf",
      "report-page-002.pdf",
      "report-page-003.pdf",
    ]);
    const secondPage = entries["report-page-002.pdf"];
    expect(secondPage).toBeDefined();
    const document = await PDFDocument.load(secondPage as Uint8Array);
    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getWidth()).toBe(200);
  });

  it("reads and splits a PDF through the file pipeline", async () => {
    const source = await samplePdf([100, 200]);
    const result = await runPdfFilePipeline(
      [fileInput("report.pdf", source, async () => source)],
      {
        version: 1,
        operation: "split",
        selection: { mode: "every-page" },
      },
    );

    const entries = unzipSync(new Uint8Array(result.bytes));
    expect(Object.keys(entries)).toEqual(["report-page-001.pdf", "report-page-002.pdf"]);
    const secondPage = await PDFDocument.load(entries["report-page-002.pdf"] as Uint8Array);
    expect(secondPage.getPageCount()).toBe(1);
    expect(secondPage.getPage(0).getWidth()).toBe(200);
  });

  it("rejects a file read whose byte length differs from its metadata", async () => {
    const first = await samplePdf([100]);
    const second = await samplePdf([200]);

    await expect(
      runPdfFilePipeline(
        [
          {
            name: "first.pdf",
            mimeHint: "application/pdf",
            byteLength: first.byteLength + 1,
            readBytes: async () => first,
          },
          fileInput("second.pdf", second, async () => second),
        ],
        { version: 1, operation: "merge" },
      ),
    ).rejects.toMatchObject({
      payload: {
        code: "CORRUPT_PDF",
        message: "선택한 파일을 읽지 못했어요.",
        retryable: true,
      },
    });
  });

  it("extracts selected pages into one PDF", async () => {
    const source = await samplePdf([100, 200, 300]);
    const result = await runPdfPipeline([input("report.pdf", source)], {
      version: 1,
      operation: "split",
      selection: { mode: "extract", pages: [1, 3] },
    });

    const document = await PDFDocument.load(result.bytes);
    expect(document.getPages().map((page) => page.getWidth())).toEqual([100, 300]);
    expect(result.suggestedName).toBe("report-selected-hereisit.pdf");
  });

  it("inspects page geometry without returning file data", async () => {
    const source = await samplePdf([100, 200, 300]);
    const inspected = await inspectPdfInput(input("private-name.pdf", source));

    expect(inspected).toEqual({
      pageCount: 3,
      pages: [
        { sourcePage: 1, width: 100, height: 100, rotation: 0 },
        { sourcePage: 2, width: 200, height: 100, rotation: 0 },
        { sourcePage: 3, width: 300, height: 100, rotation: 0 },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain("private-name");
  });

  it("reorders, rotates, and removes pages from one PDF", async () => {
    const sourceDocument = await PDFDocument.create();
    sourceDocument.addPage([100, 100]);
    sourceDocument.addPage([200, 100]);
    sourceDocument.addPage([300, 100]).setRotation(degrees(90));
    const source = Uint8Array.from(await sourceDocument.save()).buffer;

    const result = await runPdfPipeline([input("report.pdf", source)], {
      version: 1,
      operation: "organize",
      pages: [
        { sourcePage: 3, rotateBy: 90 },
        { sourcePage: 1, rotateBy: 270 },
      ],
    });

    const organized = await PDFDocument.load(result.bytes);
    expect(organized.getPages().map((page) => page.getWidth())).toEqual([300, 100]);
    expect(organized.getPages().map((page) => page.getRotation().angle)).toEqual([180, 270]);
    expect(result.outputPageCount).toBe(2);
    expect(result.suggestedName).toBe("report-organized-hereisit.pdf");
  });

  it("rejects an organizer page beyond the source document", async () => {
    const source = await samplePdf([100]);
    await expect(
      runPdfPipeline([input("report.pdf", source)], {
        version: 1,
        operation: "organize",
        pages: [{ sourcePage: 2, rotateBy: 0 }],
      }),
    ).rejects.toMatchObject({ payload: { code: "PAGE_RANGE_INVALID" } });
  });

  it("adds a rasterized watermark only to selected pages", async () => {
    const source = await samplePdf([100, 200]);
    const result = await runPdfPipeline(
      [input("report.pdf", source)],
      {
        version: 1,
        operation: "watermark",
        watermark: {
          text: "대외비",
          placement: "center",
          fontSize: 48,
          opacity: 0.18,
          rotation: -45,
          color: "#334155",
        },
        selection: { mode: "extract", pages: [2] },
      },
      {
        renderWatermark: async () => ({
          bytes: Uint8Array.from(onePixelPng).buffer,
          width: 1,
          height: 1,
        }),
      },
    );

    const watermarked = await PDFDocument.load(result.bytes);
    expect(watermarked.getPage(0).node.Contents()).toBeUndefined();
    expect(watermarked.getPage(1).node.Contents()).toBeDefined();
    expect(result.outputPageCount).toBe(2);
    expect(result.suggestedName).toBe("report-watermarked-hereisit.pdf");
    expect(result.warnings).toContain("WATERMARK_TEXT_RASTERIZED");
  });

  it("watermarks the loaded document without copying every page", async () => {
    const sourceDocument = await PDFDocument.create();
    sourceDocument.setTitle("Quarterly report");
    sourceDocument.addPage([100, 100]);
    sourceDocument.addPage([100, 100]);
    const source = Uint8Array.from(await sourceDocument.save()).buffer;
    const copyPages = vi.spyOn(PDFDocument.prototype, "copyPages");

    try {
      const result = await runPdfPipeline(
        [input("report.pdf", source)],
        {
          version: 1,
          operation: "watermark",
          watermark: {
            text: "대외비",
            placement: "center",
            fontSize: 48,
            opacity: 0.18,
            rotation: -45,
            color: "#334155",
          },
          selection: { mode: "extract", pages: [2] },
        },
        {
          renderWatermark: async () => ({
            bytes: Uint8Array.from(onePixelPng).buffer,
            width: 1,
            height: 1,
          }),
        },
      );

      const watermarked = await PDFDocument.load(result.bytes);
      expect(copyPages).not.toHaveBeenCalled();
      expect(watermarked.getTitle()).toBe("Quarterly report");
      expect(watermarked.getPageCount()).toBe(2);
      expect(watermarked.getPage(0).node.Contents()).toBeUndefined();
      expect(watermarked.getPage(1).node.Contents()).toBeDefined();
    } finally {
      copyPages.mockRestore();
    }
  });

  it("maps a watermark page above the source count to PAGE_RANGE_INVALID", async () => {
    const source = await samplePdf([100]);

    await expect(
      runPdfPipeline([input("report.pdf", source)], {
        version: 1,
        operation: "watermark",
        watermark: {
          text: "대외비",
          placement: "center",
          fontSize: 48,
          opacity: 0.18,
          rotation: -45,
          color: "#334155",
        },
        selection: { mode: "extract", pages: [2] },
      }),
    ).rejects.toMatchObject({
      payload: {
        code: "PAGE_RANGE_INVALID",
        message: "이 PDF는 1페이지까지 있어요.",
        retryable: false,
      },
    });
  });

  it("positions a watermark inside a non-zero crop box", async () => {
    const sourceDocument = await PDFDocument.create();
    const sourcePage = sourceDocument.addPage([400, 500]);
    sourcePage.setCropBox(50, 100, 200, 300);
    const source = Uint8Array.from(await sourceDocument.save()).buffer;
    const drawImage = vi.spyOn(PDFPage.prototype, "drawImage");

    try {
      await runPdfPipeline(
        [input("print.pdf", source)],
        {
          version: 1,
          operation: "watermark",
          watermark: {
            text: "PRINT",
            placement: "center",
            fontSize: 48,
            opacity: 0.18,
            rotation: 0,
            color: "#334155",
          },
          selection: { mode: "every-page" },
        },
        {
          renderWatermark: async () => ({
            bytes: Uint8Array.from(onePixelPng).buffer,
            width: 1,
            height: 1,
          }),
        },
      );

      expect(drawImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ x: 126, y: 226, width: 48, height: 48 }),
      );
    } finally {
      drawImage.mockRestore();
    }
  });

  it("keeps the requested visual watermark angle on a rotated page", async () => {
    const sourceDocument = await PDFDocument.create();
    sourceDocument.addPage([400, 500]).setRotation(degrees(90));
    const source = Uint8Array.from(await sourceDocument.save()).buffer;
    const drawImage = vi.spyOn(PDFPage.prototype, "drawImage");

    try {
      await runPdfPipeline(
        [input("rotated.pdf", source)],
        {
          version: 1,
          operation: "watermark",
          watermark: {
            text: "ROTATED",
            placement: "center",
            fontSize: 48,
            opacity: 0.18,
            rotation: -45,
            color: "#334155",
          },
          selection: { mode: "every-page" },
        },
        {
          renderWatermark: async () => ({
            bytes: Uint8Array.from(onePixelPng).buffer,
            width: 1,
            height: 1,
          }),
        },
      );

      expect(drawImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rotate: expect.objectContaining({ angle: -135 }) }),
      );
    } finally {
      drawImage.mockRestore();
    }
  });

  it("puts each PNG on its own PDF page", async () => {
    const bytes = Uint8Array.from(onePixelPng).buffer;
    const result = await runPdfPipeline(
      [
        input("one.png", bytes, "image/png"),
        input("two.png", pngWithPrivateMetadata(), "image/png"),
      ],
      {
        version: 1,
        operation: "images-to-pdf",
        page: { size: "a4", margin: 24 },
      },
    );

    expect(result.sourcePageCount).toBe(2);
    expect(result.warnings).toContain("IMAGE_COLOR_MAY_CHANGE");
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBe(2);
    expect(new TextDecoder().decode(result.bytes)).not.toContain("GPS_PRIVATE_SENTINEL");
  });

  it("preserves a phone JPEG's EXIF quarter-turn without re-encoding it", async () => {
    const bytes = withExifOrientation(landscapeJpeg, 6);
    const result = await runPdfPipeline([input("phone.jpg", bytes, "image/jpeg")], {
      version: 1,
      operation: "images-to-pdf",
      page: { size: "image", margin: 0 },
    });

    const document = await PDFDocument.load(result.bytes);
    const page = document.getPage(0);
    expect(page.getWidth()).toBeCloseTo(7.5);
    expect(page.getHeight()).toBeCloseTo(15);
    expect(result.warnings).toContain("IMAGE_COLOR_MAY_CHANGE");
    expect(new TextDecoder().decode(result.bytes)).not.toContain("GPS_PRIVATE_SENTINEL");
  });

  it("rejects oversized and animated PNGs before decoding", async () => {
    await expect(
      runPdfPipeline([input("huge.png", oversizedPng(), "image/png")], {
        version: 1,
        operation: "images-to-pdf",
        page: { size: "a4", margin: 24 },
      }),
    ).rejects.toMatchObject({ payload: { code: "MEMORY_LIMIT" } });

    await expect(
      runPdfPipeline([input("deep.png", memoryHeavyPng(), "image/png")], {
        version: 1,
        operation: "images-to-pdf",
        page: { size: "a4", margin: 24 },
      }),
    ).rejects.toMatchObject({ payload: { code: "MEMORY_LIMIT" } });

    await expect(
      runPdfPipeline([input("animated.png", animatedPng(), "image/png")], {
        version: 1,
        operation: "images-to-pdf",
        page: { size: "a4", margin: 24 },
      }),
    ).rejects.toMatchObject({ payload: { code: "UNSUPPORTED_INPUT" } });
  });

  it("caps object and cross-reference entry counts before allocation", () => {
    const objectContext = PDFContext.create();
    const objectStream = PDFRawStream.of(
      objectContext.obj({ Type: "ObjStm", First: 0, N: 50_001 }),
      new Uint8Array(),
    );
    expect(() => PDFObjectStreamParser.forStream(objectStream)).toThrow("PDF_STREAM_SAFETY_LIMIT");

    const xrefContext = PDFContext.create();
    const xrefStream = PDFRawStream.of(
      xrefContext.obj({ Type: "XRef", Size: 100_001, W: [0, 0, 0] }),
      new Uint8Array(),
    );
    expect(() => PDFXRefStreamParser.forStream(xrefStream)).toThrow("PDF_STREAM_SAFETY_LIMIT");
  });

  it("caps filter depth and validates each cross-reference stream without revision false positives", () => {
    const filterContext = PDFContext.create();
    const filteredStream = PDFRawStream.of(
      filterContext.obj({ Filter: Array.from({ length: 9 }, () => "FlateDecode") }),
      new Uint8Array(),
    );
    expect(() => decodePDFRawStream(filteredStream)).toThrow("PDF_STREAM_SAFETY_LIMIT");

    const xrefContext = PDFContext.create();
    const makeXrefParser = () =>
      PDFXRefStreamParser.forStream(
        PDFRawStream.of(
          xrefContext.obj({ Type: "XRef", Size: 60_000, W: [0, 0, 0] }),
          new Uint8Array(),
        ),
      );
    expect(makeXrefParser().parseIntoContext(false)).toEqual([]);
    expect(makeXrefParser().parseIntoContext(false)).toEqual([]);

    const truncated = PDFRawStream.of(
      PDFContext.create().obj({ Type: "XRef", Size: 2, W: [1, 1, 1] }),
      new Uint8Array(5),
    );
    expect(() => PDFXRefStreamParser.forStream(truncated)).toThrow("PDF_STREAM_SAFETY_LIMIT");
  });

  it("accepts repeated normal xref revisions within the document budget", async () => {
    const source = traditionalXrefPdf([70_000, 70_000, 70_000]);
    const document = await PDFDocument.load(source);
    expect(document.getPageCount()).toBe(1);
  });

  it("caps fragmented traditional xref subsections without an off-by-one", async () => {
    await expect(PDFDocument.load(fragmentedTraditionalXrefPdf(2_048))).resolves.toBeDefined();
    await expect(PDFDocument.load(fragmentedTraditionalXrefPdf(2_049))).rejects.toThrow(
      "PDF_STREAM_SAFETY_LIMIT",
    );
  });

  it("bounds direct object containers, nesting, and numeric tokens without logging file data", () => {
    const wideArray = new TextEncoder().encode(`[${"0 ".repeat(100_001)}]`);
    expect(() => PDFObjectParser.forBytes(wideArray, PDFContext.create()).parseObject()).toThrow(
      "PDF_STREAM_SAFETY_LIMIT",
    );

    const acceptedDepth = new TextEncoder().encode(`${"[".repeat(127)}0${"]".repeat(127)}`);
    expect(() =>
      PDFObjectParser.forBytes(acceptedDepth, PDFContext.create()).parseObject(),
    ).not.toThrow();
    const rejectedDepth = new TextEncoder().encode(`${"[".repeat(128)}0${"]".repeat(128)}`);
    expect(() =>
      PDFObjectParser.forBytes(rejectedDepth, PDFContext.create()).parseObject(),
    ).toThrow("PDF_STREAM_SAFETY_LIMIT");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() =>
      PDFObjectParser.forBytes(
        new TextEncoder().encode("9007199254740992"),
        PDFContext.create(),
      ).parseObject(),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(() =>
      PDFObjectParser.forBytes(
        new TextEncoder().encode("1".repeat(129)),
        PDFContext.create(),
      ).parseObject(),
    ).toThrow("PDF_STREAM_SAFETY_LIMIT");
  });

  it("rejects duplicate page-tree DAGs before page arrays can expand", async () => {
    await expect(
      runPdfPipeline([input("dag.pdf", duplicatePageTreePdf(20))], {
        version: 1,
        operation: "split",
        selection: { mode: "every-page" },
      }),
    ).rejects.toMatchObject({ payload: { code: "MEMORY_LIMIT" } });
  });

  it("accepts 500 pages and maps the 501st page to PAGE_LIMIT", async () => {
    const allowed = await PDFDocument.load(flatPageTreePdf(500));
    expect(allowed.getPageCount()).toBe(500);
    await expect(
      runPdfPipeline([input("too-many.pdf", flatPageTreePdf(501))], {
        version: 1,
        operation: "split",
        selection: { mode: "extract", pages: [1] },
      }),
    ).rejects.toMatchObject({ payload: { code: "PAGE_LIMIT" } });
  });

  it("stops a highly compressed PDF object stream at the decoded-byte limit", async () => {
    const source = objectStreamBombPdf(33 * 1024 * 1024);
    expect(source.byteLength).toBeLessThan(100_000);
    await expect(
      runPdfPipeline([input("compressed.pdf", source)], {
        version: 1,
        operation: "split",
        selection: { mode: "every-page" },
      }),
    ).rejects.toMatchObject({ payload: { code: "MEMORY_LIMIT" } });
  });

  it("rejects a selected page outside the document", async () => {
    const source = await samplePdf([100]);
    await expect(
      runPdfPipeline([input("report.pdf", source)], {
        version: 1,
        operation: "split",
        selection: { mode: "extract", pages: [2] },
      }),
    ).rejects.toMatchObject({
      payload: { code: "PAGE_RANGE_INVALID" },
    });
  });

  it("caps decoded object streams cumulatively within one worker job", () => {
    const sharedContents = new Uint8Array(22 * 1024 * 1024);
    const makeParser = () => {
      const context = PDFContext.create();
      return PDFObjectStreamParser.forStream(
        PDFRawStream.of(context.obj({ Type: "ObjStm", First: 0, N: 0 }), sharedContents),
      );
    };

    expect(makeParser).not.toThrow();
    expect(makeParser).not.toThrow();
    expect(makeParser).toThrow("PDF_STREAM_SAFETY_LIMIT");
  });
});
