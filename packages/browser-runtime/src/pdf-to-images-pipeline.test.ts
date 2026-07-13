import type { PdfToImagesSpecV1 } from "@hereisit/tool-contracts";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { WorkerCanvasFactory } from "./pdf-raster-runtime";
import {
  PdfToImagesPipelineError,
  type PdfToImagesRendererAdapter,
  runPdfToImagesPipeline,
  toPdfToImagesErrorPayload,
} from "./pdf-to-images-pipeline";

const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
const JPEG_BYTES = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9);
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

function pdfInput(overrides: Partial<Parameters<typeof runPdfToImagesPipeline>[0]> = {}) {
  const bytes = new TextEncoder().encode("%PDF-1.7\nlocal fixture").buffer;
  return {
    name: "folder/report.pdf",
    mimeHint: "application/pdf",
    byteLength: bytes.byteLength,
    bytes,
    ...overrides,
  };
}

function spec(overrides: Partial<PdfToImagesSpecV1> = {}): PdfToImagesSpecV1 {
  return {
    version: 1,
    selection: { mode: "extract", pages: [1] },
    output: { format: "jpeg", quality: 85, background: "#ffffff" },
    dpi: 96,
    ...overrides,
  };
}

function tickingNow(): () => number {
  let value = 0;
  return () => value++;
}

async function settleBeforeNextTimer<T>(promise: Promise<T>) {
  return await Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    new Promise<{ status: "pending" }>((resolve) => {
      setTimeout(() => resolve({ status: "pending" }), 0);
    }),
  ]);
}

interface FakePageGeometry {
  width: number;
  height: number;
  rotation?: number;
}

interface FakeConfiguration {
  pages?: readonly FakePageGeometry[];
  sourcePageCount?: number;
  viewportByPage?: Readonly<Record<number, { width: number; height: number }>>;
  viewportErrorByPage?: Readonly<Record<number, unknown>>;
  encodedBytesByPage?: Readonly<Record<number, Uint8Array>>;
  encodedSizeByPage?: Readonly<Record<number, number>>;
  encodeErrorByPage?: Readonly<Record<number, unknown>>;
  encodeGate?: Promise<void>;
  loadError?: unknown;
  blockLoad?: boolean;
  blockGetPageCall?: number;
  cachedFulfilledParserOperations?: boolean;
  renderErrorPage?: number;
  encodeErrorPage?: number;
  blockRenderPage?: number;
  onFill?: () => void;
  createArchive?: NonNullable<PdfToImagesRendererAdapter["createArchive"]>;
}

