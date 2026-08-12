import type { PdfOptimizeResultDescriptor } from "@hereisit/tool-contracts/pdf-optimize";
import { afterEach, describe, expect, it, vi } from "vitest";

const descriptor: Extract<PdfOptimizeResultDescriptor, { kind: "download" }> = {
  kind: "download",
  mime: "application/pdf",
  sourceByteLength: 100,
  byteLength: 90,
  pageCount: 1,
  profile: "structural",
  engineBuildId: "sha256:engine",
  warnings: ["SIGNATURES_INVALIDATED"],
};

function pdfFile(size: number, name = "private.pdf"): File {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  bytes.set(new TextEncoder().encode("%%EOF"), size - 5);
  return new File([bytes], name, { type: "application/pdf" });
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    mediaBox: [0, 0, 612, 792] as const,
    cropBox: [0, 0, 612, 792] as const,
    rotation: 0,
    textItemCount: 2,
    annotationClasses: ["Link"],
    operators: { image: 1, text: 2, vector: 3, other: 4 },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("PDF optimize verification core", () => {
  it("uses deterministic bounded samples", async () => {
    const { deterministicPdfSamples } = await import("./pdf-optimize-verify.worker");
    expect(deterministicPdfSamples(1)).toEqual([1]);
    expect(deterministicPdfSamples(4)).toEqual([1, 2, 3, 4]);
    expect(deterministicPdfSamples(100)).toEqual([1, 26, 51, 75, 100]);
  });

  it.each([
    ["page count", [page(), page()], [page()]],
    ["media box", [page()], [page({ mediaBox: [0, 0, 600, 792] })]],
    ["crop box", [page()], [page({ cropBox: [1, 0, 612, 792] })]],
    ["rotation", [page()], [page({ rotation: 90 })]],
    ["text count", [page()], [page({ textItemCount: 1 })]],
    ["annotation classes", [page()], [page({ annotationClasses: ["Widget"] })]],
    [
      "operator summary",
      [page()],
      [page({ operators: { image: 0, text: 2, vector: 3, other: 4 } })],
    ],
  ])("rejects a %s mismatch", async (_name, source, result) => {
    const { comparePdfSemanticPages } = await import("./pdf-optimize-verify.worker");
    expect(() => comparePdfSemanticPages(source, result)).toThrow();
  });

  it("accepts bounded visual change and rejects blank or drastically changed pages", async () => {
    const { comparePdfVisualFingerprints } = await import("./pdf-optimize-verify.worker");
    expect(() =>
      comparePdfVisualFingerprints(
        { samples: [20, 30, 40], nonWhiteFraction: 0.5 },
        { samples: [22, 29, 43], nonWhiteFraction: 0.48 },
      ),
    ).not.toThrow();
    expect(() =>
      comparePdfVisualFingerprints(
        { samples: [20, 30, 40], nonWhiteFraction: 0.5 },
        { samples: [255, 255, 255], nonWhiteFraction: 0 },
      ),
    ).toThrow();
    expect(() =>
      comparePdfVisualFingerprints(
        { samples: [255, 255], nonWhiteFraction: 0 },
        { samples: [255, 255], nonWhiteFraction: 0 },
      ),
    ).not.toThrow();
    expect(() =>
      comparePdfVisualFingerprints(
        { samples: [20, 30, 40], nonWhiteFraction: 0.5 },
        { samples: [200, 220, 240], nonWhiteFraction: 0.5 },
      ),
    ).toThrow();
  });

  it("closes the source parser before reading and opening the result", async () => {
    const order: string[] = [];
    const source = pdfFile(100);
    const result = pdfFile(90, "result.pdf");
    vi.spyOn(source, "arrayBuffer").mockImplementation(async () => {
      order.push("read-source");
      return await new Blob([source]).arrayBuffer();
    });
    vi.spyOn(result, "arrayBuffer").mockImplementation(async () => {
      order.push("read-result");
      return await new Blob([result]).arrayBuffer();
    });
    let opened = 0;
    const inspect = vi.fn(async () => {
      opened += 1;
      const label = opened === 1 ? "source" : "result";
      order.push(`open-${label}`);
      return {
        pages: [page()],
        close: () => {
          order.push(`close-${label}`);
        },
      };
    });
    const { verifyPdfOptimizeFiles } = await import("./pdf-optimize-verify.worker");
    await verifyPdfOptimizeFiles(source, result, descriptor, { inspect, render: vi.fn() });
    expect(order).toEqual([
      "read-source",
      "open-source",
      "close-source",
      "read-result",
      "open-result",
      "close-result",
    ]);
  });

  it("reads both Files inside verification and does no render work for structural output", async () => {
    const source = pdfFile(100);
    const result = pdfFile(90, "result.pdf");
    const sourceRead = vi.spyOn(source, "arrayBuffer");
    const resultRead = vi.spyOn(result, "arrayBuffer");
    const render = vi.fn();
    const { verifyPdfOptimizeFiles } = await import("./pdf-optimize-verify.worker");
    await expect(
      verifyPdfOptimizeFiles(source, result, descriptor, {
        inspect: vi.fn(async () => ({ pages: [page()], close: vi.fn(async () => undefined) })),
        render,
      }),
    ).resolves.toMatchObject({ blob: result, descriptor });
    expect(sourceRead).toHaveBeenCalledOnce();
    expect(resultRead).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
  });

  it("samples at most five pages and closes both parser sessions after cancellation", async () => {
    const sourceClose = vi.fn(async () => undefined);
    const resultClose = vi.fn(async () => undefined);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        pages: Array.from({ length: 10 }, () => page()),
        close: sourceClose,
      })
      .mockResolvedValueOnce({
        pages: Array.from({ length: 10 }, () => page()),
        close: resultClose,
      });
    const render = vi.fn(async (_inspection: unknown, _pageNumber: number) => ({
      samples: [20, 30],
      nonWhiteFraction: 0.5,
    }));
    const imageDescriptor = {
      ...descriptor,
      pageCount: 10,
      profile: "image-optimized" as const,
      warnings: ["SIGNATURES_INVALIDATED", "EMBEDDED_IMAGE_QUALITY_CHANGED"] as const,
    };
    const source = pdfFile(100);
    const result = pdfFile(90, "result.pdf");
    const { verifyPdfOptimizeFiles } = await import("./pdf-optimize-verify.worker");
    await verifyPdfOptimizeFiles(source, result, imageDescriptor, { inspect, render });
    expect(render).toHaveBeenCalledTimes(10);
    expect(new Set(render.mock.calls.map((call) => call[1])).size).toBe(5);
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(resultClose).toHaveBeenCalledOnce();
  });

  it("rejects hostile reads, bad envelope, expansion, and private parser errors with one public error", async () => {
    const { verifyPdfOptimizeFiles } = await import("./pdf-optimize-verify.worker");
    const hostile = pdfFile(100);
    vi.spyOn(hostile, "arrayBuffer").mockRejectedValue(new Error("/private/path secret parser"));
    await expect(
      verifyPdfOptimizeFiles(hostile, pdfFile(90), descriptor, {
        inspect: vi.fn(),
        render: vi.fn(),
      }),
    ).rejects.toEqual({
      code: "VERIFICATION_FAILED",
      message: "PDF 처리 결과를 확인할 수 없습니다.",
      retryable: true,
    });
    await expect(
      verifyPdfOptimizeFiles(
        pdfFile(100),
        new File([new Uint8Array(90)], "bad.pdf", { type: "application/pdf" }),
        descriptor,
        { inspect: vi.fn(), render: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  });
});
