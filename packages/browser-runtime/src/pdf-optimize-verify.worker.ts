/// <reference lib="webworker" />

import { PDFDocument } from "@cantoo/pdf-lib";
import {
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  PDF_OPTIMIZE_MAX_PAGES,
  type PdfOptimizeErrorPayload,
  type PdfOptimizeResultDescriptor,
  pdfOptimizeResultDescriptorSchema,
} from "@hereisit/tool-contracts/pdf-optimize";
import { openPdfRasterSession } from "./pdf-raster-runtime";

const PUBLIC_ERROR: PdfOptimizeErrorPayload = {
  code: "VERIFICATION_FAILED",
  message: "PDF 처리 결과를 확인할 수 없습니다.",
  retryable: true,
};
const PROTOCOL = 1;
const MAX_VISUAL_SAMPLES = 1_024;
const MAX_MEAN_VISUAL_DELTA = 32;

export interface PdfSemanticPage {
  readonly mediaBox: readonly [number, number, number, number];
  readonly cropBox: readonly [number, number, number, number];
  readonly rotation: number;
  readonly textItemCount: number;
  readonly annotationClasses: readonly string[];
  readonly operators: {
    readonly image: number;
    readonly text: number;
    readonly vector: number;
    readonly other: number;
  };
}

export interface PdfVisualFingerprint {
  readonly samples: readonly number[];
  readonly nonWhiteFraction: number;
}

export interface PdfVerificationInspection {
  readonly pages: readonly PdfSemanticPage[];
  readonly renderPage?: (page: number) => Promise<PdfVisualFingerprint>;
  close(): Promise<void> | void;
}

export interface PdfVerificationDependencies {
  inspect(bytes: ArrayBuffer, signal: AbortSignal): Promise<PdfVerificationInspection>;
  render(inspection: PdfVerificationInspection, page: number): Promise<PdfVisualFingerprint>;
}

function fail(): never {
  throw { ...PUBLIC_ERROR };
}

function box(value: {
  x: number;
  y: number;
  width: number;
  height: number;
}): [number, number, number, number] {
  const result: [number, number, number, number] = [
    value.x,
    value.y,
    value.x + value.width,
    value.y + value.height,
  ];
  if (result.some((part) => !Number.isFinite(part))) fail();
  return result;
}

function annotationClass(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  for (const key of ["subtype", "annotationType"] as const) {
    if (key in value) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(candidate))
        return candidate;
      if (typeof candidate === "number" && Number.isSafeInteger(candidate))
        return String(candidate);
    }
  }
  return "unknown";
}

function operatorSummary(fnArray: readonly number[]): PdfSemanticPage["operators"] {
  const imageOps = new Set([83, 84, 85, 86, 87, 88, 89]);
  const textOps = new Set([37, 38, 39, 40, 41, 42, 43, 44]);
  const vectorOps = new Set([62, 66, 80, 90, 91]);
  const result = { image: 0, text: 0, vector: 0, other: 0 };
  for (const operation of fnArray.slice(0, 100_000)) {
    if (imageOps.has(operation)) result.image += 1;
    else if (textOps.has(operation)) result.text += 1;
    else if (vectorOps.has(operation)) result.vector += 1;
    else result.other += 1;
  }
  return result;
}

function fingerprint(
  context: { getImageData(x: number, y: number, width: number, height: number): ImageData },
  width: number,
  height: number,
): PdfVisualFingerprint {
  const samples: number[] = [];
  let nonWhite = 0;
  const side = Math.floor(Math.sqrt(MAX_VISUAL_SAMPLES));
  for (let row = 0; row < side; row += 1) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / side));
    const pixels = context.getImageData(0, y, width, 1).data;
    for (let column = 0; column < side; column += 1) {
      const x = Math.min(width - 1, Math.floor(((column + 0.5) * width) / side));
      const offset = x * 4;
      const gray = Math.round(
        ((pixels[offset] ?? 255) + (pixels[offset + 1] ?? 255) + (pixels[offset + 2] ?? 255)) / 3,
      );
      samples.push(gray);
      if (gray < 248) nonWhite += 1;
    }
  }
  return { samples, nonWhiteFraction: nonWhite / samples.length };
}

