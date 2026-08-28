"use client";

import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import {
  type DragEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createZipArchive, downloadUrl, formatBytes } from "../lib/files";
import {
  clampControl,
  editorFilterCss,
  encodeAnimatedGif,
  normalizeFaceRegions,
  removeBackgroundPixels,
  sanitizeHtmlMarkup,
} from "../lib/image-extra";
import { getToolImplementation } from "../lib/tool-implementations";
import styles from "./image-extra-workbench.module.css";

export type ImageExtraIntent =
  | "convert-to-jpg"
  | "convert-from-jpg"
  | "editor"
  | "meme"
  | "html-to-image"
  | "upscale"
  | "blur-face"
  | "remove-background";

type ExtraOutputFormat = "jpeg" | "png" | "gif";
type EditorFilter = "none" | "warm" | "cool" | "vintage" | "mono";
type EditorFrame = "none" | "line" | "shadow" | "film";
type EditorSticker = "none" | "✨" | "❤️" | "🔥" | "😎";
type ItemStatus = "ready" | "processing" | "completed" | "failed";
type BlurRegion = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

interface WorkItem {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string;
  readonly status: ItemStatus;
  readonly resultUrl?: string;
  readonly result?: Blob;
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

interface ExtraOptions {
  readonly quality: number;
  readonly scale: 2 | 4;
  readonly output: ExtraOutputFormat;
  readonly delayMs: number;
  readonly loop: boolean;
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly grayscale: number;
  readonly filter: EditorFilter;
  readonly frame: EditorFrame;
  readonly sticker: EditorSticker;
  readonly text: string;
  readonly topText: string;
  readonly bottomText: string;
  readonly fontSize: number;
  readonly tolerance: number;
}

const MAX_PIXELS = 25_000_000;
const MAX_HTML_BYTES = 100_000;
const DEFAULT_HTML = `<main style="font-family:system-ui;padding:48px;background:#172033;color:white;border-radius:24px"><p style="color:#ffd84d;font-weight:700">HEREISIT</p><h1 style="font-size:56px;margin:0 0 12px">HTML을 이미지로</h1><p style="font-size:24px;margin:0;color:#d9e1ff">브라우저에서 안전하게 렌더링했어요.</p></main>`;
const ACCEPT_BY_INTENT: Record<ImageExtraIntent, string> = {
  "convert-to-jpg": "image/*,.jpg,.jpeg,.png,.gif,.webp,.svg,.tif,.tiff,.heic,.heif",
  "convert-from-jpg": "image/jpeg,.jpg,.jpeg",
  editor: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
  meme: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
  "html-to-image": "",
  upscale: "image/jpeg,image/png,.jpg,.jpeg,.png",
  "blur-face": "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
  "remove-background": "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
};

const INITIAL_OPTIONS: ExtraOptions = {
  quality: 90,
  scale: 2,
  output: "png",
  delayMs: 500,
  loop: true,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  grayscale: 0,
  filter: "none",
  frame: "none",
  sticker: "none",
  text: "",
  topText: "",
  bottomText: "",
  fontSize: 48,
  tolerance: 32,
};

function makeId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function extensionFor(format: ExtraOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function outputMime(format: ExtraOutputFormat): string {
  return `image/${format}`;
}

function outputName(name: string, format: ExtraOutputFormat): string {
  const stem = name.replace(/\.[^./\\]+$/, "") || "image";
  return `${stem}-hereisit.${extensionFor(format)}`;
}

function acceptedFile(file: File, intent: ImageExtraIntent): boolean {
  if (intent === "convert-from-jpg")
    return file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
  if (intent === "convert-to-jpg")
    return (
      file.type.startsWith("image/") ||
      /^\.(?:jpe?g|png|gif|webp|svg|tiff?|heic|heif)$/i.test(
        file.name.slice(file.name.lastIndexOf(".")),
      )
    );
  return (
    ["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    /\.(?:jpe?g|png|webp)$/i.test(file.name)
  );
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 읽지 못했습니다."));
    };
    image.src = url;
  });
}

interface FaceDetectorLike {
  detect(source: HTMLImageElement): Promise<readonly { boundingBox: DOMRectReadOnly }[]>;
}

