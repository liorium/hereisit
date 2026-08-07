import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { PdfCompressScannedSpecV1, PdfCompressScannedSpecV2 } from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PdfCompressScannedAssembler,
  type PdfCompressScannedAssemblerFactory,
  PdfCompressScannedPipelineError,
  runPdfCompressScannedPipeline,
  toPdfCompressScannedErrorPayload,
} from "./pdf-compress-scanned-pipeline";
import { type PdfRasterRendererAdapter, PdfRasterRuntimeError } from "./pdf-raster-runtime";

const JPEG_BYTES = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  ),
  (character) => character.charCodeAt(0),
);

function completePdfBytes(byteLength: number): ArrayBuffer {
  if (byteLength < 16) throw new Error("fixture PDF is too small");
  const bytes = new Uint8Array(byteLength);
  bytes.fill(0x20);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  bytes.set(new TextEncoder().encode("%%EOF"), byteLength - 5);
  return bytes.buffer;
}

function jpegBytes(byteLength = JPEG_BYTES.byteLength): Uint8Array<ArrayBuffer> {
  if (byteLength < 4) throw new Error("fixture JPEG is too small");
  const bytes = new Uint8Array(byteLength);
  bytes.set(JPEG_BYTES.subarray(0, Math.min(JPEG_BYTES.byteLength, byteLength)));
  bytes.set([0xff, 0xd9], byteLength - 2);
  return bytes;
}

function pdfInput(
  byteLength = 10_000,
  overrides: Partial<Parameters<typeof runPdfCompressScannedPipeline>[0]> = {},
) {
  const bytes = new Uint8Array(byteLength);
  bytes.set(new TextEncoder().encode("%PDF-1.7\nSOURCE_TITLE\nSOURCE_AUTHOR"));
  return {
    name: "folder/report.pdf",
    mimeHint: "application/pdf",
    byteLength: bytes.byteLength,
    bytes: bytes.buffer,
    ...overrides,
  };
}

function spec(preset: PdfCompressScannedSpecV1["preset"] = "balanced") {
  return { version: 1 as const, preset };
}

function smartSpec(preset: PdfCompressScannedSpecV2["preset"] = "balanced") {
  return { version: 2 as const, preset };
}

async function structureOptimizablePdfInput() {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText("HereIsIt searchable text", { x: 50, y: 700, font, size: 20 });
  document.getForm().createTextField("name").addToPage(page, {
    x: 50,
    y: 620,
    width: 200,
    height: 30,
  });
  const raw = await document.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
  const bytes = raw.slice().buffer as ArrayBuffer;
  return {
    name: "report.pdf",
    mimeHint: "application/pdf",
    byteLength: bytes.byteLength,
    bytes,
  };
}

function tickingNow(): () => number {
  let value = 0;
  return () => value++;
}

interface FakePageGeometry {
  widthPoints: number;
  heightPoints: number;
  rotation?: number;
}