interface FakeCounters {
  createCanvas: number;
  canvasDestroy: number;
  activeCanvases: number;
  maxActiveCanvases: number;
  render: number;
  renderCancel: number;
  activeRenders: number;
  maxActiveRenders: number;
  pageCleanup: number;
  documentCleanup: number;
  loadingTaskDestroy: number;
  pdfWorkerDestroy: number;
  parserPortTerminate: number;
  archiveTerminate: number;
  parserFailureListenerRemove: number;
  getPage: number;
  canvases: Array<{ width: number; height: number }>;
  fills: Array<{
    fillStyle: unknown;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  renderBackgrounds: unknown[];
  encodeOptions: Array<{ type: string; quality?: number }>;
}

class FakePdfError extends Error {
  constructor(readonly code: "PASSWORD_PROTECTED" | "CORRUPT_PDF") {
    super(code);
  }
}

function fakeAdapter(configuration: FakeConfiguration = {}): {
  adapter: PdfToImagesRendererAdapter;
  counters: FakeCounters;
  renderStarted: Promise<void>;
  blockedOperationStarted: Promise<void>;
  crashParser(): void;
} {
  const pages = configuration.pages ?? [{ width: 72, height: 72 }];
  const sourcePageCount = configuration.sourcePageCount ?? pages.length;
  const counters: FakeCounters = {
    createCanvas: 0,
    canvasDestroy: 0,
    activeCanvases: 0,
    maxActiveCanvases: 0,
    render: 0,
    renderCancel: 0,
    activeRenders: 0,
    maxActiveRenders: 0,
    pageCleanup: 0,
    documentCleanup: 0,
    loadingTaskDestroy: 0,
    pdfWorkerDestroy: 0,
    parserPortTerminate: 0,
    archiveTerminate: 0,
    parserFailureListenerRemove: 0,
    getPage: 0,
    canvases: [],
    fills: [],
    renderBackgrounds: [],
    encodeOptions: [],
  };
  let currentSourcePage = 1;
  let notifyRenderStarted: () => void = () => undefined;
  const renderStarted = new Promise<void>((resolve) => {
    notifyRenderStarted = resolve;
  });
  let notifyBlockedOperationStarted: () => void = () => undefined;
  const blockedOperationStarted = new Promise<void>((resolve) => {
    notifyBlockedOperationStarted = resolve;
  });
  let rejectParserFailure: (error: unknown) => void = () => undefined;
  const parserFailure = new Promise<never>((_resolve, reject) => {
    rejectParserFailure = reject;
  });
  void parserFailure.catch(() => undefined);
  let parserCrashed = false;

  const document = {
    numPages: sourcePageCount,
    getPage(sourcePage: number) {
      counters.getPage += 1;
      if (counters.getPage === configuration.blockGetPageCall) {
        notifyBlockedOperationStarted();
        return new Promise<never>(() => undefined);
      }
      currentSourcePage = sourcePage;
      const geometry = pages[sourcePage - 1] ?? { width: 72, height: 72 };
      const page = {
        rotate: geometry.rotation ?? 0,
        getViewport({ scale, rotation }: { scale: number; rotation?: number }) {
          const viewportError = configuration.viewportErrorByPage?.[sourcePage];
          if (viewportError !== undefined) throw viewportError;
          if (scale === 1 && rotation === 0) {
            return { width: geometry.width, height: geometry.height };
          }
          const overridden = configuration.viewportByPage?.[sourcePage];
          if (overridden !== undefined) return overridden;
          const swapsAxes = (geometry.rotation ?? 0) % 180 !== 0;
          return {
            width: (swapsAxes ? geometry.height : geometry.width) * scale,
            height: (swapsAxes ? geometry.width : geometry.height) * scale,
          };
        },
        render({ background }: { background: unknown }) {
          counters.render += 1;
          counters.renderBackgrounds.push(background);
          counters.activeRenders += 1;
          counters.maxActiveRenders = Math.max(counters.maxActiveRenders, counters.activeRenders);
          notifyRenderStarted();
          if (configuration.blockRenderPage === sourcePage) notifyBlockedOperationStarted();

          let settled = false;
          let rejectBlocked: ((error: unknown) => void) | undefined;
          const innerPromise =
            configuration.blockRenderPage === sourcePage
              ? new Promise<void>((_resolve, reject) => {
                  rejectBlocked = reject;
                })
              : configuration.renderErrorPage === sourcePage
                ? Promise.reject(new Error("render fixture failure"))
                : Promise.resolve();
          let promise: Promise<void>;
          if (
            configuration.cachedFulfilledParserOperations &&
            configuration.blockRenderPage !== sourcePage &&
            configuration.renderErrorPage !== sourcePage
          ) {
            settled = true;
            counters.activeRenders -= 1;
            promise = Promise.resolve();
          } else {
            promise = innerPromise.finally(() => {
              if (settled) return;
              settled = true;
              counters.activeRenders -= 1;
            });
          }

          return {
            promise,
            cancel() {
              counters.renderCancel += 1;
              rejectBlocked?.(new Error("cancelled render fixture"));
            },
          };
        },
        cleanup() {
          counters.pageCleanup += 1;
          return true;
        },
      };
      return configuration.cachedFulfilledParserOperations
        ? Promise.resolve(page)
        : (async () => page)();
    },
    async cleanup() {
      counters.documentCleanup += 1;
    },
  };

  const adapter: PdfToImagesRendererAdapter = {
    async open() {
      if (configuration.blockLoad) notifyBlockedOperationStarted();
      return {
        loadingTask: {
          promise:
            configuration.blockLoad === true
              ? new Promise<never>(() => undefined)
              : configuration.loadError === undefined
                ? Promise.resolve(document)
                : Promise.reject(configuration.loadError),
          async destroy() {
            counters.loadingTaskDestroy += 1;
          },
        },
        pdfWorker: {
          destroy() {
            counters.pdfWorkerDestroy += 1;
          },
        },
        parserPort: {
          terminate() {
            counters.parserPortTerminate += 1;
          },
        },
        parserFailure,
        removeParserFailureListeners() {
          counters.parserFailureListenerRemove += 1;
        },
        classifyError(error) {
          return error instanceof FakePdfError ? error.code : undefined;
        },
      };
    },
    createCanvas(width, height) {
      counters.createCanvas += 1;
      counters.activeCanvases += 1;
      counters.maxActiveCanvases = Math.max(counters.maxActiveCanvases, counters.activeCanvases);
      const canvas = {
        width,
        height,
        async convertToBlob(options: { type: string; quality?: number }) {
          counters.encodeOptions.push(options);
          const { type } = options;
          await configuration.encodeGate;
          const encodeError = configuration.encodeErrorByPage?.[currentSourcePage];
          if (encodeError !== undefined) throw encodeError;
          if (configuration.encodeErrorPage === currentSourcePage) {
            throw new Error("encode fixture failure");
          }
          const bytes =
            configuration.encodedBytesByPage?.[currentSourcePage] ??
            (type === "image/png" ? PNG_BYTES : JPEG_BYTES);
          const size = configuration.encodedSizeByPage?.[currentSourcePage] ?? bytes.byteLength;
          return {
            type,
            size,
            async arrayBuffer() {
              if (size !== bytes.byteLength) {
                throw new Error("oversized fixture must fail before reading bytes");
              }
              return bytes.slice().buffer;
            },
          } as Blob;
        },
      };
      counters.canvases.push(canvas);
      const context = {
        fillStyle: "" as unknown,
        fillRect(x: number, y: number, fillWidth: number, fillHeight: number) {
          counters.fills.push({
            fillStyle: context.fillStyle,
            x,
            y,
            width: fillWidth,
            height: fillHeight,
          });
          configuration.onFill?.();
        },
      };
      let destroyed = false;
      return {
        canvas,
        context,
        destroy() {
          if (destroyed) return;
          destroyed = true;
          canvas.width = 0;
          canvas.height = 0;
          counters.canvasDestroy += 1;
          counters.activeCanvases -= 1;
        },
      };
    },
    ...(configuration.createArchive === undefined
      ? {}
      : { createArchive: configuration.createArchive }),
  };

  return {
    adapter,
    counters,
    renderStarted,
    blockedOperationStarted,
    crashParser() {
      if (parserCrashed) return;
      parserCrashed = true;
      rejectParserFailure(
        new PdfToImagesPipelineError("WORKER_CRASH", "PDF 렌더러 작업기가 중단됐어요.", true),
      );
    },
  };
}

describe("runPdfToImagesPipeline output and progress", () => {
  it.each([
    {
      format: "jpeg" as const,
      output: { format: "jpeg" as const, quality: 85, background: "#ffffff" as const },
      mime: "image/jpeg",
      signature: [0xff, 0xd8, 0xff],
      name: "report-page-002.jpg",
    },
    {
      format: "png" as const,
      output: { format: "png" as const, background: "#ffffff" as const },
      mime: "image/png",
      signature: [0x89, 0x50, 0x4e, 0x47],
      name: "report-page-002.png",
    },
  ])("returns one selected $format page directly", async ({ output, mime, signature, name }) => {
    const { adapter, counters } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 144, rotation: 90 },
        { width: 72, height: 72 },
      ],
    });
    const progress: string[] = [];