type FaceDetectorConstructor = new (options?: {
  readonly fastMode?: boolean;
  readonly maxDetectedFaces?: number;
}) => FaceDetectorLike;

function createFaceDetector(): FaceDetectorLike | undefined {
  const detectorConstructor = (globalThis as unknown as { FaceDetector?: FaceDetectorConstructor })
    .FaceDetector;
  return typeof detectorConstructor === "function"
    ? new detectorConstructor({ fastMode: true, maxDetectedFaces: 20 })
    : undefined;
}

function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob === null ? reject(new Error("이미지를 저장하지 못했습니다.")) : resolve(blob),
      mime,
      quality / 100,
    );
  });
}

function fitDimensions(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const safeScale = Math.max(1, scale);
  const ratio = Math.min(
    1,
    Math.sqrt(MAX_PIXELS / Math.max(1, width * height)),
    4096 / Math.max(1, width),
    4096 / Math.max(1, height),
  );
  return {
    width: Math.max(1, Math.floor(width * safeScale * ratio)),
    height: Math.max(1, Math.floor(height * safeScale * ratio)),
  };
}

interface RenderSource {
  readonly source: CanvasImageSource;
  readonly image?: HTMLImageElement;
  readonly width: number;
  readonly height: number;
  readonly release: () => void;
}

async function loadRenderSource(file: File, scale: number): Promise<RenderSource> {
  if (scale > 1 && typeof createImageBitmap === "function") {
    let original: ImageBitmap | undefined;
    try {
      original = await createImageBitmap(file);
      const dimensions = fitDimensions(original.width, original.height, scale);
      const resized = await createImageBitmap(original, {
        resizeWidth: dimensions.width,
        resizeHeight: dimensions.height,
        resizeQuality: "high",
      });
      original.close();
      original = undefined;
      return {
        source: resized,
        width: dimensions.width,
        height: dimensions.height,
        release: () => resized.close(),
      };
    } catch {
      original?.close();
    }
  }
  const image = await loadImage(file);
  return {
    source: image,
    image,
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    release: () => image.removeAttribute("src"),
  };
}

function drawText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  align: CanvasTextAlign = "center",
): void {
  if (text.trim() === "") return;
  context.save();
  context.font = `900 ${fontSize}px Impact, Arial Black, sans-serif`;
  context.textAlign = align;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = Math.max(2, fontSize / 12);
  context.strokeStyle = "#000";
  context.fillStyle = "#fff";
  context.strokeText(text, x, y, Math.max(40, context.canvas.width - 32));
  context.fillText(text, x, y, Math.max(40, context.canvas.width - 32));
  context.restore();
}

function drawSticker(
  context: CanvasRenderingContext2D,
  sticker: EditorSticker,
  width: number,
  height: number,
): void {
  if (sticker === "none") return;
  context.save();
  context.font = `${Math.max(28, Math.round(Math.min(width, height) * 0.16))}px sans-serif`;
  context.textAlign = "right";
  context.textBaseline = "bottom";
  context.fillText(sticker, width - 18, height - 18);
  context.restore();
}

function drawFrame(
  context: CanvasRenderingContext2D,
  frame: EditorFrame,
  width: number,
  height: number,
): void {
  if (frame === "none") return;
  context.save();
  if (frame === "line") {
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(4, Math.round(Math.min(width, height) * 0.018));
    context.strokeRect(
      context.lineWidth,
      context.lineWidth,
      width - context.lineWidth * 2,
      height - context.lineWidth * 2,
    );
  } else if (frame === "shadow") {
    context.shadowColor = "rgba(17,24,39,0.42)";
    context.shadowBlur = Math.max(8, Math.round(Math.min(width, height) * 0.035));
    context.shadowOffsetY = Math.max(3, Math.round(Math.min(width, height) * 0.012));
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(5, Math.round(Math.min(width, height) * 0.024));
    context.strokeRect(
      context.lineWidth,
      context.lineWidth,
      width - context.lineWidth * 2,
      height - context.lineWidth * 2,
    );
  } else {
    const band = Math.max(14, Math.round(Math.min(width, height) * 0.06));
    context.fillStyle = "#111827";
    context.fillRect(0, 0, width, band);
    context.fillRect(0, height - band, width, band);
    context.fillStyle = "#f9fafb";
    const hole = Math.max(4, Math.round(band * 0.3));
    const gap = Math.max(12, Math.round(band * 0.8));
    for (let x = gap / 2; x < width; x += gap) {
      context.fillRect(x, (band - hole) / 2, hole, hole);
      context.fillRect(x, height - band + (band - hole) / 2, hole, hole);
    }
  }
  context.restore();
}