interface FakeBlobDefinition {
  type?: string;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

interface FakeRasterConfiguration {
  pages?: readonly FakePageGeometry[];
  sourcePageCount?: number;
  loadError?: unknown;
  getPageErrorCall?: number;
  planningViewportErrorPage?: number;
  rasterViewportByPage?: Readonly<Record<number, { width: number; height: number }>>;
  renderErrorPage?: number;
  blockRenderPage?: number;
  encodeErrorPage?: number;
  blobByPage?: Readonly<Record<number, FakeBlobDefinition>>;
  encodedBytesByPage?: Readonly<Record<number, Uint8Array>>;
  createCanvasErrorPage?: number;
  sessionCloseError?: unknown;
  observer?: (event: string) => void;
  pageSignals?: Readonly<
    Record<
      number,
      {
        nonWhitespaceTextItems?: number;
        annotationCount?: number;
        imagePaintOperations?: number;
        nonImagePaintOperations?: number;
      }
    >
  >;
}

interface FakeRasterCounters {
  getPage: number;
  pageCleanup: number;
  activePages: number;
  maxActivePages: number;
  createCanvas: number;
  canvasDestroy: number;
  activeCanvases: number;
  maxActiveCanvases: number;
  render: number;
  renderCancel: number;
  activeRenders: number;
  maxActiveRenders: number;
  encode: number;
  activeEncodes: number;
  maxActiveEncodes: number;
  documentCleanup: number;
  loadingTaskDestroy: number;
  pdfWorkerDestroy: number;
  parserPortTerminate: number;
  parserFailureListenerRemove: number;
  viewportOptions: Array<{ sourcePage: number; scale: number; rotation?: number }>;
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
  events: string[];
}

class FakePdfLoadError extends Error {
  constructor(readonly code: "PASSWORD_PROTECTED" | "CORRUPT_PDF") {
    super(code);
  }
}

function fakeRasterAdapter(configuration: FakeRasterConfiguration = {}): {
  adapter: PdfRasterRendererAdapter;
  counters: FakeRasterCounters;
  renderStarted: Promise<void>;
} {
  const pages = configuration.pages ?? [
    { widthPoints: 72, heightPoints: 72 },
    { widthPoints: 144, heightPoints: 72 },
  ];
  const counters: FakeRasterCounters = {
    getPage: 0,
    pageCleanup: 0,
    activePages: 0,
    maxActivePages: 0,
    createCanvas: 0,
    canvasDestroy: 0,
    activeCanvases: 0,
    maxActiveCanvases: 0,
    render: 0,
    renderCancel: 0,
    activeRenders: 0,
    maxActiveRenders: 0,
    encode: 0,
    activeEncodes: 0,
    maxActiveEncodes: 0,
    documentCleanup: 0,
    loadingTaskDestroy: 0,
    pdfWorkerDestroy: 0,
    parserPortTerminate: 0,
    parserFailureListenerRemove: 0,
    viewportOptions: [],
    canvases: [],
    fills: [],
    renderBackgrounds: [],
    encodeOptions: [],
    events: [],
  };
  const observe = (event: string) => {
    counters.events.push(event);
    configuration.observer?.(event);
  };
  let notifyRenderStarted: () => void = () => undefined;
  const renderStarted = new Promise<void>((resolve) => {
    notifyRenderStarted = resolve;
  });
  let rejectParserFailure: (error: unknown) => void = () => undefined;
  const parserFailure = new Promise<never>((_resolve, reject) => {
    rejectParserFailure = reject;
  });
  void parserFailure.catch(() => undefined);
  void rejectParserFailure;
  let parserFailureReads = 0;

  const document = {
    numPages: configuration.sourcePageCount ?? pages.length,
    getPage(sourcePage: number) {
      counters.getPage += 1;
      observe(`page:${sourcePage}:acquire`);
      if (counters.getPage === configuration.getPageErrorCall) {
        return Promise.reject(new Error("getPage fixture failure"));
      }
      const geometry = pages[sourcePage - 1] ?? { widthPoints: 72, heightPoints: 72 };
      const signals = configuration.pageSignals?.[sourcePage];
      counters.activePages += 1;
      counters.maxActivePages = Math.max(counters.maxActivePages, counters.activePages);
      let cleaned = false;
      return Promise.resolve({
        rotate: geometry.rotation ?? 0,
        getTextContent() {
          return Promise.resolve({
            items: Array.from({ length: signals?.nonWhitespaceTextItems ?? 0 }, () => ({
              str: "searchable",
            })),
          });
        },
        getAnnotations() {
          return Promise.resolve(Array.from({ length: signals?.annotationCount ?? 0 }, () => ({})));
        },
        getOperatorList() {
          return Promise.resolve({
            fnArray: [
              ...Array.from({ length: signals?.imagePaintOperations ?? 1 }, () => 85),
              ...Array.from({ length: signals?.nonImagePaintOperations ?? 0 }, () => 91),
            ],
          });
        },
        getViewport(options: { scale: number; rotation?: number }) {
          counters.viewportOptions.push({ sourcePage, ...options });
          observe(`page:${sourcePage}:viewport:${options.scale}`);
          if (options.scale === 1 && configuration.planningViewportErrorPage === sourcePage) {
            throw new Error("planning viewport fixture failure");
          }
          if (options.scale !== 1) {
            const override = configuration.rasterViewportByPage?.[sourcePage];
            if (override !== undefined) return override;
          }
          return {
            width: geometry.widthPoints * options.scale,
            height: geometry.heightPoints * options.scale,
          };
        },
        render({ background }: { background: unknown }) {
          counters.render += 1;
          counters.activeRenders += 1;
          counters.maxActiveRenders = Math.max(counters.maxActiveRenders, counters.activeRenders);
          counters.renderBackgrounds.push(background);
          observe(`page:${sourcePage}:render:start`);
          notifyRenderStarted();
          let rejectBlocked: (error: unknown) => void = () => undefined;
          const operation =
            configuration.blockRenderPage === sourcePage
              ? new Promise<void>((_resolve, reject) => {
                  rejectBlocked = reject;
                })
              : configuration.renderErrorPage === sourcePage
                ? Promise.reject(new Error("render fixture failure"))
                : Promise.resolve();
          let settled = false;
          const promise = operation.finally(() => {
            if (settled) return;
            settled = true;
            counters.activeRenders -= 1;
            observe(`page:${sourcePage}:render:end`);
          });
          return {
            promise,
            cancel() {
              counters.renderCancel += 1;
              rejectBlocked(new Error("cancelled render fixture"));
            },
          };
        },
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          counters.pageCleanup += 1;
          counters.activePages -= 1;
          observe(`page:${sourcePage}:cleanup`);
        },
      });
    },
    cleanup() {
      counters.documentCleanup += 1;
      observe("session:document-cleanup");
    },
  };

  const adapter: PdfRasterRendererAdapter = {
    async open() {
      observe("session:open");
      return {
        loadingTask: {
          promise:
            configuration.loadError === undefined
              ? Promise.resolve(document)
              : Promise.reject(configuration.loadError),
          destroy() {
            counters.loadingTaskDestroy += 1;
            observe("session:loading-destroy");
          },
        },
        pdfWorker: {
          destroy() {
            counters.pdfWorkerDestroy += 1;
            observe("session:worker-destroy");
          },
        },
        parserPort: {
          terminate() {
            counters.parserPortTerminate += 1;
            observe("session:port-terminate");
          },
        },
        get parserFailure() {
          parserFailureReads += 1;
          if (parserFailureReads > 1 && configuration.sessionCloseError !== undefined) {
            throw configuration.sessionCloseError;
          }
          return parserFailure;
        },
        removeParserFailureListeners() {
          counters.parserFailureListenerRemove += 1;
          observe("session:listeners-remove");
        },
        classifyError(error: unknown) {
          return error instanceof FakePdfLoadError ? error.code : undefined;
        },
      };
    },
    createCanvas(width, height) {
      const sourcePage =
        counters.viewportOptions.at(-1)?.sourcePage ??
        (() => {
          throw new Error("canvas created without a page viewport");
        })();
      if (configuration.createCanvasErrorPage === sourcePage) {
        throw new Error("canvas fixture failure");
      }
      counters.createCanvas += 1;
      counters.activeCanvases += 1;
      counters.maxActiveCanvases = Math.max(counters.maxActiveCanvases, counters.activeCanvases);
      observe(`page:${sourcePage}:canvas:create`);
      const canvas = {
        width,
        height,
        async convertToBlob(options: { type: string; quality?: number }) {
          counters.encode += 1;
          counters.activeEncodes += 1;
          counters.maxActiveEncodes = Math.max(counters.maxActiveEncodes, counters.activeEncodes);
          counters.encodeOptions.push(options);
          observe(`page:${sourcePage}:encode:start`);
          try {
            if (configuration.encodeErrorPage === sourcePage) {
              throw new Error("encode fixture failure");
            }
            const definition = configuration.blobByPage?.[sourcePage];
            if (definition !== undefined) {
              return {
                type: definition.type ?? options.type,
                size: definition.size ?? 1,
                arrayBuffer: definition.arrayBuffer,
              } as Blob;
            }
            const bytes = configuration.encodedBytesByPage?.[sourcePage] ?? JPEG_BYTES;
            return {
              type: options.type,
              size: bytes.byteLength,
              async arrayBuffer() {
                observe(`page:${sourcePage}:blob:read`);
                return bytes.slice().buffer;
              },
            } as Blob;
          } finally {
            counters.activeEncodes -= 1;
            observe(`page:${sourcePage}:encode:end`);
          }
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
          observe(`page:${sourcePage}:fill`);
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
          observe(`page:${sourcePage}:canvas:destroy`);
        },
      };
    },
  };

