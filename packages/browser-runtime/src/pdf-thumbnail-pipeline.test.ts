import type { PdfRasterRendererAdapter } from "./pdf-raster-runtime";
import { describe, expect, it } from "vitest";
import {
  PdfThumbnailPipelineError,
  runPdfThumbnailPipeline,
  toPdfThumbnailErrorPayload,
} from "./pdf-thumbnail-pipeline";

const WEBP_BYTES = Uint8Array.of(
  0x52,
  0x49,
  0x46,
  0x46,
  0x04,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
);

function pdfInput(overrides: Partial<Parameters<typeof runPdfThumbnailPipeline>[0]> = {}) {
  const bytes = new TextEncoder().encode("%PDF-1.7\nthumbnail fixture").buffer;
  return {
    name: "private.pdf",
    mimeHint: "application/pdf",
    byteLength: bytes.byteLength,
    bytes,
    ...overrides,
  };
}

function fakeAdapter(options: {
  pageCount?: number;
  width?: number;
  height?: number;
  encodedBytes?: Uint8Array;
  failRenderPage?: number;
  failEncodePage?: number;
  blockRenderPage?: number;
} = {}) {
  const pageCount = options.pageCount ?? 3;
  const encodedBytes = options.encodedBytes ?? WEBP_BYTES;
  const counters = {
    open: 0,
    getPage: 0,
    createCanvas: 0,
    activeCanvases: 0,
    maxActiveCanvases: 0,
    pageCleanup: 0,
    documentCleanup: 0,
    resourceCleanup: 0,
    renderCancel: 0,
  };
  let currentPage = 0;
  let notifyRenderStarted: () => void = () => undefined;
  const renderStarted = new Promise<void>((resolve) => {
    notifyRenderStarted = resolve;
  });
  let rejectBlockedRender: ((error: unknown) => void) | undefined;
  const parserFailure = new Promise<never>(() => undefined);

  const adapter: PdfRasterRendererAdapter = {
    async open() {
      counters.open += 1;
      return {
        loadingTask: {
          promise: Promise.resolve({
            numPages: pageCount,
            async getPage(sourcePage: number) {
              counters.getPage += 1;
              currentPage = sourcePage;
              return {
                rotate: 0,
                getViewport({ scale }: { scale: number }) {
                  return {
                    width: (options.width ?? 320) * scale,
                    height: (options.height ?? 160) * scale,
                  };
                },
                render() {
                  notifyRenderStarted();
                  const promise =
                    options.blockRenderPage === sourcePage
                      ? new Promise<void>((_resolve, reject) => {
                          rejectBlockedRender = reject;
                        })
                      : options.failRenderPage === sourcePage
                        ? Promise.reject(new Error("render failed"))
                        : Promise.resolve();
                  return {
                    promise,
                    cancel() {
                      counters.renderCancel += 1;
                      rejectBlockedRender?.(new Error("cancelled"));
                    },
                  };
                },
                cleanup() {
                  counters.pageCleanup += 1;
                },
              };
            },
            cleanup() {
              counters.documentCleanup += 1;
            },
          }),
          destroy() {
            counters.resourceCleanup += 1;
          },
        },
        pdfWorker: { destroy: () => (counters.resourceCleanup += 1) },
        parserPort: { terminate: () => (counters.resourceCleanup += 1) },
        parserFailure,
        removeParserFailureListeners() {},
        classifyError() {
          return undefined;
        },
      };
    },
    createCanvas(width, height) {
      counters.createCanvas += 1;
      counters.activeCanvases += 1;
      counters.maxActiveCanvases = Math.max(counters.maxActiveCanvases, counters.activeCanvases);
      let destroyed = false;
      return {
        canvas: {
          width,
          height,
          async convertToBlob() {
            if (options.failEncodePage === currentPage) throw new Error("encode failed");
            return {
              type: "image/webp",
              size: encodedBytes.byteLength,
              arrayBuffer: async () => encodedBytes.buffer,
            } as Blob;
          },
        },
        context: { fillStyle: "", fillRect() {} },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          counters.activeCanvases -= 1;
        },
      };
    },
  };

  return { adapter, counters, renderStarted };
}