function drawRegions(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  regions: readonly BlurRegion[],
  width: number,
  height: number,
): void {
  for (const region of regions) {
    context.save();
    context.beginPath();
    context.rect(region.x * width, region.y * height, region.width * width, region.height * height);
    context.clip();
    context.filter = "blur(18px)";
    context.drawImage(image, 0, 0, width, height);
    context.restore();
  }
}

async function renderHtmlToBlob(html: string, width: number, height: number): Promise<Blob> {
  const safeHtml = sanitizeHtmlMarkup(html).slice(0, MAX_HTML_BYTES);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden">${safeHtml}</div></foreignObject></svg>`;
  const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("렌더링 공간을 만들지 못했습니다.");
    context.drawImage(image, 0, 0);
    return await canvasBlob(canvas, "image/png", 100);
  } finally {
    URL.revokeObjectURL(source);
  }
}

async function renderFile(
  file: File,
  intent: ImageExtraIntent,
  options: ExtraOptions,
  regions: readonly BlurRegion[],
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = intent === "upscale" ? options.scale : 1;
  const renderSource = await loadRenderSource(file, scale);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = renderSource.width;
    canvas.height = renderSource.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("렌더링 공간을 만들지 못했습니다.");

    if (intent === "editor") {
      const filterParts = [
        editorFilterCss(options.filter),
        `brightness(${options.brightness}%)`,
        `contrast(${options.contrast}%)`,
        `saturate(${options.saturation}%)`,
        `grayscale(${options.grayscale}%)`,
      ].filter(Boolean);
      context.filter = filterParts.join(" ");
    }
    if (intent === "convert-to-jpg" || options.output === "jpeg" || intent === "meme") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(renderSource.source, 0, 0, canvas.width, canvas.height);
    context.filter = "none";

    if (intent === "remove-background") {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      removeBackgroundPixels(pixels.data, canvas.width, canvas.height, options.tolerance);
      context.putImageData(pixels, 0, 0);
    }
    if (intent === "blur-face") {
      if (regions.length === 0) throw new Error("흐리게 할 영역을 하나 이상 드래그해 주세요.");
      if (renderSource.image === undefined) throw new Error("이미지를 다시 읽지 못했습니다.");
      drawRegions(context, renderSource.image, regions, canvas.width, canvas.height);
    }
    if (intent === "editor")
      drawText(
        context,
        options.text,
        canvas.width / 2,
        canvas.height - options.fontSize,
        options.fontSize,
      );
    if (intent === "meme") {
      const padding = Math.max(16, options.fontSize * 0.75);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, padding * 2 + options.fontSize);
      context.fillRect(
        0,
        canvas.height - padding * 2 - options.fontSize,
        canvas.width,
        padding * 2 + options.fontSize,
      );
      drawText(
        context,
        options.topText,
        canvas.width / 2,
        padding + options.fontSize / 2,
        options.fontSize,
      );
      drawText(
        context,
        options.bottomText,
        canvas.width / 2,
        canvas.height - padding - options.fontSize / 2,
        options.fontSize,
      );
    }
    if (intent === "editor") {
      drawSticker(context, options.sticker, canvas.width, canvas.height);
      drawFrame(context, options.frame, canvas.width, canvas.height);
    }

    const output =
      intent === "convert-to-jpg" ||
      intent === "meme" ||
      intent === "editor" ||
      intent === "blur-face" ||
      intent === "upscale"
        ? options.output === "gif"
          ? "png"
          : options.output
        : intent === "remove-background"
          ? "png"
          : options.output === "gif"
            ? "png"
            : options.output;
    return {
      blob: await canvasBlob(canvas, outputMime(output), options.quality),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    renderSource.release();
  }
}

