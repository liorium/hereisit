import { PDFDocument, type PDFImage } from "@cantoo/pdf-lib";
import {
  inspectImageHeader,
  readJpegExifOrientation,
  stripJpegMetadata,
  stripPngMetadata,
} from "@hereisit/image-tool";
import {
  calculateOrientedPdfImageLayout,
  extractedPdfName,
  hasPdfSignature,
  imagesPdfName,
  mergedPdfName,
  type PdfImageOrientation,
  splitPdfArchiveName,
  splitPdfPageName,
} from "@hereisit/pdf-tool";
import {
  type ParsedPdfPipelineSpecV1,
  type PdfPhase,
  type PdfPipelineResult,
  type PdfRunRequest,
  type PdfToolErrorPayload,
  pdfPipelineSpecSchema,
} from "@hereisit/tool-contracts";
import { Zip, ZipPassThrough } from "fflate";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_SPLIT_OUTPUTS = 200;
const MAX_OUTPUT_BYTES = 150 * 1024 * 1024;
const MAX_SPLIT_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_JPEG_PIXELS = 50_000_000;
const MAX_PNG_PIXELS = 16_000_000;
const MAX_TOTAL_PNG_PIXELS = 64_000_000;
const MAX_PNG_ESTIMATED_PEAK_BYTES = 128 * 1024 * 1024;

export type PdfPipelineInput = PdfRunRequest["inputs"][number];

export interface PdfPipelineOptions {
  onProgress?: (phase: PdfPhase, fraction: number) => void;
}

interface Timing {
  loadMs: number;
  processMs: number;
  saveMs: number;
}

export class PdfPipelineFailure extends Error {
  constructor(readonly payload: PdfToolErrorPayload) {
    super(payload.message);
    this.name = "PdfPipelineFailure";
  }
}

function fail(code: PdfToolErrorPayload["code"], message: string, retryable = false): never {
  throw new PdfPipelineFailure({ code, message, retryable });
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function emit(options: PdfPipelineOptions, phase: PdfPhase, fraction: number): void {
  options.onProgress?.(phase, Math.max(0, Math.min(1, fraction)));
}

function validateInputs(inputs: readonly PdfPipelineInput[], spec: ParsedPdfPipelineSpecV1): void {
  const expected =
    spec.operation === "merge" ? { minimum: 2, maximum: 20 } : { minimum: 1, maximum: 100 };
  if (inputs.length < expected.minimum || inputs.length > expected.maximum) {
    fail(
      "UNSUPPORTED_INPUT",
      spec.operation === "merge"
        ? "PDF 합치기는 2개부터 20개 파일까지 처리할 수 있어요."
        : "선택한 파일 개수가 처리 범위를 벗어났어요.",
    );
  }
  if (spec.operation === "split" && inputs.length !== 1) {
    fail("UNSUPPORTED_INPUT", "페이지 분할은 PDF 한 개씩 처리할 수 있어요.");
  }

  let totalBytes = 0;
  for (const input of inputs) {
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength !== input.byteLength ||
      input.bytes.byteLength > MAX_FILE_BYTES
    ) {
      fail("MEMORY_LIMIT", "파일당 최대 50MB까지 처리할 수 있어요.");
    }
    totalBytes += input.bytes.byteLength;
  }
  if (totalBytes > MAX_INPUT_BYTES) {
    fail("MEMORY_LIMIT", "한 작업의 파일 합계는 최대 100MB까지 처리할 수 있어요.");
  }
}