describe("PDF thumbnail pipeline", () => {
  it("opens once and emits one bounded thumbnail at a time", async () => {
    const { adapter, counters } = fakeAdapter();
    const updates: Array<{ sourcePage: number; status: string }> = [];

    const result = await runPdfThumbnailPipeline(pdfInput(), {
      adapter,
      onThumbnail: (update) => updates.push(update),
    });

    expect(counters.open).toBe(1);
    expect(counters.maxActiveCanvases).toBe(1);
    expect(counters.activeCanvases).toBe(0);
    expect(updates.map((item) => item.sourcePage)).toEqual([1, 2, 3]);
    expect(updates.every((item) => item.status === "ready")).toBe(true);
    expect(result).toEqual({
      pageCount: 3,
      renderedPageCount: 3,
      failedPageCount: 0,
      omittedPageCount: 0,
    });
    expect(counters.pageCleanup).toBe(3);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.resourceCleanup).toBe(3);
  });

  it("continues after one page-local render or encode failure", async () => {
    const render = fakeAdapter({ failRenderPage: 2 });
    const encode = fakeAdapter({ failEncodePage: 2 });

    for (const fixture of [render, encode]) {
      const updates: Array<{ sourcePage: number; status: string }> = [];
      const result = await runPdfThumbnailPipeline(pdfInput(), {
        adapter: fixture.adapter,
        onThumbnail: (update) => updates.push(update),
      });
      expect(updates).toEqual([
        { sourcePage: 1, status: "ready", width: 160, height: 80, mime: "image/webp", bytes: WEBP_BYTES.buffer },
        { sourcePage: 2, status: "failed" },
        { sourcePage: 3, status: "ready", width: 160, height: 80, mime: "image/webp", bytes: WEBP_BYTES.buffer },
      ]);
      expect(result).toEqual({
        pageCount: 3,
        renderedPageCount: 2,
        failedPageCount: 1,
        omittedPageCount: 0,
      });
    }
  });

  it("stops before exceeding the aggregate encoded-byte budget", async () => {
    const bytes = new Uint8Array(160 * 160 * 4);
    bytes.set(WEBP_BYTES);
    const { adapter, counters } = fakeAdapter({
      pageCount: 500,
      width: 160,
      height: 160,
      encodedBytes: bytes,
    });
    let updates = 0;

    const result = await runPdfThumbnailPipeline(pdfInput(), {
      adapter,
      onThumbnail: () => {
        updates += 1;
      },
    });

    expect(result).toEqual({
      pageCount: 500,
      renderedPageCount: 491,
      failedPageCount: 0,
      omittedPageCount: 9,
    });
    expect(updates).toBe(491);
    expect(counters.createCanvas).toBe(492);
  });

  it("closes the raster session when cancelled during a render", async () => {
    const controller = new AbortController();
    const { adapter, counters, renderStarted } = fakeAdapter({ blockRenderPage: 1 });
    const pending = runPdfThumbnailPipeline(pdfInput(), {
      adapter,
      signal: controller.signal,
    });
    await renderStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(counters.renderCancel).toBe(1);
    expect(counters.activeCanvases).toBe(0);
    expect(counters.documentCleanup).toBe(1);
  });

  it("rejects invalid input and maps safe terminal errors", async () => {
    const { adapter } = fakeAdapter();
    await expect(
      runPdfThumbnailPipeline(pdfInput({ bytes: new Uint8Array([1, 2, 3]).buffer }), { adapter }),
    ).rejects.toMatchObject({ code: "CORRUPT_PDF" });
    expect(toPdfThumbnailErrorPayload(new PdfThumbnailPipelineError("MEMORY_LIMIT", "한도"))).toEqual(
      { code: "MEMORY_LIMIT", message: "한도", retryable: false },
    );
  });
});
