export interface GifFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly delayMs?: number;
}

const GIF_HEADER = new TextEncoder().encode("GIF89a");
const MAX_FRAMES = 20;
export const MAX_GIF_TOTAL_PIXELS = 50_000_000;

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) {
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
  if (frames.length < 1 || frames.length > MAX_FRAMES) {
    throw new RangeError("GIF frame count is invalid.");
  }
  const first = frames[0];
  if (first === undefined) throw new RangeError("GIF needs at least one frame.");
  assertDimension(first.width, "width");
  assertDimension(first.height, "height");
  const expectedPixels = first.width * first.height;
  if (expectedPixels * frames.length > MAX_GIF_TOTAL_PIXELS) {
    throw new RangeError("GIF pixel budget is too large.");
  }

  const output: number[] = [...GIF_HEADER];
  pushLittleEndian16(output, first.width);
  pushLittleEndian16(output, first.height);
  output.push(0xf7, 0, 0);
  output.push(...create332Palette());
  if (options.loop) {
    output.push(0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  }

  for (const frame of frames) {
    if (frame.width !== first.width || frame.height !== first.height) {
      throw new RangeError("GIF frames must have identical dimensions.");
    }
    const indices = rgbaTo332(frame.pixels, expectedPixels);
    const delay = Math.min(65535, Math.max(0, Math.round((frame.delayMs ?? options.delayMs) / 10)));
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

export interface DecodedGifAnimation {
  readonly frames: readonly GifFrame[];
  readonly loop: boolean;
}

function decoderConstructor(): typeof ImageDecoder | undefined {
  return (globalThis as typeof globalThis & { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
}

function closeCanvas(canvas: OffscreenCanvas | undefined): void {
  if (canvas === undefined) return;
  try {
    canvas.width = 0;
  } catch {
    // Release is best effort after a frame has been copied.
  }
  try {
    canvas.height = 0;
  } catch {
    // Release is best effort after a frame has been copied.
  }
}

export function supportsAnimatedGifDecode(): boolean {
  return decoderConstructor() !== undefined && typeof OffscreenCanvas !== "undefined";
}

export async function decodeGifAnimation(
  bytes: ArrayBuffer,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<DecodedGifAnimation> {
  const Decoder = decoderConstructor();
  if (Decoder === undefined || typeof OffscreenCanvas === "undefined") {
    throw new Error("Animated GIF decoding is unavailable.");
  }
  assertDimension(width, "width");
  assertDimension(height, "height");
  signal.throwIfAborted();
  const decoder = new Decoder({ data: bytes, type: "image/gif", preferAnimation: true });
  try {
    await decoder.completed;
    signal.throwIfAborted();
    const track = decoder.tracks.selectedTrack;
    if (track === null || track.frameCount < 1 || track.frameCount > MAX_FRAMES) {
      throw new RangeError("GIF frame count is invalid.");
    }
    const totalPixels = width * height * track.frameCount;
    if (!Number.isSafeInteger(totalPixels) || totalPixels > MAX_GIF_TOTAL_PIXELS) {
      throw new RangeError("GIF pixel budget is too large.");
    }

    const frames: GifFrame[] = [];
    for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex += 1) {
      signal.throwIfAborted();
      const decoded = await decoder.decode({ frameIndex, completeFramesOnly: true });
      const image = decoded.image;
      let canvas: OffscreenCanvas | undefined;
      try {
        if (image.displayWidth !== width || image.displayHeight !== height) {
          throw new Error("GIF frame dimensions differ.");
        }
        canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
        if (context === null) throw new Error("GIF frame canvas is unavailable.");
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        frames.push({
          width,
          height,
          pixels: new Uint8ClampedArray(pixels) as Uint8ClampedArray<ArrayBuffer>,
          delayMs:
            image.duration === null || !Number.isFinite(image.duration)
              ? 100
              : Math.min(655350, Math.max(0, Math.round(image.duration / 1000))),
        });
      } finally {
        try {
          image.close();
        } catch {
          // A decoded frame may already be closed by a failed canvas operation.
        }
        closeCanvas(canvas);
      }
    }
    return { frames, loop: track.repetitionCount !== 1 };
  } finally {
    decoder.close();
  }
}