async function defaultInspect(
  bytes: ArrayBuffer,
  signal: AbortSignal,
): Promise<PdfVerificationInspection> {
  const structure = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    parseSpeed: 100,
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  const session = await openPdfRasterSession({ bytes }, { signal });
  try {
    if (structure.getPageCount() !== session.pageCount) fail();
    const pages: PdfSemanticPage[] = [];
    for (let number = 1; number <= session.pageCount; number += 1) {
      if (signal.aborted) fail();
      const structured = structure.getPage(number - 1);
      pages.push(
        await session.withPage(number, async (raster) => {
          if (
            raster.getTextContent === undefined ||
            raster.getAnnotations === undefined ||
            raster.getOperatorList === undefined
          )
            fail();
          const [text, annotations, operators] = await Promise.all([
            raster.getTextContent(),
            raster.getAnnotations({ intent: "any" }),
            raster.getOperatorList({ intent: "display" }),
          ]);
          return {
            mediaBox: box(structured.getMediaBox()),
            cropBox: box(structured.getCropBox()),
            rotation: structured.getRotation().angle,
            textItemCount: text.items.filter(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                "str" in item &&
                typeof item.str === "string" &&
                item.str.trim().length > 0,
            ).length,
            annotationClasses: annotations.map(annotationClass).sort(),
            operators: operatorSummary(operators.fnArray),
          };
        }),
      );
    }
    return {
      pages,
      async renderPage(pageNumber) {
        return await session.withPage(pageNumber, async (page) => {
          const viewport = page.getViewport({ scale: 96 / 72 });
          const width = Math.ceil(viewport.width);
          const height = Math.ceil(viewport.height);
          return await session.withCanvas(width, height, async (canvas) => {
            await session.render(page, canvas, viewport, "#ffffff");
            const context = canvas.context as typeof canvas.context & {
              getImageData?(x: number, y: number, width: number, height: number): ImageData;
            };
            if (context.getImageData === undefined) fail();
            return fingerprint(
              context as typeof context & {
                getImageData(x: number, y: number, width: number, height: number): ImageData;
              },
              width,
              height,
            );
          });
        });
      },
      close: () => session.close(),
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

const defaultDependencies: PdfVerificationDependencies = {
  inspect: defaultInspect,
  async render(inspection, page) {
    if (inspection.renderPage === undefined) fail();
    return await inspection.renderPage(page);
  },
};

export function deterministicPdfSamples(pageCount: number): readonly number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PDF_OPTIMIZE_MAX_PAGES)
    fail();
  if (pageCount <= 5) return Array.from({ length: pageCount }, (_, index) => index + 1);
  return Array.from({ length: 5 }, (_, index) => Math.round(1 + ((pageCount - 1) * index) / 4));
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - (right[index] ?? NaN)) <= 0.01)
  );
}

export function comparePdfSemanticPages(
  source: readonly PdfSemanticPage[],
  result: readonly PdfSemanticPage[],
): void {
  if (source.length !== result.length) fail();
  for (let index = 0; index < source.length; index += 1) {
    const left = source[index];
    const right = result[index];
    if (
      left === undefined ||
      right === undefined ||
      !sameNumbers(left.mediaBox, right.mediaBox) ||
      !sameNumbers(left.cropBox, right.cropBox) ||
      left.rotation !== right.rotation ||
      left.textItemCount !== right.textItemCount ||
      JSON.stringify(left.annotationClasses) !== JSON.stringify(right.annotationClasses) ||
      JSON.stringify(left.operators) !== JSON.stringify(right.operators)
    ) {
      fail();
    }
  }
}

