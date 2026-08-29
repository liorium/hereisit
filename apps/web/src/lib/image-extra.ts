export type { GifFrame } from "@hereisit/browser-runtime/gif";
export { encodeAnimatedGif } from "@hereisit/browser-runtime/gif";

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) {
    throw new RangeError(`${label} must be between 1 and 4096.`);
  }
}

export function sanitizeHtmlMarkup(value: string): string {
  const limited = value.slice(0, 100_000);
  return limited
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:iframe|object|embed|link|meta|base)[^>]*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (_match, doubleQuoted, singleQuoted, unquoted) => {
        const style = String(doubleQuoted ?? singleQuoted ?? unquoted ?? "")
          .replace(/url\s*\([^)]*\)/gi, "")
          .replace(/(?:expression|behavior|-moz-binding|javascript\s*:|@import)/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        if (style === "") return "";
        const escaped = style
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return ` style="${escaped}"`;
      },
    )
    .replace(
      /\s+(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (match, _name, doubleQuoted, singleQuoted, unquoted) => {
        const target = String(doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
        return /^(?:javascript:|https?:|data:)/i.test(target) ? "" : match;
      },
    );
}

export type EditorFilter = "none" | "warm" | "cool" | "vintage" | "mono";

const EDITOR_FILTERS: Record<EditorFilter, string> = {
  none: "",
  warm: "sepia(0.12) saturate(1.15) hue-rotate(-8deg)",
  cool: "saturate(1.05) hue-rotate(12deg) contrast(1.03)",
  vintage: "sepia(0.28) contrast(1.08) saturate(0.82)",
  mono: "grayscale(1)",
};

export function editorFilterCss(filter: EditorFilter): string {
  return EDITOR_FILTERS[filter];
}

export interface DetectedFaceBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NormalizedFaceRegion {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function normalizeFaceRegions(
  boxes: readonly DetectedFaceBox[],
  imageWidth: number,
  imageHeight: number,
): NormalizedFaceRegion[] {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return [];
  }
  const regions: NormalizedFaceRegion[] = [];
  for (const box of boxes.slice(0, 20)) {
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height) ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      continue;
    }
    const padding = Math.max(box.width, box.height) * 0.2;
    const left = Math.max(0, box.x - padding);
    const top = Math.max(0, box.y - padding);
    const right = Math.min(imageWidth, box.x + box.width + padding);
    const bottom = Math.min(imageHeight, box.y + box.height + padding);
    if (right <= left || bottom <= top) continue;
    regions.push({
      id: `face-${regions.length}`,
      x: left / imageWidth,
      y: top / imageHeight,
      width: (right - left) / imageWidth,
      height: (bottom - top) / imageHeight,
    });
  }
  return regions;
}

export function removeBackgroundPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): Uint8ClampedArray {
  assertDimension(width, "width");
  assertDimension(height, "height");
  const total = width * height;
  if (pixels.length !== total * 4) throw new RangeError("RGBA image length mismatch.");
  const threshold = Math.min(255, Math.max(0, Math.round(tolerance))) ** 2;
  const borderIndices = new Set<number>();
  const borderStep = Math.max(1, Math.ceil(Math.max(width, height) / 64));
  for (let x = 0; x < width; x += borderStep) {
    borderIndices.add(x);
    borderIndices.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += borderStep) {
    borderIndices.add(y * width);
    borderIndices.add(y * width + width - 1);
  }
  borderIndices.add(0);
  borderIndices.add(width - 1);
  borderIndices.add((height - 1) * width);
  borderIndices.add(total - 1);
  const borderColors = [...borderIndices].map((index) => {
    const offset = index * 4;
    return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0] as const;
  });
  const medianChannel = (channel: 0 | 1 | 2): number => {
    const values = borderColors.map((color) => color[channel]).sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  const background = [medianChannel(0), medianChannel(1), medianChannel(2)] as const;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const matchesBackground = (index: number): boolean => {
    const offset = index * 4;
    const dr = (pixels[offset] ?? 0) - background[0];
    const dg = (pixels[offset + 1] ?? 0) - background[1];
    const db = (pixels[offset + 2] ?? 0) - background[2];
    return dr * dr + dg * dg + db * db <= threshold;
  };
  for (const index of borderIndices) {
    if (!matchesBackground(index)) continue;
    if (visited[index] === 1) continue;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  }
  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    if (!matchesBackground(index)) continue;
    pixels[index * 4 + 3] = 0;
    const x = index % width;
    const neighbors = [index - 1, index + 1, index - width, index + width];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || neighbor >= total || visited[neighbor] === 1) continue;
      if ((neighbor === index - 1 && x === 0) || (neighbor === index + 1 && x === width - 1))
        continue;
      visited[neighbor] = 1;
      queue[tail] = neighbor;
      tail += 1;
    }
  }
  return pixels;
}

export function clampControl(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}