    const result = await runPdfToImagesPipeline(
      pdfInput(),
      spec({ selection: { mode: "extract", pages: [2] }, output }),
      {
        adapter,
        now: tickingNow(),
        onProgress(event) {
          progress.push(event.phase);
        },
      },
    );

    expect(result).toMatchObject({
      suggestedName: name,
      mime,
      byteLength: result.bytes.byteLength,
      sourcePageCount: 3,
      outputPageCount: 1,
      outputFileCount: 1,
      format: output.format,
      warnings: ["PDF_PAGE_RASTERIZED", "COLOR_PROFILE_NORMALIZED"],
      timing: { loadMs: 1, renderMs: 1, encodeMs: 1, archiveMs: 0, totalMs: 7 },
    });
    expect(Array.from(new Uint8Array(result.bytes).slice(0, signature.length))).toEqual(signature);
    expect(progress).toEqual(["validating", "loading", "rendering", "encoding", "finalizing"]);
    expect(counters).toMatchObject({
      createCanvas: 1,
      canvasDestroy: 1,
      activeCanvases: 0,
      maxActiveCanvases: 1,
      render: 1,
      activeRenders: 0,
      maxActiveRenders: 1,
      pageCleanup: 4,
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
    });
    expect(counters.canvases).toHaveLength(1);
    expect(counters.canvases[0]).toMatchObject({ width: 0, height: 0 });
    expect(counters.fills).toEqual([{ fillStyle: "#ffffff", x: 0, y: 0, width: 192, height: 96 }]);
    expect(counters.renderBackgrounds).toEqual(["#ffffff"]);
    expect(counters.encodeOptions).toEqual([
      output.format === "jpeg" ? { type: "image/jpeg", quality: 0.85 } : { type: "image/png" },
    ]);
  });

  it("excludes the white canvas fill from renderMs while retaining it in total time", async () => {
    let clock = 0;
    const { adapter, counters } = fakeAdapter({
      onFill() {
        clock += 25;
      },
    });

    const result = await runPdfToImagesPipeline(pdfInput(), spec(), {
      adapter,
      now: () => clock,
    });

    expect(result.timing).toMatchObject({ renderMs: 0, totalMs: 25 });
    expect(counters.fills).toEqual([{ fillStyle: "#ffffff", x: 0, y: 0, width: 96, height: 96 }]);
  });

  it("streams ZIP entries in selection order while keeping source page numbers", async () => {
    const { adapter, counters } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      encodedBytesByPage: {
        1: Uint8Array.of(...JPEG_BYTES, 1),
        3: Uint8Array.of(...JPEG_BYTES, 3),
      },
    });
    const progress: Array<{
      phase: string;
      fraction: number;
      completedPages?: number;
      totalPages?: number;
    }> = [];

    const result = await runPdfToImagesPipeline(
      pdfInput(),
      spec({ selection: { mode: "extract", pages: [3, 1] } }),
      {
        adapter,
        now: tickingNow(),
        onProgress(event) {
          progress.push(event);
        },
      },
    );
    const entries = unzipSync(new Uint8Array(result.bytes));

    expect(result).toMatchObject({
      suggestedName: "report-images-hereisit.zip",
      mime: "application/zip",
      sourcePageCount: 3,
      outputPageCount: 2,
      outputFileCount: 2,
      format: "jpeg",
      warnings: ["PDF_PAGE_RASTERIZED", "COLOR_PROFILE_NORMALIZED"],
    });
    expect(Object.keys(entries)).toEqual(["report-page-003.jpg", "report-page-001.jpg"]);
    expect(entries["report-page-003.jpg"]).toEqual(Uint8Array.of(...JPEG_BYTES, 3));
    expect(entries["report-page-001.jpg"]).toEqual(Uint8Array.of(...JPEG_BYTES, 1));
    expect(progress.map(({ phase }) => phase)).toEqual([
      "validating",
      "loading",
      "rendering",
      "encoding",
      "rendering",
      "encoding",
      "archiving",
      "finalizing",
    ]);
    expect(
      progress
        .filter((event) => event.phase === "rendering" || event.phase === "encoding")
        .map(({ completedPages, totalPages }) => [completedPages, totalPages]),
    ).toEqual([
      [1, 2],
      [1, 2],
      [2, 2],
      [2, 2],
    ]);
    expect(progress.map((event) => event.fraction)).toEqual(
      [...progress.map((event) => event.fraction)].sort((left, right) => left - right),
    );
    expect(counters.maxActiveCanvases).toBe(1);
    expect(counters.maxActiveRenders).toBe(1);
    expect(counters.activeCanvases).toBe(0);
    expect(counters.activeRenders).toBe(0);
    expect(counters.pageCleanup).toBe(5);
  });

  it.each([
    {
      rotation: 0,
      viewport: { width: 612 * (150 / 72), height: 792 * (150 / 72) },
      expected: { width: 1_275, height: 1_650 },
    },
    {
      rotation: 90,
      viewport: { width: 792 * (150 / 72), height: 612 * (150 / 72) },
      expected: { width: 1_650, height: 1_275 },
    },
  ])("uses planned integer dimensions for a $rotation-degree PDF.js viewport overshoot", async ({
    rotation,
    viewport,
    expected,
  }) => {
    const { adapter, counters } = fakeAdapter({
      pages: [{ width: 612, height: 792, rotation }],
      viewportByPage: { 1: viewport },
    });

    await runPdfToImagesPipeline(pdfInput(), spec({ dpi: 150 }), { adapter });

    expect(counters.fills).toEqual([{ fillStyle: "#ffffff", x: 0, y: 0, ...expected }]);
  });
});