  return { adapter, counters, renderStarted };
}

interface FakeAssemblerConfiguration {
  candidate?: ArrayBuffer;
  createError?: unknown;
  addErrorPage?: number;
  serializeError?: unknown;
  pageCountOverride?: number;
  pageCountError?: unknown;
  destroyError?: unknown;
  observer?: (event: string) => void;
}

interface FakeAssemblerCounters {
  create: number;
  add: number;
  serialize: number;
  destroy: number;
  activeAdds: number;
  maxActiveAdds: number;
  embedded: Array<{ bytes: ArrayBuffer; widthPoints: number; heightPoints: number }>;
  pageSizes: Array<{ widthPoints: number; heightPoints: number }>;
  retainedBytes: ArrayBuffer | undefined;
}

function fakeAssemblerFactory(configuration: FakeAssemblerConfiguration = {}): {
  factory: PdfCompressScannedAssemblerFactory;
  counters: FakeAssemblerCounters;
} {
  const counters: FakeAssemblerCounters = {
    create: 0,
    add: 0,
    serialize: 0,
    destroy: 0,
    activeAdds: 0,
    maxActiveAdds: 0,
    embedded: [],
    pageSizes: [],
    retainedBytes: undefined,
  };
  let pageCount = 0;
  const assembler: PdfCompressScannedAssembler = {
    get pageCount() {
      if (configuration.pageCountError !== undefined) throw configuration.pageCountError;
      return configuration.pageCountOverride ?? pageCount;
    },
    async addJpegPage(input) {
      counters.add += 1;
      counters.activeAdds += 1;
      counters.maxActiveAdds = Math.max(counters.maxActiveAdds, counters.activeAdds);
      configuration.observer?.(`assembler:add:${counters.add}:start`);
      try {
        if (configuration.addErrorPage === counters.add) {
          throw new Error("assembler add fixture failure");
        }
        counters.retainedBytes = input.bytes;
        counters.embedded.push(input);
        counters.pageSizes.push({
          widthPoints: input.widthPoints,
          heightPoints: input.heightPoints,
        });
        pageCount += 1;
      } finally {
        counters.activeAdds -= 1;
        configuration.observer?.(`assembler:add:${counters.add}:end`);
      }
    },
    async serialize() {
      counters.serialize += 1;
      configuration.observer?.("assembler:serialize");
      if (configuration.serializeError !== undefined) throw configuration.serializeError;
      return configuration.candidate ?? completePdfBytes(512);
    },
    destroy() {
      counters.destroy += 1;
      counters.retainedBytes = undefined;
      counters.embedded.length = 0;
      configuration.observer?.("assembler:destroy");
      if (configuration.destroyError !== undefined) throw configuration.destroyError;
    },
  };
  return {
    counters,
    factory: {
      async create() {
        counters.create += 1;
        configuration.observer?.("assembler:create");
        if (configuration.createError !== undefined) throw configuration.createError;
        return assembler;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPdfCompressScannedPipeline output", () => {
  it("returns a smaller structure-preserving v2 result without opening PDF.js", async () => {
    const input = await structureOptimizablePdfInput();
    const { adapter, counters: raster } = fakeRasterAdapter();

    const result = await runPdfCompressScannedPipeline(input, smartSpec(), {
      rasterAdapter: adapter,
      now: tickingNow(),
    });

    expect(result).toMatchObject({
      mode: "structure-preserving",
      sourceByteLength: input.byteLength,
      pageCount: 1,
      warnings: ["SIGNATURES_INVALIDATED"],
    });
    expect(result.byteLength).toBeLessThanOrEqual(
      input.byteLength - Math.ceil(input.byteLength / 100),
    );
    expect(raster.events).not.toContain("session:open");
    expect(result).not.toHaveProperty("preset");
  });

  it("preserves a structured v2 document when the structural pass cannot reduce it", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pageSignals: { 1: { nonWhitespaceTextItems: 1 } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), smartSpec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
        structureOptimizer: { optimize: async () => undefined },
      }),
    ).rejects.toMatchObject({ code: "NO_SIZE_REDUCTION", retryable: false });
    expect(raster.render).toBe(0);
    expect(assembler.create).toBe(0);
  });

  it("keeps the bounded raster fallback for an image-only v2 document", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter();
    const { factory } = fakeAssemblerFactory({ candidate: completePdfBytes(900) });

    const result = await runPdfCompressScannedPipeline(pdfInput(10_000), smartSpec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
      structureOptimizer: { optimize: async () => undefined },
    });

    expect(result).toMatchObject({ mode: "rasterized", preset: "balanced", dpi: 150, quality: 72 });
    expect(raster.render).toBe(2);
  });

  it("reconstructs all pages into a smaller metadata-free PDF result", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter();
    const candidate = completePdfBytes(900);
    const { factory, counters: assembler } = fakeAssemblerFactory({ candidate });
    const progress: Array<{ phase: string; fraction: number }> = [];

    const result = await runPdfCompressScannedPipeline(pdfInput(10_000), spec("balanced"), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
      now: tickingNow(),
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result).toMatchObject({
      bytes: candidate,
      suggestedName: "report-compressed-hereisit.pdf",
      mime: "application/pdf",
      sourceByteLength: 10_000,
      byteLength: 900,
      pageCount: 2,
      preset: "balanced",
      dpi: 150,
      quality: 72,
      warnings: [
        "PDF_PAGES_RASTERIZED",
        "SEARCHABLE_CONTENT_REMOVED",
        "INTERACTIVE_CONTENT_REMOVED",
        "SIGNATURES_INVALIDATED",
        "COLOR_PROFILE_NORMALIZED",
      ],
      timing: {
        loadMs: expect.any(Number),
        renderMs: expect.any(Number),
        encodeMs: expect.any(Number),
        assembleMs: expect.any(Number),
        serializeMs: expect.any(Number),
        totalMs: expect.any(Number),
      },
    });
    expect(result.bytes).toBe(candidate);
    expect(result.byteLength).toBeLessThanOrEqual(9_900);
    expect(progress.map(({ phase }) => phase)).toEqual([
      "validating",
      "loading",
      "rendering",
      "encoding",
      "assembling",
      "rendering",
      "encoding",
      "assembling",
      "serializing",
      "finalizing",
    ]);
    const fractions = progress.map(({ fraction }) => fraction);
    expect(fractions).toEqual([...fractions].sort((left, right) => left - right));
    expect(progress.at(-1)).toEqual({ phase: "finalizing", fraction: 1 });
    expect(raster).toMatchObject({
      pageCleanup: 4,
      canvasDestroy: 2,
      activePages: 0,
      activeCanvases: 0,
      activeRenders: 0,
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
    expect(assembler).toMatchObject({ create: 1, add: 2, serialize: 1, destroy: 1 });
    expect(assembler.retainedBytes).toBeUndefined();
  });

  it("accepts a candidate exactly at the strict one-percent target", async () => {
    const { adapter } = fakeRasterAdapter({ pages: [{ widthPoints: 72, heightPoints: 72 }] });
    const candidate = completePdfBytes(9_900);
    const { factory } = fakeAssemblerFactory({ candidate });

    const result = await runPdfCompressScannedPipeline(pdfInput(10_000), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    expect(result.bytes).toBe(candidate);
    expect(result.byteLength).toBe(9_900);
  });

  it("rejects a candidate one byte above the strict target", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
    });
    const { factory, counters: assembler } = fakeAssemblerFactory({
      candidate: completePdfBytes(9_901),
    });

    await expect(
      runPdfCompressScannedPipeline(pdfInput(10_000), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "NO_SIZE_REDUCTION", retryable: false });
    expect(raster.documentCleanup).toBe(1);
    expect(assembler.destroy).toBe(1);
  });

  it.each([
    { preset: "balanced" as const, dpi: 150, quality: 0.72, width: 251, height: 126 },
    { preset: "minimum" as const, dpi: 96, quality: 0.55, width: 161, height: 81 },
  ])("uses the fixed $preset raster and JPEG settings", async ({
    preset,
    dpi,
    quality,
    width,
    height,
  }) => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 120.25, heightPoints: 60.125 }],
    });
    const { factory } = fakeAssemblerFactory();

    const result = await runPdfCompressScannedPipeline(pdfInput(), spec(preset), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    expect(result).toMatchObject({ preset, dpi, quality: Math.round(quality * 100) });
    expect(raster.encodeOptions).toEqual([{ type: "image/jpeg", quality }]);
    expect(raster.fills).toEqual([{ fillStyle: "#ffffff", x: 0, y: 0, width, height }]);
    expect(raster.renderBackgrounds).toEqual(["#ffffff"]);
  });

  it("preserves scale-1 visible CropBox/UserUnit geometry, 90/270 orientation, and fractional points", async () => {
    const pages = [
      { widthPoints: 456.75, heightPoints: 612.125 },
      { widthPoints: 300.5, heightPoints: 500.25, rotation: 90 },
      { widthPoints: 500.375, heightPoints: 300.625, rotation: 270 },
    ];
    const { adapter, counters: raster } = fakeRasterAdapter({ pages });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await runPdfCompressScannedPipeline(pdfInput(), spec("minimum"), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    expect(raster.viewportOptions).toEqual([
      { sourcePage: 1, scale: 1 },
      { sourcePage: 2, scale: 1 },
      { sourcePage: 3, scale: 1 },
      { sourcePage: 1, scale: 96 / 72 },
      { sourcePage: 2, scale: 96 / 72 },
      { sourcePage: 3, scale: 96 / 72 },
    ]);
    expect(raster.fills.map(({ width, height }) => ({ width, height }))).toEqual(
      pages.map((page) => ({
        width: Math.ceil((page.widthPoints * 96) / 72),
        height: Math.ceil((page.heightPoints * 96) / 72),
      })),
    );
    expect(assembler.embedded).toEqual([]);
    expect(assembler.pageSizes).toEqual(
      pages.map(({ widthPoints, heightPoints }) => ({ widthPoints, heightPoints })),
    );
  });

  it("uses the real assembler for exact fractional point pages with fixed metadata and zero rotation", async () => {
    const pages = [
      { widthPoints: 120.25, heightPoints: 60.125, rotation: 90 },
      { widthPoints: 60.375, heightPoints: 120.875, rotation: 270 },
    ];
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages,
      encodedBytesByPage: { 1: JPEG_BYTES, 2: JPEG_BYTES },
    });

    const result = await runPdfCompressScannedPipeline(pdfInput(100_000), spec("minimum"), {
      rasterAdapter: adapter,
    });
    const document = await PDFDocument.load(result.bytes, { updateMetadata: false });

    expect(document.getPageCount()).toBe(2);
    expect(document.getCreator()).toBe("HereIsIt");
    expect(document.getProducer()).toBe("HereIsIt");
    expect(document.getTitle()).toBeUndefined();
    expect(document.getAuthor()).toBeUndefined();
    expect(document.getCreationDate()).toBeUndefined();
    expect(document.getModificationDate()).toBeUndefined();
    expect(document.getPages().map((page) => page.getRotation().angle)).toEqual([0, 0]);
    pages.forEach((expectedPage, index) => {
      const page = document.getPage(index);
      expect(page.getWidth()).toBeCloseTo(expectedPage.widthPoints, 8);
      expect(page.getHeight()).toBeCloseTo(expectedPage.heightPoints, 8);
    });
    expect(new TextDecoder().decode(result.bytes)).not.toContain("SOURCE_TITLE");
    expect(new TextDecoder().decode(result.bytes)).not.toContain("SOURCE_AUTHOR");
    expect(raster.documentCleanup).toBe(1);
  });

  it("reuses the exact full-span ArrayBuffer returned by the real assembler save", async () => {
    const { adapter } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
      encodedBytesByPage: { 1: JPEG_BYTES },
    });
    const backing = completePdfBytes(700);
    vi.spyOn(PDFDocument.prototype, "save").mockResolvedValueOnce(new Uint8Array(backing));

    const result = await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
    });

    expect(result.bytes).toBe(backing);
  });
});