export function comparePdfVisualFingerprints(
  source: PdfVisualFingerprint,
  result: PdfVisualFingerprint,
): void {
  const sourceBlank = source.nonWhiteFraction <= 0.001;
  const resultBlank = result.nonWhiteFraction <= 0.001;
  if (
    source.samples.length < 1 ||
    source.samples.length !== result.samples.length ||
    (!sourceBlank && resultBlank) ||
    result.nonWhiteFraction < source.nonWhiteFraction * 0.35
  ) {
    fail();
  }
  const mean =
    source.samples.reduce(
      (total, value, index) => total + Math.abs(value - (result.samples[index] ?? 255)),
      0,
    ) / source.samples.length;
  if (!Number.isFinite(mean) || mean > MAX_MEAN_VISUAL_DELTA) fail();
}

function hasPdfEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < 14) return false;
  const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  const tail = new TextDecoder("ascii").decode(bytes.subarray(Math.max(0, bytes.length - 1_024)));
  return prefix === "%PDF-" && /%%EOF[\s\0]*$/.test(tail);
}

async function readFile(file: File, expected: number): Promise<ArrayBuffer> {
  if (
    !(file instanceof File) ||
    file.type !== "application/pdf" ||
    file.size !== expected ||
    expected < 1 ||
    expected > PDF_OPTIMIZE_MAX_FILE_BYTES
  ) {
    fail();
  }
  const bytes = await file.arrayBuffer();
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength !== expected ||
    !hasPdfEnvelope(new Uint8Array(bytes))
  )
    fail();
  return bytes;
}

export type PdfVerificationProgress = {
  readonly phase: "source" | "result" | "comparing";
  readonly fraction: number;
  readonly page: number | null;
};

type PdfVerificationSnapshot = {
  readonly pages: readonly PdfSemanticPage[];
  readonly visuals: ReadonlyMap<number, PdfVisualFingerprint>;
};

async function inspectFileSnapshot(input: {
  readonly file: File;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly profile: "structural" | "image-optimized";
  readonly phase: "source" | "result";
  readonly dependencies: PdfVerificationDependencies;
  readonly signal: AbortSignal;
  readonly progress?: (event: PdfVerificationProgress) => void;
}): Promise<PdfVerificationSnapshot> {
  input.progress?.({
    phase: input.phase,
    fraction: input.phase === "source" ? 0.05 : 0.5,
    page: null,
  });
  const bytes = await readFile(input.file, input.byteLength);
  const inspection = await input.dependencies.inspect(bytes, input.signal);
  try {
    if (inspection.pages.length !== input.pageCount) fail();
    const pages = inspection.pages.map((page) => ({
      mediaBox: [...page.mediaBox] as [number, number, number, number],
      cropBox: [...page.cropBox] as [number, number, number, number],
      rotation: page.rotation,
      textItemCount: page.textItemCount,
      annotationClasses: [...page.annotationClasses],
      operators: { ...page.operators },
    }));
    const visuals = new Map<number, PdfVisualFingerprint>();
    if (input.profile === "image-optimized") {
      const samples = deterministicPdfSamples(input.pageCount);
      for (let index = 0; index < samples.length; index += 1) {
        if (input.signal.aborted) fail();
        const page = samples[index] as number;
        const rendered = await input.dependencies.render(inspection, page);
        visuals.set(page, {
          samples: [...rendered.samples],
          nonWhiteFraction: rendered.nonWhiteFraction,
        });
        const start = input.phase === "source" ? 0.1 : 0.55;
        input.progress?.({
          phase: input.phase,
          fraction: start + ((index + 1) / samples.length) * 0.35,
          page,
        });
      }
    }
    return { pages, visuals };
  } finally {
    await inspection.close();
  }
}