async function loadPdf(input: PdfPipelineInput): Promise<PDFDocument> {
  if (!hasPdfSignature(input.bytes)) {
    fail("UNSUPPORTED_INPUT", "PDF 형식을 확인할 수 없는 파일이 있어요.");
  }
  try {
    const document = await PDFDocument.load(input.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (document.isEncrypted) {
      fail("PASSWORD_PROTECTED", "암호로 잠긴 PDF는 아직 처리할 수 없어요.");
    }
    if (document.getPageCount() < 1) {
      fail("CORRUPT_PDF", "페이지가 없는 PDF는 처리할 수 없어요.");
    }
    return document;
  } catch (error) {
    if (error instanceof PdfPipelineFailure) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/password|encrypt|decrypt/i.test(message)) {
      fail("PASSWORD_PROTECTED", "암호로 잠긴 PDF는 아직 처리할 수 없어요.");
    }
    if (/PDF_PAGE_LIMIT/.test(message)) {
      fail("PAGE_LIMIT", "한 작업에서 최대 500페이지까지 처리할 수 있어요.");
    }
    if (/PDF_STREAM_SAFETY_LIMIT/.test(message)) {
      fail("MEMORY_LIMIT", "압축을 푼 PDF 데이터가 안전 처리 한도를 넘었어요.");
    }
    fail("CORRUPT_PDF", "PDF를 읽지 못했어요. 파일이 손상되지 않았는지 확인해 주세요.");
  }
}

async function createOutputDocument(): Promise<PDFDocument> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setCreator("HereItIs");
  document.setProducer("HereItIs");
  return document;
}

async function savePdf(document: PDFDocument): Promise<Uint8Array> {
  try {
    return await document.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 50,
      updateFieldAppearances: false,
    });
  } catch {
    fail("WRITE_FAILED", "PDF 결과를 만들지 못했어요.");
  }
}

function ensurePageLimit(pageCount: number): void {
  if (pageCount > MAX_PAGES) {
    fail("PAGE_LIMIT", "한 작업에서 최대 500페이지까지 처리할 수 있어요.");
  }
}

function ensureOutputLimit(byteLength: number): void {
  if (byteLength > MAX_OUTPUT_BYTES) {
    fail("MEMORY_LIMIT", "결과가 150MB를 넘어 작업을 안전하게 중단했어요.");
  }
}

async function mergePdfs(
  inputs: readonly PdfPipelineInput[],
  timing: Timing,
  options: PdfPipelineOptions,
): Promise<Omit<PdfPipelineResult, "timing">> {
  const output = await createOutputDocument();
  let sourcePageCount = 0;

  for (const [index, input] of inputs.entries()) {
    const loadStarted = now();
    const source = await loadPdf(input);
    timing.loadMs += now() - loadStarted;
    const pageIndices = source.getPageIndices();
    sourcePageCount += pageIndices.length;
    ensurePageLimit(sourcePageCount);

    const processStarted = now();
    const pages = await output.copyPages(source, pageIndices);
    for (const page of pages) output.addPage(page);
    timing.processMs += now() - processStarted;
    emit(options, "processing", 0.1 + ((index + 1) / inputs.length) * 0.7);
  }

  emit(options, "serializing", 0.85);
  const saveStarted = now();
  const outputBytes = await savePdf(output);
  timing.saveMs += now() - saveStarted;
  ensureOutputLimit(outputBytes.byteLength);
  const bytes = ownedArrayBuffer(outputBytes);
  return {
    bytes,
    suggestedName: mergedPdfName(),
    mime: "application/pdf",
    byteLength: bytes.byteLength,
    sourcePageCount,
    outputPageCount: sourcePageCount,
    outputDocumentCount: 1,
    warnings: ["DOCUMENT_FEATURES_MAY_CHANGE", "SIGNATURES_INVALIDATED"],
  };
}