describe("runPdfCompressScannedPipeline sequencing and byte gates", () => {
  it("plans every scale-1 viewport before the first canvas and processes one page at a time", async () => {
    const events: string[] = [];
    const observer = (event: string) => events.push(event);
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [
        { widthPoints: 72, heightPoints: 72 },
        { widthPoints: 144, heightPoints: 72 },
        { widthPoints: 72, heightPoints: 144 },
      ],
      observer,
    });
    const { factory, counters: assembler } = fakeAssemblerFactory({ observer });

    await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    const firstCanvas = events.indexOf("page:1:canvas:create");
    expect(firstCanvas).toBeGreaterThan(-1);
    expect(events.slice(0, firstCanvas)).toEqual([
      "session:open",
      "page:1:acquire",
      "page:1:viewport:1",
      "page:1:cleanup",
      "page:2:acquire",
      "page:2:viewport:1",
      "page:2:cleanup",
      "page:3:acquire",
      "page:3:viewport:1",
      "page:3:cleanup",
      "assembler:create",
      "page:1:acquire",
      `page:1:viewport:${150 / 72}`,
    ]);
    expect(events.indexOf("page:2:canvas:create")).toBeGreaterThan(
      events.indexOf("page:1:canvas:destroy"),
    );
    expect(events.indexOf("page:3:canvas:create")).toBeGreaterThan(
      events.indexOf("page:2:canvas:destroy"),
    );
    expect(raster).toMatchObject({
      maxActivePages: 1,
      maxActiveCanvases: 1,
      maxActiveRenders: 1,
      maxActiveEncodes: 1,
      activePages: 0,
      activeCanvases: 0,
      activeRenders: 0,
      activeEncodes: 0,
    });
    expect(assembler.maxActiveAdds).toBe(1);
  });

  it("ignores observer exceptions without changing a valid result", async () => {
    const { adapter } = fakeRasterAdapter({ pages: [{ widthPoints: 72, heightPoints: 72 }] });
    const { factory } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
        onProgress() {
          throw new Error("observer fixture failure");
        },
      }),
    ).resolves.toMatchObject({ mime: "application/pdf", pageCount: 1 });
  });

  it("rejects an advertised JPEG above the remaining target before materializing it", async () => {
    const arrayBuffer = vi.fn(async () => jpegBytes(9_901).buffer);
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [
        { widthPoints: 72, heightPoints: 72 },
        { widthPoints: 72, heightPoints: 72 },
      ],
      blobByPage: { 1: { size: 9_901, arrayBuffer } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(10_000), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "NO_SIZE_REDUCTION", retryable: false });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(raster.getPage).toBe(3);
    expect(raster.createCanvas).toBe(1);
    expect(raster.canvasDestroy).toBe(1);
    expect(raster.pageCleanup).toBe(3);
    expect(assembler.add).toBe(0);
    expect(assembler.serialize).toBe(0);
    expect(assembler.destroy).toBe(1);
  });

  it("applies the advertised-size gate to the cumulative remaining target", async () => {
    const firstBytes = jpegBytes(6_000);
    const secondRead = vi.fn(async () => jpegBytes(3_901).buffer);
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [
        { widthPoints: 72, heightPoints: 72 },
        { widthPoints: 72, heightPoints: 72 },
      ],
      encodedBytesByPage: { 1: firstBytes },
      blobByPage: { 2: { size: 3_901, arrayBuffer: secondRead } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(10_000), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "NO_SIZE_REDUCTION" });
    expect(secondRead).not.toHaveBeenCalled();
    expect(raster.createCanvas).toBe(2);
    expect(assembler.add).toBe(1);
    expect(assembler.serialize).toBe(0);
  });

  it("rejects hostile materialized JPEG bytes that exceed the advertised remaining target", async () => {
    const arrayBuffer = vi.fn(async () => jpegBytes(9_901).buffer);
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [
        { widthPoints: 72, heightPoints: 72 },
        { widthPoints: 72, heightPoints: 72 },
      ],
      blobByPage: { 1: { size: 100, arrayBuffer } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(10_000), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "NO_SIZE_REDUCTION" });
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(raster.getPage).toBe(3);
    expect(assembler.add).toBe(0);
    expect(assembler.serialize).toBe(0);
  });
});