async function renderGif(
  files: readonly File[],
  options: ExtraOptions,
): Promise<{ blob: Blob; width: number; height: number }> {
  const first = files[0] === undefined ? undefined : await loadImage(files[0]);
  if (first === undefined) throw new Error("GIF에 사용할 JPG를 선택해 주세요.");
  const sourceWidth = first.naturalWidth || first.width;
  const sourceHeight = first.naturalHeight || first.height;
  const baseDimensions = fitDimensions(sourceWidth, sourceHeight, 1);
  const gifPixelRatio = Math.min(
    1,
    Math.sqrt(4_000_000 / Math.max(1, baseDimensions.width * baseDimensions.height)),
  );
  const dimensions = {
    width: Math.max(1, Math.floor(baseDimensions.width * gifPixelRatio)),
    height: Math.max(1, Math.floor(baseDimensions.height * gifPixelRatio)),
  };
  const frames = [];
  for (const [index, file] of files.entries()) {
    const image = index === 0 ? first : await loadImage(file);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("GIF 렌더링 공간을 만들지 못했습니다.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    frames.push({
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
    });
    image.removeAttribute("src");
  }
  const bytes = encodeAnimatedGif(frames, { delayMs: options.delayMs, loop: options.loop });
  return {
    blob: new Blob([bytes], { type: "image/gif" }),
    width: dimensions.width,
    height: dimensions.height,
  };
}

function statusLabel(status: ItemStatus): string {
  if (status === "processing") return "처리 중";
  if (status === "completed") return "완료";
  if (status === "failed") return "확인 필요";
  return "대기 중";
}