async function createSplitArchive(
  source: PDFDocument,
  sourceName: string,
  timing: Timing,
  options: PdfPipelineOptions,
): Promise<ArrayBuffer> {
  const pageCount = source.getPageCount();
  if (pageCount > MAX_SPLIT_OUTPUTS) {
    fail("PAGE_LIMIT", "페이지별 분리는 한 번에 최대 200페이지까지 처리할 수 있어요.");
  }

  type ArchiveOutcome = { ok: true; bytes: Uint8Array } | { ok: false; error: Error };
  const chunks: Uint8Array[] = [];
  let archiveBytes = 0;
  let archiveFailure: Error | undefined;
  let settled = false;
  let resolveArchive: (outcome: ArchiveOutcome) => void = () => undefined;
  const archiveResult = new Promise<ArchiveOutcome>((resolve) => {
    resolveArchive = resolve;
  });
  const settle = (outcome: ArchiveOutcome): void => {
    if (settled) return;
    settled = true;
    resolveArchive(outcome);
  };
  const archive = new Zip((error, chunk, final) => {
    if (settled) return;
    try {
      if (error !== null) {
        archiveFailure = error;
        settle({ ok: false, error });
        return;
      }
      archiveBytes += chunk.byteLength;
      if (archiveBytes > MAX_SPLIT_OUTPUT_BYTES) {
        archiveFailure = new Error("OUTPUT_LIMIT");
        chunks.length = 0;
        settle({ ok: false, error: archiveFailure });
        return;
      }
      chunks.push(chunk.slice());
      if (!final) return;
      const joined = new Uint8Array(archiveBytes);
      let offset = 0;
      for (const part of chunks) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      chunks.length = 0;
      settle({ ok: true, bytes: joined });
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error("ZIP_WRITE_FAILED");
      archiveFailure = failure;
      chunks.length = 0;
      settle({ ok: false, error: failure });
    }
  });

  try {
    for (let index = 0; index < pageCount; index += 1) {
      const processStarted = now();
      const pageDocument = await createOutputDocument();
      const pages = await pageDocument.copyPages(source, [index]);
      const page = pages[0];
      if (page === undefined) fail("CORRUPT_PDF", "PDF 페이지를 복사하지 못했어요.");
      pageDocument.addPage(page);
      timing.processMs += now() - processStarted;

      const saveStarted = now();
      const pageBytes = await savePdf(pageDocument);
      timing.saveMs += now() - saveStarted;
      const entry = new ZipPassThrough(splitPdfPageName(sourceName, index + 1, pageCount));
      archive.add(entry);
      entry.push(pageBytes, true);
      if (archiveFailure !== undefined) break;
      emit(options, "processing", 0.15 + ((index + 1) / pageCount) * 0.68);
    }
    if (archiveFailure === undefined) {
      emit(options, "serializing", 0.88);
      archive.end();
    }

    const outcome = await archiveResult;
    if (!outcome.ok) {
      if (outcome.error.message === "OUTPUT_LIMIT") {
        fail("MEMORY_LIMIT", "분할 결과가 100MB를 넘어 작업을 안전하게 중단했어요.");
      }
      fail("WRITE_FAILED", "분할 결과 ZIP을 만들지 못했어요.");
    }
    const bytes = outcome.bytes;
    ensureOutputLimit(bytes.byteLength);
    return ownedArrayBuffer(bytes);
  } catch (error) {
    if (error instanceof PdfPipelineFailure) throw error;
    fail("WRITE_FAILED", "분할 결과 ZIP을 만들지 못했어요.");
  } finally {
    chunks.length = 0;
    archive.terminate();
  }
}