describe("runPdfCompressScannedPipeline validation and failure mapping", () => {
  it.each([
    { name: "wrong version", rawSpec: { version: 3, preset: "balanced" } },
    { name: "unknown preset", rawSpec: { version: 1, preset: "custom" } },
    { name: "unknown field", rawSpec: { version: 1, preset: "balanced", dpi: 300 } },
  ])("maps $name to INVALID_SPEC before opening a session", async ({ rawSpec }) => {
    const { adapter, counters: raster } = fakeRasterAdapter();
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), rawSpec, {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SPEC", retryable: false });
    expect(raster.events).toEqual([]);
    expect(assembler.create).toBe(0);
  });

  it.each([
    {
      name: "mismatched byte length",
      input: () => pdfInput(100, { byteLength: 99 }),
      code: "CORRUPT_PDF",
    },
    {
      name: "unsupported MIME and extension",
      input: () => pdfInput(100, { name: "report.bin", mimeHint: "application/octet-stream" }),
      code: "UNSUPPORTED_INPUT",
    },
    {
      name: "missing PDF signature",
      input: () => {
        const bytes = new Uint8Array(100).buffer;
        return pdfInput(100, { bytes, byteLength: bytes.byteLength });
      },
      code: "UNSUPPORTED_INPUT",
    },
  ])("maps $name to $code before opening a session", async ({ input, code }) => {
    const { adapter, counters: raster } = fakeRasterAdapter();

    await expect(
      runPdfCompressScannedPipeline(input(), spec(), { rasterAdapter: adapter }),
    ).rejects.toMatchObject({ code });
    expect(raster.events).toEqual([]);
  });

  it.each([
    ["password", new FakePdfLoadError("PASSWORD_PROTECTED"), "PASSWORD_PROTECTED", false],
    ["corrupt", new FakePdfLoadError("CORRUPT_PDF"), "CORRUPT_PDF", false],
    [
      "parser crash",
      new PdfRasterRuntimeError("WORKER_CRASH", "PDF 렌더러 작업기가 중단됐어요.", true),
      "WORKER_CRASH",
      true,
    ],
  ] as const)("maps a %s load failure to %s", async (_name, loadError, code, retryable) => {
    const { adapter, counters: raster } = fakeRasterAdapter({ loadError });

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), { rasterAdapter: adapter }),
    ).rejects.toMatchObject({ code, retryable });
    expect(raster).toMatchObject({
      documentCleanup: 0,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
  });

  it.each([
    { pageCount: 0, code: "PAGE_LIMIT" },
    { pageCount: 101, code: "PAGE_LIMIT" },
  ])("maps source page count $pageCount to $code", async ({ pageCount, code }) => {
    const { adapter, counters: raster } = fakeRasterAdapter({ sourcePageCount: pageCount });

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), { rasterAdapter: adapter }),
    ).rejects.toMatchObject({ code });
    expect(raster.getPage).toBe(0);
    expect(raster.documentCleanup).toBe(1);
  });

  it("maps an unsafe raster plan to MEMORY_LIMIT before creating an assembler or canvas", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 4_000, heightPoints: 4_000 }],
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "MEMORY_LIMIT" });
    expect(raster.pageCleanup).toBe(1);
    expect(raster.createCanvas).toBe(0);
    expect(assembler.create).toBe(0);
  });

  it("accepts PDF.js Letter viewport floating-point noise and renders the planned integer canvas", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 612, heightPoints: 792 }],
      rasterViewportByPage: { 1: { width: 1275, height: 1650.0000000000002 } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    expect(raster.createCanvas).toBe(1);
    expect(raster.fills).toEqual([{ fillStyle: "#ffffff", x: 0, y: 0, width: 1275, height: 1650 }]);
    expect(raster.render).toBe(1);
    expect(raster.encode).toBe(1);
    expect(assembler.add).toBe(1);
    expect(assembler.destroy).toBe(1);
  });

  it("accepts a positive overshoot within the bounded 8-ULP normalized tolerance", async () => {
    const plannedWidth = 100;
    const withinTolerance = plannedWidth + Number.EPSILON * plannedWidth * 8;
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 48, heightPoints: 72 }],
      rasterViewportByPage: { 1: { width: withinTolerance, height: 150 } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    expect(withinTolerance).toBeGreaterThan(plannedWidth);
    expect(Math.ceil(withinTolerance)).toBe(plannedWidth + 1);
    expect(raster.createCanvas).toBe(1);
    expect(raster.render).toBe(1);
    expect(raster.encode).toBe(1);
    expect(assembler.add).toBe(1);
  });

  it.each([
    { name: "below", actualWidth: 99.25 },
    { name: "equal", actualWidth: 100 },
  ])("retains ordinary ceil acceptance for a $name planned integer viewport", async ({
    actualWidth,
  }) => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 48, heightPoints: 72 }],
      rasterViewportByPage: { 1: { width: actualWidth, height: 150 } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    });

    expect(Math.ceil(actualWidth)).toBe(100);
    expect(raster.createCanvas).toBe(1);
    expect(raster.render).toBe(1);
    expect(raster.encode).toBe(1);
    expect(assembler.add).toBe(1);
  });

  it.each([
    { name: "material positive overshoot", actualWidth: 100 + 1e-9 },
    { name: "full one-pixel drift", actualWidth: 101 },
  ])("rejects a $name before allocating a canvas", async ({ actualWidth }) => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 48, heightPoints: 72 }],
      rasterViewportByPage: { 1: { width: actualWidth, height: 150 } },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "MEMORY_LIMIT", retryable: false });
    expect(raster.createCanvas).toBe(0);
    expect(raster.render).toBe(0);
    expect(raster.encode).toBe(0);
    expect(assembler.add).toBe(0);
    expect(assembler.destroy).toBe(1);
  });

  it("maps render failure and stops before encoding or later-page processing", async () => {
    const { adapter, counters: raster } = fakeRasterAdapter({ renderErrorPage: 1 });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "RENDER_FAILED" });
    expect(raster.getPage).toBe(3);
    expect(raster.encode).toBe(0);
    expect(raster.canvasDestroy).toBe(1);
    expect(raster.pageCleanup).toBe(3);
    expect(assembler.add).toBe(0);
    expect(assembler.destroy).toBe(1);
  });

  it.each([
    {
      name: "canvas encoder rejection",
      configuration: { encodeErrorPage: 1 },
    },
    {
      name: "wrong JPEG MIME",
      configuration: {
        blobByPage: {
          1: {
            type: "image/png",
            size: JPEG_BYTES.byteLength,
            arrayBuffer: async () => JPEG_BYTES.slice().buffer,
          },
        },
      },
    },
    {
      name: "invalid JPEG signature",
      configuration: {
        encodedBytesByPage: { 1: Uint8Array.of(1, 2, 3, 4) },
      },
    },
    {
      name: "Blob read rejection",
      configuration: {
        blobByPage: {
          1: {
            size: JPEG_BYTES.byteLength,
            arrayBuffer: async () => {
              throw new Error("blob read fixture failure");
            },
          },
        },
      },
    },
  ] satisfies Array<{
    name: string;
    configuration: FakeRasterConfiguration;
  }>)("maps $name to ENCODE_FAILED and cleans the current page and canvas", async ({
    configuration,
  }) => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
      ...configuration,
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "ENCODE_FAILED" });
    expect(raster.canvasDestroy).toBe(1);
    expect(raster.pageCleanup).toBe(2);
    expect(raster.documentCleanup).toBe(1);
    expect(assembler.add).toBe(0);
    expect(assembler.destroy).toBe(1);
  });

  it.each([
    { name: "factory creation", configuration: { createError: new Error("create failure") } },
    { name: "JPEG embedding", configuration: { addErrorPage: 1 } },
    { name: "serialization", configuration: { serializeError: new Error("save failure") } },
    { name: "assembler page count", configuration: { pageCountOverride: 0 } },
    {
      name: "assembler page count read",
      configuration: { pageCountError: new Error("page count failure") },
    },
  ] satisfies Array<{
    name: string;
    configuration: FakeAssemblerConfiguration;
  }>)("maps $name failure to ASSEMBLY_FAILED with no partial result", async ({ configuration }) => {
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
    });
    const { factory, counters: assembler } = fakeAssemblerFactory(configuration);

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "ASSEMBLY_FAILED", retryable: false });
    expect(raster.documentCleanup).toBe(1);
    expect(raster.loadingTaskDestroy).toBe(1);
    expect(assembler.destroy).toBe(configuration.createError === undefined ? 1 : 0);
    expect(assembler.retainedBytes).toBeUndefined();
  });

  it.each([
    {
      name: "missing PDF signature",
      candidate: (() => {
        const bytes = new Uint8Array(100);
        bytes.set(new TextEncoder().encode("not-pdf"));
        bytes.set(new TextEncoder().encode("%%EOF"), 95);
        return bytes.buffer;
      })(),
    },
    { name: "missing final EOF", candidate: new TextEncoder().encode("%PDF-1.7\nno eof").buffer },
  ])("rejects a serialized candidate with $name as ASSEMBLY_FAILED", async ({ candidate }) => {
    const { adapter } = fakeRasterAdapter({ pages: [{ widthPoints: 72, heightPoints: 72 }] });
    const { factory, counters: assembler } = fakeAssemblerFactory({ candidate });

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "ASSEMBLY_FAILED" });
    expect(assembler.destroy).toBe(1);
  });

  it.each([
    "partial",
    "shared",
  ] as const)("maps an unexpected %s default serialization buffer to ASSEMBLY_FAILED", async (kind) => {
    const { adapter } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
      encodedBytesByPage: { 1: JPEG_BYTES },
    });
    const saved =
      kind === "partial"
        ? new Uint8Array(completePdfBytes(101), 1, 100)
        : new Uint8Array(new SharedArrayBuffer(100));
    vi.spyOn(PDFDocument.prototype, "save").mockResolvedValueOnce(saved as Uint8Array<ArrayBuffer>);

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), { rasterAdapter: adapter }),
    ).rejects.toMatchObject({ code: "ASSEMBLY_FAILED" });
  });

  it("maps only bounded typed failures into public error payloads", () => {
    expect(
      toPdfCompressScannedErrorPayload(
        new PdfCompressScannedPipelineError("NO_SIZE_REDUCTION", "더 작게 만들지 못했어요."),
      ),
    ).toEqual({
      code: "NO_SIZE_REDUCTION",
      message: "더 작게 만들지 못했어요.",
      retryable: false,
    });
    expect(toPdfCompressScannedErrorPayload(new Error("private filename and URL"))).toEqual({
      code: "WORKER_CRASH",
      message: "PDF 압축 작업을 완료하지 못했어요.",
      retryable: true,
    });
  });

  it("never exposes a private raster WORKER_CRASH message through the public payload", async () => {
    const sentinel = "PRIVATE_FILENAME_PARSER_URL_SENTINEL";
    const privateMessage = sentinel.repeat(100);
    const { adapter } = fakeRasterAdapter({
      loadError: new PdfRasterRuntimeError("WORKER_CRASH", privateMessage, true),
    });

    const error = await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
    }).catch((failure: unknown) => failure);
    const payload = toPdfCompressScannedErrorPayload(error);

    expect(payload).toEqual({
      code: "WORKER_CRASH",
      message: "PDF 압축 작업을 완료하지 못했어요.",
      retryable: true,
    });
    expect(payload.message).not.toContain(sentinel);
    expect(
      toPdfCompressScannedErrorPayload(
        new PdfCompressScannedPipelineError("WORKER_CRASH", privateMessage, false),
      ),
    ).toEqual({
      code: "WORKER_CRASH",
      message: "PDF 압축 작업을 완료하지 못했어요.",
      retryable: false,
    });
  });
});