describe("runPdfToImagesPipeline resource gates", () => {
  it.each([
    {
      name: "source documents above 500 pages",
      configuration: { sourcePageCount: 501 },
      selected: { mode: "extract" as const, pages: [1] },
      code: "PAGE_LIMIT",
      pageCleanup: 0,
    },
    {
      name: "every-page selections above 100 pages",
      configuration: {
        sourcePageCount: 101,
        pages: Array.from({ length: 101 }, () => ({ width: 72, height: 72 })),
      },
      selected: { mode: "every-page" as const },
      code: "PAGE_LIMIT",
      pageCleanup: 101,
    },
    {
      name: "known oversized inspected pages",
      configuration: { pages: [{ width: 7_000, height: 7_000 }] },
      selected: { mode: "extract" as const, pages: [1] },
      code: "MEMORY_LIMIT",
      pageCleanup: 1,
    },
    {
      name: "known selected output above 100 MP",
      configuration: {
        pages: Array.from({ length: 7 }, () => ({ width: 3_000, height: 3_000 })),
      },
      selected: { mode: "extract" as const, pages: [1, 2, 3, 4, 5, 6, 7] },
      code: "MEMORY_LIMIT",
      pageCleanup: 7,
    },
  ])("rejects $name before creating a canvas", async ({
    configuration,
    selected,
    code,
    pageCleanup,
  }) => {
    const { adapter, counters } = fakeAdapter(configuration);

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: selected }), { adapter }),
    ).rejects.toMatchObject({ code });
    expect(counters.createCanvas).toBe(0);
    expect(counters.render).toBe(0);
    expect(counters.pageCleanup).toBe(pageCleanup);
  });

  it.each([
    { width: 8_193, height: 1_000 },
    { width: 4_001, height: 4_000 },
  ])("rejects a defensive $width x $height PDF.js viewport before render", async (viewport) => {
    const { adapter, counters } = fakeAdapter({
      pages: [{ width: 72, height: 72 }],
      viewportByPage: { 1: viewport },
    });

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toMatchObject({
      code: "MEMORY_LIMIT",
    });
    expect(counters.createCanvas).toBe(0);
    expect(counters.render).toBe(0);
  });

  it("rejects a direct encoded output above 100 MiB before reading it", async () => {
    const { adapter, counters } = fakeAdapter({
      encodedSizeByPage: { 1: MAX_OUTPUT_BYTES + 1 },
    });

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toMatchObject({
      code: "MEMORY_LIMIT",
    });
    expect(counters.canvasDestroy).toBe(1);
    expect(counters.documentCleanup).toBe(1);
  });

  it("terminates a ZIP as soon as cumulative streamed output exceeds 100 MiB", async () => {
    let onData: Parameters<NonNullable<PdfToImagesRendererAdapter["createArchive"]>>[0];
    const chunks = [60 * 1024 * 1024, 50 * 1024 * 1024];
    const createArchive: NonNullable<PdfToImagesRendererAdapter["createArchive"]> = (callback) => {
      onData = callback;
      return {
        add() {
          const byteLength = chunks.shift() ?? 0;
          onData(null, { byteLength } as Uint8Array, false);
        },
        end() {
          onData(null, new Uint8Array(), true);
        },
        terminate: vi.fn(),
      };
    };
    const { adapter, counters } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      createArchive(callback) {
        const archive = createArchive(callback);
        const terminate = archive.terminate.bind(archive);
        archive.terminate = () => {
          counters.archiveTerminate += 1;
          terminate();
        };
        return archive;
      },
    });

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: { mode: "extract", pages: [1, 2] } }), {
        adapter,
      }),
    ).rejects.toMatchObject({ code: "MEMORY_LIMIT" });
    expect(counters.archiveTerminate).toBe(1);
    expect(counters.activeCanvases).toBe(0);
    expect(counters.documentCleanup).toBe(1);
  });

  it("normalizes a direct canvas-budget exception to the public memory error", async () => {
    const { adapter: baseAdapter } = fakeAdapter();
    const adapter: PdfToImagesRendererAdapter = {
      ...baseAdapter,
      createCanvas(_width, _height, budget) {
        return new WorkerCanvasFactory(budget).create(8_193, 1) as never;
      },
    };

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toEqual(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message:
          "선택한 해상도에서 이미지를 안전하게 만들 수 없어요. 페이지 수나 해상도를 줄여 주세요.",
      }),
    );
  });

  it("maps a nested canvas-memory marker from getViewport to the public memory error", async () => {
    const { adapter, counters } = fakeAdapter({
      viewportErrorByPage: {
        1: { cause: { details: "[HEREISIT_PDF_CANVAS_MEMORY_LIMIT] nested viewport failure" } },
      },
    });

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toEqual(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message:
          "선택한 해상도에서 이미지를 안전하게 만들 수 없어요. 페이지 수나 해상도를 줄여 주세요.",
      }),
    );
    expect(counters.createCanvas).toBe(0);
    expect(counters.documentCleanup).toBe(1);
  });

  it("maps a nested canvas-memory marker from convertToBlob to the public memory error", async () => {
    const { adapter, counters } = fakeAdapter({
      encodeErrorByPage: {
        1: {
          originalError: { reason: "[HEREISIT_PDF_CANVAS_MEMORY_LIMIT] nested encode failure" },
        },
      },
    });

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toEqual(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message:
          "선택한 해상도에서 이미지를 안전하게 만들 수 없어요. 페이지 수나 해상도를 줄여 주세요.",
      }),
    );
    expect(counters.canvasDestroy).toBe(1);
    expect(counters.documentCleanup).toBe(1);
  });

  it.each([
    "create",
    "add",
    "end",
  ] as const)("maps a nested canvas-memory marker from ZIP %s to the public memory error", async (failureStage) => {
    const nestedMemoryFailure = {
      cause: { message: "[HEREISIT_PDF_CANVAS_MEMORY_LIMIT] nested archive failure" },
    };
    const { adapter, counters } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      createArchive(onData) {
        if (failureStage === "create") throw nestedMemoryFailure;
        return {
          add() {
            if (failureStage === "add") throw nestedMemoryFailure;
          },
          end() {
            if (failureStage === "end") throw nestedMemoryFailure;
            onData(null, new Uint8Array(), true);
          },
          terminate: vi.fn(),
        };
      },
    });

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: { mode: "extract", pages: [1, 2] } }), {
        adapter,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message:
          "선택한 해상도에서 이미지를 안전하게 만들 수 없어요. 페이지 수나 해상도를 줄여 주세요.",
      }),
    );
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
  });

  it.each([
    "create",
    "add",
    "end",
  ] as const)("maps a synchronous ZIP %s failure to ENCODE_FAILED", async (failureStage) => {
    const { adapter, counters } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      createArchive(onData) {
        if (failureStage === "create") throw new Error("archive create fixture failure");
        return {
          add() {
            if (failureStage === "add") throw new Error("archive add fixture failure");
          },
          end() {
            if (failureStage === "end") throw new Error("archive end fixture failure");
            onData(null, new Uint8Array(), true);
          },
          terminate: vi.fn(),
        };
      },
    });

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: { mode: "extract", pages: [1, 2] } }), {
        adapter,
      }),
    ).rejects.toMatchObject({ code: "ENCODE_FAILED" });
    expect(counters.activeCanvases).toBe(0);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
  });
});