async function splitPdf(
  input: PdfPipelineInput,
  spec: Extract<ParsedPdfPipelineSpecV1, { operation: "split" }>,
  timing: Timing,
  options: PdfPipelineOptions,
): Promise<Omit<PdfPipelineResult, "timing">> {
  const loadStarted = now();
  const source = await loadPdf(input);
  timing.loadMs += now() - loadStarted;
  const sourcePageCount = source.getPageCount();
  ensurePageLimit(sourcePageCount);

  if (spec.selection.mode === "every-page") {
    const bytes = await createSplitArchive(source, input.name, timing, options);
    return {
      bytes,
      suggestedName: splitPdfArchiveName(input.name),
      mime: "application/zip",
      byteLength: bytes.byteLength,
      sourcePageCount,
      outputPageCount: sourcePageCount,
      outputDocumentCount: sourcePageCount,
      warnings: ["DOCUMENT_FEATURES_MAY_CHANGE", "SIGNATURES_INVALIDATED"],
    };
  }

  if (spec.selection.pages.some((page) => page > sourcePageCount)) {
    fail("PAGE_RANGE_INVALID", `이 PDF는 ${sourcePageCount}페이지까지 있어요.`);
  }
  const output = await createOutputDocument();
  const processStarted = now();
  const pages = await output.copyPages(
    source,
    spec.selection.pages.map((page) => page - 1),
  );
  for (const page of pages) output.addPage(page);
  timing.processMs += now() - processStarted;
  emit(options, "processing", 0.8);

  emit(options, "serializing", 0.88);
  const saveStarted = now();
  const outputBytes = await savePdf(output);
  timing.saveMs += now() - saveStarted;
  ensureOutputLimit(outputBytes.byteLength);
  const bytes = ownedArrayBuffer(outputBytes);
  return {
    bytes,
    suggestedName: extractedPdfName(input.name),
    mime: "application/pdf",
    byteLength: bytes.byteLength,
    sourcePageCount,
    outputPageCount: spec.selection.pages.length,
    outputDocumentCount: 1,
    warnings: ["DOCUMENT_FEATURES_MAY_CHANGE", "SIGNATURES_INVALIDATED"],
  };
}

