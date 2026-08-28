export interface GifFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

const GIF_HEADER = new TextEncoder().encode("GIF89a");

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4096) {
    throw new RangeError(`${label} must be between 1 and 4096.`);
  }
}

function pushLittleEndian16(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function create332Palette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const red = (index >>> 5) & 0x07;
    const green = (index >>> 2) & 0x07;
    const blue = index & 0x03;
    palette[index * 3] = Math.round((red * 255) / 7);
    palette[index * 3 + 1] = Math.round((green * 255) / 7);
    palette[index * 3 + 2] = Math.round((blue * 255) / 3);
  }
  return palette;
}

function rgbaTo332(pixels: Uint8ClampedArray, expectedPixels: number): Uint8Array {
  if (pixels.length !== expectedPixels * 4) throw new RangeError("RGBA frame length mismatch.");
  const indices = new Uint8Array(expectedPixels);
  for (let pixel = 0; pixel < expectedPixels; pixel += 1) {
    const offset = pixel * 4;
    indices[pixel] =
      ((pixels[offset] ?? 0) & 0xe0) |
      (((pixels[offset + 1] ?? 0) & 0xe0) >>> 3) |
      ((pixels[offset + 2] ?? 0) >>> 6);
  }
  return indices;
}

function lzwEncode(indices: Uint8Array): Uint8Array {
  const clearCode = 256;
  const endCode = 257;
  const maxCode = 4095;
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = 9;

  const writeCode = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  const resetDictionary = (): Map<string, number> => {
    codeSize = 9;
    return new Map();
  };

  let dictionary = resetDictionary();
  let nextCode = endCode + 1;
  writeCode(clearCode);

  if (indices.length > 0) {
    let current = indices[0] ?? 0;
    for (let index = 1; index < indices.length; index += 1) {
      const next = indices[index] ?? 0;
      const key = `${current},${next}`;
      const existing = dictionary.get(key);
      if (existing !== undefined) {
        current = existing;
        continue;
      }
      writeCode(current);
      if (nextCode <= maxCode) {
        dictionary.set(key, nextCode);
        nextCode += 1;
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      } else {
        writeCode(clearCode);
        dictionary = resetDictionary();
        nextCode = endCode + 1;
      }
      current = next;
    }
    writeCode(current);
  }

  writeCode(endCode);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  return Uint8Array.from(bytes);
}

function pushSubBlocks(target: number[], data: Uint8Array): void {
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.subarray(offset, offset + 255);
    target.push(chunk.length, ...chunk);
  }
  target.push(0);
}

export function encodeAnimatedGif(
  frames: readonly GifFrame[],
  options: { readonly delayMs: number; readonly loop: boolean },
): ArrayBuffer {
  if (frames.length < 1 || frames.length > 20) throw new RangeError("GIF frame count is invalid.");
  const first = frames[0];
  if (first === undefined) throw new RangeError("GIF needs at least one frame.");
  assertDimension(first.width, "width");
  assertDimension(first.height, "height");
  const expectedPixels = first.width * first.height;
  const delay = Math.min(65535, Math.max(0, Math.round(options.delayMs / 10)));
  const output: number[] = [...GIF_HEADER];
  pushLittleEndian16(output, first.width);
  pushLittleEndian16(output, first.height);
  output.push(0xf7, 0, 0);
  output.push(...create332Palette());
  if (options.loop)
    output.push(0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);

  for (const frame of frames) {
    if (frame.width !== first.width || frame.height !== first.height) {
      throw new RangeError("GIF frames must have identical dimensions.");
    }
    const indices = rgbaTo332(frame.pixels, expectedPixels);
    output.push(0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >>> 8) & 0xff, 0x00, 0x00);
    output.push(0x2c, 0, 0, 0, 0);
    pushLittleEndian16(output, frame.width);
    pushLittleEndian16(output, frame.height);
    output.push(0x00, 0x08);
    pushSubBlocks(output, lzwEncode(indices));
  }
  output.push(0x3b);
  return Uint8Array.from(output).buffer;
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
  const cornerColors = [0, width - 1, (height - 1) * width, total - 1].map((index) => {
    const offset = index * 4;
    return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0] as const;
  });
  const medianChannel = (channel: 0 | 1 | 2): number => {
    const values = cornerColors.map((color) => color[channel]).sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  const background = [medianChannel(0), medianChannel(1), medianChannel(2)] as const;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (const index of [0, width - 1, (height - 1) * width, total - 1]) {
    if (visited[index] === 1) continue;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  }
  const matchesBackground = (index: number): boolean => {
    const offset = index * 4;
    const dr = (pixels[offset] ?? 0) - background[0];
    const dg = (pixels[offset + 1] ?? 0) - background[1];
    const db = (pixels[offset + 2] ?? 0) - background[2];
    return dr * dr + dg * dg + db * db <= threshold;
  };
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