export async function verifyPdfOptimizeFiles(
  sourceFile: File,
  resultFile: File,
  rawDescriptor: unknown,
  dependencies: PdfVerificationDependencies = defaultDependencies,
  signal = new AbortController().signal,
  progress?: (event: PdfVerificationProgress) => void,
): Promise<{
  readonly descriptor: Extract<PdfOptimizeResultDescriptor, { kind: "download" }>;
  readonly blob: Blob;
}> {
  try {
    const parsed = pdfOptimizeResultDescriptorSchema.safeParse(rawDescriptor);
    if (!parsed.success || parsed.data.kind !== "download") fail();
    const descriptor = parsed.data;
    if (descriptor.pageCount < 1 || descriptor.pageCount > PDF_OPTIMIZE_MAX_PAGES) fail();
    const source = await inspectFileSnapshot({
      file: sourceFile,
      byteLength: descriptor.sourceByteLength,
      pageCount: descriptor.pageCount,
      profile: descriptor.profile,
      phase: "source",
      dependencies,
      signal,
      ...(progress === undefined ? {} : { progress }),
    });
    const result = await inspectFileSnapshot({
      file: resultFile,
      byteLength: descriptor.byteLength,
      pageCount: descriptor.pageCount,
      profile: descriptor.profile,
      phase: "result",
      dependencies,
      signal,
      ...(progress === undefined ? {} : { progress }),
    });
    progress?.({ phase: "comparing", fraction: 0.95, page: null });
    comparePdfSemanticPages(source.pages, result.pages);
    if (descriptor.profile === "image-optimized") {
      for (const page of deterministicPdfSamples(descriptor.pageCount)) {
        const sourceVisual = source.visuals.get(page);
        const resultVisual = result.visuals.get(page);
        if (sourceVisual === undefined || resultVisual === undefined) fail();
        comparePdfVisualFingerprints(sourceVisual, resultVisual);
      }
    }
    if (signal.aborted) fail();
    return { descriptor, blob: resultFile };
  } catch {
    return fail();
  }
}

type ActiveJob = { readonly jobId: string; readonly controller: AbortController };
let active: ActiveJob | undefined;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

const workerScope = typeof self === "undefined" ? undefined : (self as DedicatedWorkerGlobalScope);
if (workerScope !== undefined && typeof workerScope.postMessage === "function") {
  workerScope.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      !isPlainRecord(message) ||
      message.protocol !== PROTOCOL ||
      typeof message.jobId !== "string"
    )
      return;
    if (message.type === "cancel" && exactKeys(message, ["protocol", "type", "jobId"])) {
      if (active?.jobId === message.jobId) active.controller.abort();
      return;
    }
    if (
      message.type !== "verify" ||
      !exactKeys(message, ["protocol", "type", "jobId", "source", "result", "descriptor"])
    )
      return;
    if (active !== undefined) {
      workerScope.postMessage({
        protocol: PROTOCOL,
        type: "failed",
        jobId: message.jobId,
        error: PUBLIC_ERROR,
      });
      return;
    }
    const job = { jobId: message.jobId, controller: new AbortController() };
    active = job;
    let progressSequence = 0;
    void verifyPdfOptimizeFiles(
      message.source as File,
      message.result as File,
      message.descriptor,
      defaultDependencies,
      job.controller.signal,
      (progress) => {
        if (active !== job || job.controller.signal.aborted) return;
        progressSequence += 1;
        workerScope.postMessage({
          protocol: PROTOCOL,
          type: "progress",
          jobId: job.jobId,
          sequence: progressSequence,
          ...progress,
        });
      },
    )
      .then(
        (verified) => {
          if (active !== job || job.controller.signal.aborted) return;
          workerScope.postMessage({
            protocol: PROTOCOL,
            type: "complete",
            jobId: job.jobId,
            ...verified,
          });
        },
        () => {
          if (active !== job || job.controller.signal.aborted) return;
          workerScope.postMessage({
            protocol: PROTOCOL,
            type: "failed",
            jobId: job.jobId,
            error: PUBLIC_ERROR,
          });
        },
      )
      .finally(() => {
        if (active !== job) return;
        if (job.controller.signal.aborted) {
          workerScope.postMessage({ protocol: PROTOCOL, type: "cancelled", jobId: job.jobId });
        }
        active = undefined;
      });
  };
  workerScope.postMessage({ protocol: PROTOCOL, type: "ready" });
}