export function ImageExtraWorkbench({
  intent,
  toolId,
}: {
  intent: ImageExtraIntent;
  toolId: AvailableToolId;
}) {
  const implementation = getToolImplementation(toolId);
  if (
    implementation.family !== "image" ||
    implementation.bundleProfile !== "image-extra" ||
    implementation.intent !== intent
  ) {
    throw new Error(`ImageExtraWorkbench tool mismatch: ${toolId}/${intent}`);
  }
  const limits = implementation.sourceFileLimits;
  const [items, setItems] = useState<WorkItem[]>([]);
  const [options, setOptions] = useState<ExtraOptions>(INITIAL_OPTIONS);
  const [html, setHtml] = useState(DEFAULT_HTML);
  const [htmlWidth, setHtmlWidth] = useState(1200);
  const [htmlHeight, setHtmlHeight] = useState(630);
  const [htmlResult, setHtmlResult] = useState<{ url: string; blob: Blob }>();
  const [message, setMessage] = useState("이미지를 선택하면 바로 준비할게요.");
  const [processing, setProcessing] = useState(false);
  const [regions, setRegions] = useState<BlurRegion[]>([]);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const ownedUrls = useRef(new Set<string>());

  const createOwnedUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    ownedUrls.current.add(url);
    return url;
  }, []);
  const revokeOwnedUrl = useCallback((url: string | undefined): void => {
    if (url === undefined || !ownedUrls.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }, []);

  useEffect(
    () => () => {
      for (const url of ownedUrls.current) URL.revokeObjectURL(url);
      ownedUrls.current.clear();
    },
    [],
  );

  const selected = items[0];
  const showFiles = intent !== "html-to-image";
  const itemOutputFormat =
    intent === "remove-background"
      ? "png"
      : intent === "convert-to-jpg"
        ? "jpeg"
        : options.output === "gif"
          ? "gif"
          : options.output;
  const outputLabel =
    itemOutputFormat === "jpeg" ? "JPG" : itemOutputFormat === "gif" ? "GIF" : "PNG";

  function chooseFiles(fileList: FileList | readonly File[]): void {
    if (processing) return;
    const files = Array.from(fileList)
      .filter((file) => acceptedFile(file, intent))
      .slice(0, limits.maxFiles);
    if (files.length === 0) {
      setMessage("이 도구에서 읽을 수 있는 이미지가 없어요.");
      return;
    }
    for (const item of items) revokeOwnedUrl(item.previewUrl);
    setItems(
      files.map((file) => ({
        id: makeId(),
        file,
        previewUrl: createOwnedUrl(file),
        status: "ready",
      })),
    );
    setRegions([]);
    setMessage(`${files.length}개 이미지를 준비했어요.`);
  }

  async function run(): Promise<void> {
    if (processing) return;
    if (intent === "html-to-image") {
      if (html.trim() === "") {
        setMessage("HTML을 입력해 주세요.");
        return;
      }
      setProcessing(true);
      try {
        const blob = await renderHtmlToBlob(
          html,
          clampControl(htmlWidth, 160, 2400),
          clampControl(htmlHeight, 160, 2400),
        );
        const url = createOwnedUrl(blob);
        if (htmlResult !== undefined) revokeOwnedUrl(htmlResult.url);
        setHtmlResult({ url, blob });
        setMessage("HTML을 PNG로 만들었어요.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "HTML을 이미지로 만들지 못했어요.");
      } finally {
        setProcessing(false);
      }
      return;
    }
    if (items.length === 0) {
      setMessage("먼저 이미지를 선택해 주세요.");
      return;
    }
    setProcessing(true);
    for (const item of items) revokeOwnedUrl(item.resultUrl);
    setItems((current) =>
      current.map((item) => ({
        id: item.id,
        file: item.file,
        previewUrl: item.previewUrl,
        status: "processing",
      })),
    );
    const next: WorkItem[] = [];
    try {
      let gifResult: { blob: Blob; width: number; height: number } | undefined;
      if (intent === "convert-from-jpg" && itemOutputFormat === "gif")
        try {
          gifResult = await renderGif(
            items.map((item) => item.file),
            options,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : "GIF를 만들지 못했어요.";
          setItems(
            items.map((item) => ({
              id: item.id,
              file: item.file,
              previewUrl: item.previewUrl,
              status: "failed",
              error: reason,
            })),
          );
          setMessage(reason);
          return;
        }
      if (gifResult !== undefined) {
        const first = items[0];
        if (first !== undefined) {
          const resultUrl = createOwnedUrl(gifResult.blob);
          next.push({
            id: first.id,
            file: first.file,
            previewUrl: first.previewUrl,
            status: "completed",
            resultUrl,
            result: gifResult.blob,
            width: gifResult.width,
            height: gifResult.height,
          });
          for (const item of items.slice(1)) {
            next.push({
              id: item.id,
              file: item.file,
              previewUrl: item.previewUrl,
              status: "completed",
            });
          }
        }
      } else {
        for (const item of items) {
          const baseItem = {
            id: item.id,
            file: item.file,
            previewUrl: item.previewUrl,
          };
          try {
            const rendered = await renderFile(
              item.file,
              intent,
              { ...options, output: itemOutputFormat },
              regions,
            );
            const resultUrl = createOwnedUrl(rendered.blob);
            next.push({
              ...baseItem,
              status: "completed",
              resultUrl,
              result: rendered.blob,
              width: rendered.width,
              height: rendered.height,
            });
          } catch (error) {
            next.push({
              ...baseItem,
              status: "failed",
              error: error instanceof Error ? error.message : "이미지를 처리하지 못했어요.",
            });
          }
        }
      }
      setItems(next);
      const completed = next.filter((item) => item.status === "completed").length;
      setMessage(
        completed > 0 ? `${completed}개 결과를 만들었어요.` : "처리할 수 있는 결과가 없어요.",
      );
    } finally {
      setProcessing(false);
    }
  }

  async function downloadAll(): Promise<void> {
    const completed = items.filter(
      (item): item is WorkItem & { result: Blob; resultUrl: string } =>
        item.result !== undefined && item.resultUrl !== undefined,
    );
    if (completed.length === 0 && htmlResult === undefined) return;
    if (htmlResult !== undefined) {
      downloadUrl(htmlResult.url, "hereisit-html.png");
      return;
    }
    if (completed.length === 1) {
      const first = completed[0];
      if (first === undefined) return;
      downloadUrl(first.resultUrl, outputName(first.file.name, itemOutputFormat));
      return;
    }
    const archive = await createZipArchive(
      await Promise.all(
        completed.map(async (item) => ({
          name: outputName(item.file.name, itemOutputFormat),
          bytes: await item.result.arrayBuffer(),
        })),
      ),
    );
    const url = createOwnedUrl(archive);
    downloadUrl(url, `hereisit-${intent}.zip`);
    window.setTimeout(() => revokeOwnedUrl(url), 60_000);
  }

  function updateOption<Key extends keyof ExtraOptions>(key: Key, value: ExtraOptions[Key]): void {
    setOptions((current) => ({ ...current, [key]: value }));
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    chooseFiles(event.dataTransfer.files);
  }

  function beginBlur(event: PointerEvent<HTMLElement>): void {
    if (intent !== "blur-face" || selected === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clampControl((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clampControl((event.clientY - rect.top) / rect.height, 0, 1);
    setDragStart({ x, y });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function endBlur(event: PointerEvent<HTMLElement>): void {
    if (dragStart === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clampControl((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clampControl((event.clientY - rect.top) / rect.height, 0, 1);
    const region = {
      id: makeId(),
      x: Math.min(dragStart.x, x),
      y: Math.min(dragStart.y, y),
      width: Math.abs(x - dragStart.x),
      height: Math.abs(y - dragStart.y),
    };
    if (region.width > 0.02 && region.height > 0.02) setRegions((current) => [...current, region]);
    setDragStart(undefined);
  }

  async function detectFaces(): Promise<void> {
    if (intent !== "blur-face" || selected === undefined || processing) return;
    const detector = createFaceDetector();
    if (detector === undefined) {
      setMessage("자동 얼굴 찾기는 이 브라우저에서 지원되지 않아요. 영역을 직접 드래그해 주세요.");
      return;
    }
    setProcessing(true);
    try {
      const image = await loadImage(selected.file);
      const detections = await detector.detect(image);
      const imageWidth = image.naturalWidth || image.width;
      const imageHeight = image.naturalHeight || image.height;
      image.removeAttribute("src");
      const detected = normalizeFaceRegions(
        detections.map(({ boundingBox }) => ({
          x: boundingBox.x,
          y: boundingBox.y,
          width: boundingBox.width,
          height: boundingBox.height,
        })),
        imageWidth,
        imageHeight,
      );
      if (detected.length === 0) {
        setMessage("얼굴을 찾지 못했어요. 영역을 직접 드래그해 주세요.");
        return;
      }
      setRegions(detected);
      setMessage(`${detected.length}개 얼굴 영역을 찾았어요. 필요하면 직접 조절해 주세요.`);
    } catch {
      setMessage("자동 얼굴 찾기에 실패했어요. 영역을 직접 드래그해 주세요.");
    } finally {
      setProcessing(false);
    }
  }

  const previewClass = useMemo(
    () => `${styles.preview} ${intent === "blur-face" ? styles.blurPreview : ""}`,
    [intent],
  );

  return (
    <div className={styles.workbench}>
      {showFiles ? (
        <>
          <input
            accept={ACCEPT_BY_INTENT[intent]}
            className={styles.hiddenInput}
            disabled={processing}
            multiple={limits.maxFiles > 1}
            onChange={(event) => {
              if (event.currentTarget.files !== null) chooseFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            ref={inputRef}
            type="file"
          />
          <button
            className={styles.dropzone}
            disabled={processing}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            type="button"
          >
            <strong>{implementation.defaultSummary}</strong>
            <span>파일을 끌어 놓거나 눌러 선택하세요 · 최대 {limits.maxFiles}개</span>
          </button>
          {items.length > 0 ? (
            <ul aria-label="선택한 이미지" className={styles.fileList}>
              {items.map((item) => (
                <li className={styles.fileRow} key={item.id}>
                  {/* biome-ignore lint/performance/noImgElement: local object URL preview */}
                  <img alt="" src={item.previewUrl} />
                  <span>{item.file.name}</span>
                  <small>
                    {statusLabel(item.status)}
                    {item.result !== undefined ? ` · ${formatBytes(item.result.size)}` : ""}
                  </small>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className={styles.htmlEditor}>
          <label>
            HTML·CSS
            <textarea
              value={html}
              onChange={(event) => setHtml(event.currentTarget.value)}
              maxLength={MAX_HTML_BYTES}
              rows={10}
            />
          </label>
          <div className={styles.inlineControls}>
            <label>
              가로{" "}
              <input
                max={2400}
                min={160}
                onChange={(event) => setHtmlWidth(Number(event.currentTarget.value))}
                type="number"
                value={htmlWidth}
              />
            </label>
            <label>
              세로{" "}
              <input
                max={2400}
                min={160}
                onChange={(event) => setHtmlHeight(Number(event.currentTarget.value))}
                type="number"
                value={htmlHeight}
              />
            </label>
          </div>
        </div>
      )}

      {selected !== undefined && intent === "blur-face" ? (
        <fieldset
          className={previewClass}
          data-testid="blur-preview"
          onPointerDown={beginBlur}
          onPointerUp={endBlur}
          aria-label="흐릴 영역을 드래그하세요"
        >
          <legend className={styles.srOnly}>흐릴 영역을 드래그하세요</legend>
          {/* biome-ignore lint/performance/noImgElement: local object URL preview */}
          <img alt="흐릴 영역을 드래그하세요" src={selected.previewUrl} />
          {regions.map((region) => (
            <span
              className={styles.region}
              key={region.id}
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            />
          ))}
        </fieldset>
      ) : null}

      {intent !== "html-to-image" ? (
        <fieldset className={styles.controls} disabled={processing}>
          <legend className={styles.srOnly}>이미지 추가 설정</legend>
          {intent === "editor" ||
          intent === "meme" ||
          intent === "upscale" ||
          intent === "blur-face" ? (
            <label>
              출력 형식
              <select
                value={options.output === "gif" ? "png" : options.output}
                onChange={(event) =>
                  updateOption("output", event.currentTarget.value as ExtraOutputFormat)
                }
              >
                <option value="jpeg">JPG</option>
                <option value="png">PNG</option>
              </select>
            </label>
          ) : null}
          {intent !== "convert-from-jpg" || options.output !== "gif" ? (
            <label>
              품질
              <input
                max={100}
                min={40}
                onChange={(event) => updateOption("quality", Number(event.currentTarget.value))}
                type="range"
                value={options.quality}
              />
              <output>{options.quality}</output>
            </label>
          ) : null}
          {intent === "convert-from-jpg" ? (
            <>
              <label>
                결과
                <select
                  value={options.output}
                  onChange={(event) =>
                    updateOption("output", event.currentTarget.value as ExtraOutputFormat)
                  }
                >
                  <option value="png">PNG</option>
                  <option value="gif">움직이는 GIF</option>
                </select>
              </label>
              {options.output === "gif" ? (
                <label>
                  프레임 간격{" "}
                  <input
                    max={3000}
                    min={80}
                    onChange={(event) => updateOption("delayMs", Number(event.currentTarget.value))}
                    type="number"
                    value={options.delayMs}
                  />
                  ms
                </label>
              ) : null}
            </>
          ) : null}
          {intent === "upscale" ? (
            <label>
              확대{" "}
              <select
                value={options.scale}
                onChange={(event) =>
                  updateOption("scale", Number(event.currentTarget.value) as 2 | 4)
                }
              >
                <option value={2}>2배</option>
                <option value={4}>4배</option>
              </select>
            </label>
          ) : null}
          {intent === "remove-background" ? (
            <label>
              배경 허용 범위{" "}
              <input
                max={100}
                min={0}
                onChange={(event) => updateOption("tolerance", Number(event.currentTarget.value))}
                type="range"
                value={options.tolerance}
              />
              <output>{options.tolerance}</output>
            </label>
          ) : null}
          {intent === "blur-face" ? (
            <>
              <button
                className={styles.secondaryButton}
                disabled={processing}
                onClick={() => void detectFaces()}
                type="button"
              >
                자동으로 얼굴 찾기
              </button>
              <button
                className={styles.secondaryButton}
                disabled={processing}
                onClick={() => setRegions([])}
                type="button"
              >
                영역 지우기
              </button>
            </>
          ) : null}
          {intent === "editor" ? (
            <>
              <label>
                필터
                <select
                  value={options.filter}
                  onChange={(event) =>
                    updateOption("filter", event.currentTarget.value as EditorFilter)
                  }
                >
                  <option value="none">원본</option>
                  <option value="warm">따뜻하게</option>
                  <option value="cool">차갑게</option>
                  <option value="vintage">빈티지</option>
                  <option value="mono">흑백</option>
                </select>
              </label>
              <label>
                프레임
                <select
                  value={options.frame}
                  onChange={(event) =>
                    updateOption("frame", event.currentTarget.value as EditorFrame)
                  }
                >
                  <option value="none">없음</option>
                  <option value="line">흰색 라인</option>
                  <option value="shadow">그림자</option>
                  <option value="film">필름</option>
                </select>
              </label>
              <label>
                스티커
                <select
                  value={options.sticker}
                  onChange={(event) =>
                    updateOption("sticker", event.currentTarget.value as EditorSticker)
                  }
                >
                  <option value="none">없음</option>
                  <option value="✨">✨</option>
                  <option value="❤️">❤️</option>
                  <option value="🔥">🔥</option>
                  <option value="😎">😎</option>
                </select>
              </label>
              <label>
                밝기{" "}
                <input
                  max={160}
                  min={40}
                  onChange={(event) =>
                    updateOption("brightness", Number(event.currentTarget.value))
                  }
                  type="range"
                  value={options.brightness}
                />
              </label>
              <label>
                대비{" "}
                <input
                  max={160}
                  min={40}
                  onChange={(event) => updateOption("contrast", Number(event.currentTarget.value))}
                  type="range"
                  value={options.contrast}
                />
              </label>
              <label>
                채도{" "}
                <input
                  max={180}
                  min={0}
                  onChange={(event) =>
                    updateOption("saturation", Number(event.currentTarget.value))
                  }
                  type="range"
                  value={options.saturation}
                />
              </label>
              <label>
                회색조{" "}
                <input
                  max={100}
                  min={0}
                  onChange={(event) => updateOption("grayscale", Number(event.currentTarget.value))}
                  type="range"
                  value={options.grayscale}
                />
              </label>
              <label>
                문구{" "}
                <input
                  maxLength={120}
                  onChange={(event) => updateOption("text", event.currentTarget.value)}
                  type="text"
                  value={options.text}
                />
              </label>
            </>
          ) : null}
          {intent === "meme" ? (
            <>
              <label>
                위 문구{" "}
                <input
                  maxLength={100}
                  onChange={(event) => updateOption("topText", event.currentTarget.value)}
                  type="text"
                  value={options.topText}
                />
              </label>
              <label>
                아래 문구{" "}
                <input
                  maxLength={100}
                  onChange={(event) => updateOption("bottomText", event.currentTarget.value)}
                  type="text"
                  value={options.bottomText}
                />
              </label>
              <label>
                글자 크기{" "}
                <input
                  max={120}
                  min={18}
                  onChange={(event) => updateOption("fontSize", Number(event.currentTarget.value))}
                  type="number"
                  value={options.fontSize}
                />
              </label>
            </>
          ) : null}
        </fieldset>
      ) : null}

      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          disabled={processing}
          onClick={() => void run()}
          type="button"
        >
          {processing ? "처리 중…" : `${outputLabel} 만들기`}
        </button>
        {items.some((item) => item.result !== undefined) || htmlResult !== undefined ? (
          <button
            className={styles.secondaryButton}
            onClick={() => void downloadAll()}
            type="button"
          >
            결과 다운로드
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className={styles.message}>
        {message}
      </p>
      {htmlResult !== undefined ? (
        // biome-ignore lint/performance/noImgElement: local generated result
        <img alt="HTML 결과 미리보기" className={styles.resultPreview} src={htmlResult.url} />
      ) : null}
      {items.some((item) => item.resultUrl !== undefined) ? (
        <div className={styles.results}>
          {items
            .filter((item) => item.resultUrl !== undefined)
            .map((item) => (
              <figure key={item.id}>
                {/* biome-ignore lint/performance/noImgElement: local generated result */}
                <img alt={`${item.file.name} 결과`} src={item.resultUrl} />
                <figcaption>
                  {item.width}×{item.height} · {formatBytes(item.result?.size ?? 0)}
                </figcaption>
              </figure>
            ))}
        </div>
      ) : null}
    </div>
  );
}
