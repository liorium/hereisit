import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import {
  getToolImplementation,
  type ImageToolIntent,
  type PdfToolIntent,
  type PdfToolIntentClass,
  type ToolStep,
  type toolImplementationConfig,
} from "./tool-implementations";

export type {
  ImageToolIntent,
  PdfEditingIntent,
  PdfToolIntent,
  PdfToolIntentClass,
  ToolStep,
} from "./tool-implementations";
export {
  isPdfEditingIntent,
  PDF_COMPRESS_SCANNED_WARNING,
} from "./tool-implementations";

export interface ImageToolConfig {
  intent: ImageToolIntent;
  path: `/image/${ImageToolIntent}`;
  navLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  defaultSummary: string;
  steps: readonly [ToolStep, ToolStep, ToolStep];
  heicNote?: string;
}

export interface PdfToolConfig {
  intent: PdfToolIntent;
  intentClass: PdfToolIntentClass;
  path: `/pdf/${PdfToolIntent}`;
  navLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  defaultSummary: string;
  warning?: string;
  steps: readonly [ToolStep, ToolStep, ToolStep];
}

type ImageAvailableToolId = Extract<AvailableToolId, `image.${string}`>;
type PdfAvailableToolId = Extract<AvailableToolId, `pdf.${string}`>;

type LegacyImageToolConfig<Id extends ImageAvailableToolId> = Omit<
  ImageToolConfig,
  "intent" | "path"
> & {
  intent: Extract<(typeof toolImplementationConfig)[Id]["intent"], ImageToolIntent>;
  path: `/image/${Extract<(typeof toolImplementationConfig)[Id]["intent"], ImageToolIntent>}`;
};

type LegacyPdfToolConfig<Id extends PdfAvailableToolId> = Omit<
  PdfToolConfig,
  "intent" | "intentClass" | "path"
> & {
  intent: Extract<(typeof toolImplementationConfig)[Id]["intent"], PdfToolIntent>;
  intentClass: Extract<(typeof toolImplementationConfig)[Id]["intentClass"], PdfToolIntentClass>;
  path: `/pdf/${Extract<(typeof toolImplementationConfig)[Id]["intent"], PdfToolIntent>}`;
};

function createLegacyImageTool<const Id extends ImageAvailableToolId>(
  id: Id,
): LegacyImageToolConfig<Id> {
  const catalog = getAvailableToolById(id);
  const implementation = getToolImplementation(id);
  if (implementation.family !== "image") {
    throw new Error(`Expected image implementation: ${id}`);
  }
  const supportNotice = implementation.notices.find(({ tone }) => tone === "support")?.text;
  return {
    intent: implementation.intent,
    path: catalog.route as `/image/${ImageToolIntent}`,
    navLabel: implementation.legacyNavLabel,
    eyebrow: implementation.eyebrow,
    title: catalog.name,
    description: catalog.shortDescription,
    defaultSummary: implementation.defaultSummary,
    steps: implementation.legacySteps,
    ...(supportNotice === undefined ? {} : { heicNote: supportNotice }),
  } as LegacyImageToolConfig<Id>;
}

function createLegacyPdfTool<const Id extends PdfAvailableToolId>(id: Id): LegacyPdfToolConfig<Id> {
  const catalog = getAvailableToolById(id);
  const implementation = getToolImplementation(id);
  if (implementation.family !== "pdf") throw new Error(`Expected PDF implementation: ${id}`);
  const warning = implementation.notices.find(({ tone }) => tone === "warning")?.text;
  if (implementation.intentClass === undefined) throw new Error(`Missing PDF class: ${id}`);
  return {
    intent: implementation.intent,
    intentClass: implementation.intentClass,
    path: catalog.route as `/pdf/${PdfToolIntent}`,
    navLabel: implementation.legacyNavLabel,
    eyebrow: implementation.eyebrow,
    title: catalog.name,
    description: catalog.shortDescription,
    defaultSummary: implementation.defaultSummary,
    steps: implementation.legacySteps,
    ...(warning === undefined ? {} : { warning }),
  } as LegacyPdfToolConfig<Id>;
}

export const imageTools = {
  compress: createLegacyImageTool("image.compress"),
  resize: createLegacyImageTool("image.resize"),
  convert: createLegacyImageTool("image.convert"),
  watermark: createLegacyImageTool("image.watermark"),
} as const satisfies Record<ImageToolIntent, ImageToolConfig>;

export const imageToolList: readonly ImageToolConfig[] = Object.values(imageTools);

export function relatedImageTools(intent: ImageToolIntent): readonly ImageToolConfig[] {
  return imageToolList.filter((tool) => tool.intent !== intent);
}

export const pdfTools = {
  merge: createLegacyPdfTool("pdf.merge"),
  split: createLegacyPdfTool("pdf.split"),
  organize: createLegacyPdfTool("pdf.organize"),
  watermark: createLegacyPdfTool("pdf.watermark"),
  "to-image": createLegacyPdfTool("pdf.to-image"),
  "image-to-pdf": createLegacyPdfTool("pdf.image-to-pdf"),
  compress: createLegacyPdfTool("pdf.compress-scanned"),
} as const satisfies Record<PdfToolIntent, PdfToolConfig>;

export const pdfToolList: readonly PdfToolConfig[] = Object.values(pdfTools);
export const toolList = [...imageToolList, ...pdfToolList] as const;

export function relatedPdfTools(intent: PdfToolIntent): readonly PdfToolConfig[] {
  return pdfToolList.filter((tool) => tool.intent !== intent);
}

export const categoryNavigation = [
  {
    path: imageTools.compress.path,
    label: "이미지",
    prefix: imageTools.compress.path.replace(/[^/]+$/, "") as `/${string}/`,
  },
  {
    path: pdfTools.merge.path,
    label: "PDF",
    prefix: pdfTools.merge.path.replace(/[^/]+$/, "") as `/${string}/`,
  },
] as const;