async function imagesToPdf(
  inputs: readonly PdfPipelineInput[],
  spec: Extract<ParsedPdfPipelineSpecV1, { operation: "images-to-pdf" }>,
  timing: Timing,
  options: PdfPipelineOptions,
): Promise<Omit<PdfPipelineResult, "timing">> {
  const prepared: {
    input: PdfPipelineInput;
    kind: "jpeg" | "png";
    width: number;
    height: number;
    orientation: PdfImageOrientation;
  }[] = [];
  let totalPngPixels = 0;

  for (const input of inputs) {
    const inspectStarted = now();
    let inspected: ReturnType<typeof inspectImageHeader>;
    try {
      inspected = inspectImageHeader(input.bytes);
    } catch {
      fail("UNSUPPORTED_INPUT", "이미지 PDF 변환은 현재 JPG와 PNG 파일을 지원해요.");
    }
    timing.loadMs += now() - inspectStarted;
    if (inspected.format !== "jpeg" && inspected.format !== "png") {
      fail("UNSUPPORTED_INPUT", "이미지 PDF 변환은 현재 JPG와 PNG 파일을 지원해요.");
    }
    if (inspected.animated) {
      fail("UNSUPPORTED_INPUT", "움직이는 PNG는 PDF로 변환할 수 없어요.");
    }
    if (inspected.width > MAX_IMAGE_DIMENSION || inspected.height > MAX_IMAGE_DIMENSION) {
      fail("MEMORY_LIMIT", "이미지의 가로·세로는 최대 16,384px까지 처리할 수 있어요.");
    }

    const pixels = inspected.width * inspected.height;
    if (inspected.format === "png") {
      const estimatedPeakBytes =
        (inspected.pngRawBytes ?? Number.MAX_SAFE_INTEGER) + pixels * 12 + input.byteLength * 3;
      if (
        !Number.isSafeInteger(estimatedPeakBytes) ||
        estimatedPeakBytes > MAX_PNG_ESTIMATED_PEAK_BYTES
      ) {
        fail(
          "MEMORY_LIMIT",
          "이 PNG는 압축 해제 시 메모리 사용량이 커서 안전하게 처리할 수 없어요.",
        );
      }
      if (pixels > MAX_PNG_PIXELS) {
        fail("MEMORY_LIMIT", "PNG 이미지는 한 장당 최대 16MP까지 처리할 수 있어요.");
      }
      totalPngPixels += pixels;
      if (totalPngPixels > MAX_TOTAL_PNG_PIXELS) {
        fail("MEMORY_LIMIT", "PNG 해상도 합계는 한 작업에서 최대 64MP까지 처리할 수 있어요.");
      }
    } else if (pixels > MAX_JPEG_PIXELS) {
      fail("MEMORY_LIMIT", "JPG 이미지는 한 장당 최대 50MP까지 처리할 수 있어요.");
    }

    prepared.push({
      input,
      kind: inspected.format,
      width: inspected.width,
      height: inspected.height,
      orientation: inspected.format === "jpeg" ? readJpegExifOrientation(input.bytes) : 1,
    });
  }

  const output = await createOutputDocument();

  for (const [index, preparedImage] of prepared.entries()) {
    const loadStarted = now();
    let image: PDFImage;
    try {
      const embeddingBytes =
        preparedImage.kind === "png"
          ? stripPngMetadata(preparedImage.input.bytes)
          : stripJpegMetadata(preparedImage.input.bytes);
      image =
        preparedImage.kind === "png"
          ? await output.embedPng(embeddingBytes)
          : await output.embedJpg(embeddingBytes);
    } catch {
      fail("UNSUPPORTED_INPUT", "읽을 수 없는 JPG 또는 PNG 이미지가 있어요.");
    }
    timing.loadMs += now() - loadStarted;

    const processStarted = now();
    const layout = calculateOrientedPdfImageLayout(
      preparedImage.width,
      preparedImage.height,
      spec.page,
      preparedImage.orientation,
    );
    const page = output.addPage([layout.pageWidth, layout.pageHeight]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      matrix: layout.drawMatrix,
    });
    try {
      await image.embed();
    } catch {
      fail("WRITE_FAILED", "이미지를 PDF 페이지에 넣지 못했어요.");
    }
    timing.processMs += now() - processStarted;
    emit(options, "processing", 0.1 + ((index + 1) / prepared.length) * 0.7);
  }

  emit(options, "serializing", 0.85);
  const saveStarted = now();
  const outputBytes = await savePdf(output);
  timing.saveMs += now() - saveStarted;
  ensureOutputLimit(outputBytes.byteLength);
  const bytes = ownedArrayBuffer(outputBytes);
  return {
    bytes,
    suggestedName: imagesPdfName(),
    mime: "application/pdf",
    byteLength: bytes.byteLength,
    sourcePageCount: inputs.length,
    outputPageCount: inputs.length,
    outputDocumentCount: 1,
    warnings: ["IMAGE_COLOR_MAY_CHANGE"],
  };
}

export async function runPdfPipeline(
  inputs: readonly PdfPipelineInput[],
  rawSpec: unknown,
  options: PdfPipelineOptions = {},
): Promise<PdfPipelineResult> {
  const started = now();
  emit(options, "validating", 0.01);
  const parsed = pdfPipelineSpecSchema.safeParse(rawSpec);
  if (!parsed.success) fail("INVALID_SPEC", "PDF 작업 설정이 올바르지 않아요.");
  const spec = parsed.data;
  validateInputs(inputs, spec);

  const timing: Timing = { loadMs: 0, processMs: 0, saveMs: 0 };
  emit(options, "loading", 0.05);
  const result =
    spec.operation === "merge"
      ? await mergePdfs(inputs, timing, options)
      : spec.operation === "split"
        ? await splitPdf(inputs[0] as PdfPipelineInput, spec, timing, options)
        : await imagesToPdf(inputs, spec, timing, options);
  emit(options, "finalizing", 1);
  return { ...result, timing: { ...timing, totalMs: now() - started } };
}

export function toPdfErrorPayload(error: unknown): PdfToolErrorPayload {
  if (error instanceof PdfPipelineFailure) return error.payload;
  return {
    code: "WRITE_FAILED",
    message: "PDF 작업을 완료하지 못했어요.",
    retryable: true,
  };
}