describe("runPdfToImagesPipeline errors and cleanup", () => {
  it("preserves the page-less PDF error at the image pipeline boundary", async () => {
    const { adapter, counters } = fakeAdapter({ sourcePageCount: 0 });

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toEqual(
      expect.objectContaining({
        code: "CORRUPT_PDF",
        message: "페이지가 없는 PDF는 처리할 수 없어요.",
      }),
    );
    expect(counters.getPage).toBe(0);
    expect(counters.documentCleanup).toBe(1);
  });

  it.each([
    ["password loading", new FakePdfError("PASSWORD_PROTECTED"), "PASSWORD_PROTECTED"],
    ["corrupt loading", new FakePdfError("CORRUPT_PDF"), "CORRUPT_PDF"],
  ] as const)("maps %s to %s", async (_name, loadError, code) => {
    const { adapter, counters } = fakeAdapter({ loadError });

    await expect(runPdfToImagesPipeline(pdfInput(), spec(), { adapter })).rejects.toMatchObject({
      code,
    });
    expect(counters).toMatchObject({
      documentCleanup: 0,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
    });
  });

  it.each([
    {
      name: "page range",
      configuration: {},
      selected: { mode: "extract" as const, pages: [2] },
      code: "PAGE_RANGE_INVALID",
      pageCleanup: 1,
    },
    {
      name: "render",
      configuration: { renderErrorPage: 1 },
      selected: { mode: "extract" as const, pages: [1] },
      code: "RENDER_FAILED",
      pageCleanup: 2,
    },
    {
      name: "encode",
      configuration: { encodeErrorPage: 1 },
      selected: { mode: "extract" as const, pages: [1] },
      code: "ENCODE_FAILED",
      pageCleanup: 2,
    },
  ])("maps a $name failure to $code and releases every acquired resource", async ({
    configuration,
    selected,
    code,
    pageCleanup,
  }) => {
    const { adapter, counters } = fakeAdapter(configuration);

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: selected }), { adapter }),
    ).rejects.toMatchObject({ code });
    expect(counters.activeCanvases).toBe(0);
    expect(counters.activeRenders).toBe(0);
    expect(counters.pageCleanup).toBe(pageCleanup);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
    expect(counters.pdfWorkerDestroy).toBe(1);
    expect(counters.parserPortTerminate).toBe(1);
    expect(counters.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(
      true,
    );
  });

  it.each([
    {
      name: "document loading",
      configuration: { blockLoad: true },
      pageCleanup: 0,
      documentCleanup: 0,
      renderCancel: 0,
    },
    {
      name: "inspection getPage",
      configuration: { blockGetPageCall: 1 },
      pageCleanup: 0,
      documentCleanup: 1,
      renderCancel: 0,
    },
    {
      name: "render getPage",
      configuration: { blockGetPageCall: 2 },
      pageCleanup: 1,
      documentCleanup: 1,
      renderCancel: 0,
    },
    {
      name: "active render",
      configuration: { blockRenderPage: 1 },
      pageCleanup: 2,
      documentCleanup: 1,
      renderCancel: 1,
    },
  ])("settles a parser crash during $name and cleans acquired resources", async ({
    configuration,
    pageCleanup,
    documentCleanup,
    renderCancel,
  }) => {
    const { adapter, counters, blockedOperationStarted, crashParser } = fakeAdapter(configuration);
    const result = runPdfToImagesPipeline(pdfInput(), spec(), { adapter });

    await blockedOperationStarted;
    crashParser();

    await expect(settleBeforeNextTimer(result)).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "WORKER_CRASH",
        retryable: true,
      },
    });
    expect(counters.pageCleanup).toBe(pageCleanup);
    expect(counters.documentCleanup).toBe(documentCleanup);
    expect(counters.renderCancel).toBe(renderCancel);
    expect(counters.loadingTaskDestroy).toBe(1);
    expect(counters.pdfWorkerDestroy).toBe(1);
    expect(counters.parserPortTerminate).toBe(1);
    expect(counters.parserFailureListenerRemove).toBe(1);
  });

  it("keeps a valid direct image when the parser fails after the final render", async () => {
    let releaseEncode: () => void = () => undefined;
    const encodeGate = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });
    const { adapter, counters, crashParser } = fakeAdapter({ encodeGate });

    const result = await runPdfToImagesPipeline(pdfInput(), spec(), {
      adapter,
      onProgress(progress) {
        if (progress.phase !== "rendering") return;
        crashParser();
        releaseEncode();
      },
    });

    expect(result).toMatchObject({
      mime: "image/jpeg",
      suggestedName: "report-page-001.jpg",
      outputPageCount: 1,
    });
    expect(Array.from(new Uint8Array(result.bytes).slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(counters.pageCleanup).toBe(2);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
    expect(counters.pdfWorkerDestroy).toBe(1);
    expect(counters.parserPortTerminate).toBe(1);
    expect(counters.parserFailureListenerRemove).toBe(1);
  });

  it("keeps a valid local ZIP when the parser fails after the final render", async () => {
    let releaseEncode: () => void = () => undefined;
    const encodeGate = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });
    const zipBytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    const { adapter, counters, crashParser } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      encodeGate,
      createArchive(onData) {
        return {
          add: vi.fn(),
          end() {
            queueMicrotask(() => onData(null, zipBytes, true));
          },
          terminate: vi.fn(),
        };
      },
    });

    const result = await runPdfToImagesPipeline(
      pdfInput(),
      spec({ selection: { mode: "extract", pages: [1, 2] } }),
      {
        adapter,
        onProgress(progress) {
          if (progress.phase !== "rendering") return;
          if (progress.completedPages === 1) {
            releaseEncode();
          } else if (progress.completedPages === 2) {
            crashParser();
          }
        },
      },
    );

    expect(result).toMatchObject({
      mime: "application/zip",
      suggestedName: "report-images-hereisit.zip",
      outputPageCount: 2,
      byteLength: zipBytes.byteLength,
    });
    expect(new Uint8Array(result.bytes)).toEqual(zipBytes);
    expect(counters.pageCleanup).toBe(4);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
    expect(counters.pdfWorkerDestroy).toBe(1);
    expect(counters.parserPortTerminate).toBe(1);
    expect(counters.parserFailureListenerRemove).toBe(1);
  });

  it("fails at the next getPage when the parser dies after a non-final render", async () => {
    let releaseEncode: () => void = () => undefined;
    const encodeGate = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });
    const { adapter, counters, crashParser } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      encodeGate,
      blockGetPageCall: 4,
    });

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: { mode: "extract", pages: [1, 2] } }), {
        adapter,
        onProgress(progress) {
          if (progress.phase !== "rendering" || progress.completedPages !== 1) return;
          crashParser();
          releaseEncode();
        },
      }),
    ).rejects.toMatchObject({ code: "WORKER_CRASH", retryable: true });
    expect(counters.encodeOptions).toHaveLength(1);
    expect(counters.getPage).toBe(4);
    expect(counters.render).toBe(1);
    expect(counters.pageCleanup).toBe(3);
  });

  it("prioritizes a known parser failure over cached fulfilled page and render promises", async () => {
    const { adapter, counters, crashParser } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      cachedFulfilledParserOperations: true,
    });

    await expect(
      runPdfToImagesPipeline(pdfInput(), spec({ selection: { mode: "extract", pages: [1, 2] } }), {
        adapter,
        onProgress(progress) {
          if (progress.phase === "rendering" && progress.completedPages === 1) crashParser();
        },
      }),
    ).rejects.toMatchObject({ code: "WORKER_CRASH", retryable: true });
    expect(counters.getPage).toBe(4);
    expect(counters.render).toBe(1);
    expect(counters.pageCleanup).toBe(4);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
    expect(counters.pdfWorkerDestroy).toBe(1);
    expect(counters.parserPortTerminate).toBe(1);
    expect(counters.parserFailureListenerRemove).toBe(1);
  });

  it("immediately cancels an active render and unfinished archive on AbortSignal", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const { adapter, counters, renderStarted } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      blockRenderPage: 1,
      createArchive(onData) {
        return {
          add: vi.fn(),
          end: vi.fn(() => onData(null, new Uint8Array(), true)),
          terminate() {
            counters.archiveTerminate += 1;
          },
        };
      },
    });
    const result = runPdfToImagesPipeline(
      pdfInput(),
      spec({ selection: { mode: "extract", pages: [1, 2] } }),
      { adapter, signal: controller.signal },
    );

    await renderStarted;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(counters.renderCancel).toBe(1);
    expect(counters.archiveTerminate).toBe(1);
    expect(counters.activeCanvases).toBe(0);
    expect(counters.activeRenders).toBe(0);
    expect(counters.pageCleanup).toBe(3);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
    expect(counters.pdfWorkerDestroy).toBe(1);
    expect(counters.parserPortTerminate).toBe(1);
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledTimes(2);
  });

  it("rejects cancellation while waiting for the ZIP final callback", async () => {
    const controller = new AbortController();
    let notifyArchiving: () => void = () => undefined;
    const archiving = new Promise<void>((resolve) => {
      notifyArchiving = resolve;
    });
    const { adapter, counters } = fakeAdapter({
      pages: [
        { width: 72, height: 72 },
        { width: 72, height: 72 },
      ],
      createArchive() {
        return {
          add: vi.fn(),
          end: vi.fn(),
          terminate() {
            counters.archiveTerminate += 1;
          },
        };
      },
    });
    const result = runPdfToImagesPipeline(
      pdfInput(),
      spec({ selection: { mode: "extract", pages: [1, 2] } }),
      {
        adapter,
        signal: controller.signal,
        onProgress(progress) {
          if (progress.phase === "archiving") notifyArchiving();
        },
      },
    );

    await archiving;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(counters.archiveTerminate).toBe(1);
    expect(counters.documentCleanup).toBe(1);
    expect(counters.loadingTaskDestroy).toBe(1);
  });

  it("maps only typed pipeline errors into public payloads", () => {
    expect(
      toPdfToImagesErrorPayload(
        new PdfToImagesPipelineError("ENCODE_FAILED", "이미지를 만들지 못했어요."),
      ),
    ).toEqual({
      code: "ENCODE_FAILED",
      message: "이미지를 만들지 못했어요.",
      retryable: false,
    });
    expect(toPdfToImagesErrorPayload(new Error("private details"))).toEqual({
      code: "WORKER_CRASH",
      message: "PDF 이미지 변환 작업을 완료하지 못했어요.",
      retryable: true,
    });
  });
});