describe("runPdfCompressScannedPipeline cancellation and cleanup", () => {
  it("rejects a pre-aborted request before opening or assembling", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, counters: raster } = fakeRasterAdapter();
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(raster.events).toEqual([]);
    expect(assembler.create).toBe(0);
  });

  it("cancels an active render and destroys every acquired resource exactly once", async () => {
    const controller = new AbortController();
    const { adapter, counters: raster, renderStarted } = fakeRasterAdapter({ blockRenderPage: 1 });
    const { factory, counters: assembler } = fakeAssemblerFactory();
    const result = runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
      signal: controller.signal,
    });

    await renderStarted;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(raster).toMatchObject({
      renderCancel: 1,
      activeRenders: 0,
      activeCanvases: 0,
      activePages: 0,
      canvasDestroy: 1,
      pageCleanup: 3,
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
    expect(assembler).toMatchObject({ add: 0, serialize: 0, destroy: 1 });
    expect(assembler.retainedBytes).toBeUndefined();
  });

  it("checks cancellation after rendering before encoding and returns no partial result", async () => {
    const controller = new AbortController();
    const { adapter, counters: raster } = fakeRasterAdapter({
      observer(event) {
        if (event === "page:1:render:end") controller.abort();
      },
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(raster.encode).toBe(0);
    expect(raster.getPage).toBe(3);
    expect(assembler.add).toBe(0);
    expect(assembler.serialize).toBe(0);
    expect(assembler.destroy).toBe(1);
  });

  it("continues session cleanup when assembler destroy throws after a successful result", async () => {
    const cleanupSentinel = new Error("PRIVATE_ASSEMBLER_CLEANUP_SENTINEL");
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
    });
    const { factory, counters: assembler } = fakeAssemblerFactory({
      destroyError: cleanupSentinel,
    });

    await expect(
      runPdfCompressScannedPipeline(pdfInput(), spec(), {
        rasterAdapter: adapter,
        assemblerFactory: factory,
      }),
    ).resolves.toMatchObject({ mime: "application/pdf", pageCount: 1 });
    expect(assembler.destroy).toBe(1);
    expect(raster).toMatchObject({
      documentCleanup: 1,
      loadingTaskDestroy: 1,
      pdfWorkerDestroy: 1,
      parserPortTerminate: 1,
      parserFailureListenerRemove: 1,
    });
  });

  it.each([
    { name: "success", encodeErrorPage: undefined, expectedCode: undefined },
    { name: "selected failure", encodeErrorPage: 1, expectedCode: "ENCODE_FAILED" },
  ])("does not let a raster-session cleanup throw replace $name and still destroys the assembler", async ({
    encodeErrorPage,
    expectedCode,
  }) => {
    const cleanupSentinel = "PRIVATE_SESSION_CLEANUP_SENTINEL";
    const { adapter, counters: raster } = fakeRasterAdapter({
      pages: [{ widthPoints: 72, heightPoints: 72 }],
      ...(encodeErrorPage === undefined ? {} : { encodeErrorPage }),
      sessionCloseError: new Error(cleanupSentinel),
    });
    const { factory, counters: assembler } = fakeAssemblerFactory();

    const outcome = await runPdfCompressScannedPipeline(pdfInput(), spec(), {
      rasterAdapter: adapter,
      assemblerFactory: factory,
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    if (expectedCode === undefined) {
      expect(outcome).toMatchObject({
        status: "fulfilled",
        value: { mime: "application/pdf", pageCount: 1 },
      });
    } else {
      expect(outcome).toMatchObject({ status: "rejected", error: { code: expectedCode } });
      expect(
        toPdfCompressScannedErrorPayload((outcome as { error: unknown }).error).message,
      ).not.toContain(cleanupSentinel);
    }
    expect(assembler.destroy).toBe(1);
    expect(raster).toMatchObject({
      documentCleanup: 0,
      loadingTaskDestroy: 0,
      pdfWorkerDestroy: 0,
      parserPortTerminate: 0,
      parserFailureListenerRemove: 0,
    });
  });
});
