import type { ImageOptimizeSpecV1 } from "@hereisit/tool-contracts/image-optimize";
import { describe, expect, it, vi } from "vitest";
import { runLocalImageOptimizeFallback } from "./local-image-optimize-fallback";

const losslessSpec: ImageOptimizeSpecV1 = {
  version: 1,
  mode: "lossless",
  preset: "balanced",
  output: "same-format",
  metadata: "strip",
  orientation: "apply",
  colorSpace: "srgb",
  minimumSavingsPercent: 1,
};

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength + 2;
  return join(Uint8Array.of(0xff, marker, length >> 8, length & 0xff), payload);
}

function jpeg(): Uint8Array {
  const frame = segment(0xc0, Uint8Array.of(8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0));
  const scan = segment(0xda, Uint8Array.of(3, 1, 0, 2, 0, 3, 0, 0, 0x3f, 0));
  return join(Uint8Array.of(0xff, 0xd8), frame, scan, Uint8Array.of(1, 2, 3, 0xff, 0xd9));
}

function webp(): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode("WEBPVP8 "), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0], 20);
  return bytes;
}

function item(bytes: Uint8Array, type: string) {
  return {
    itemId: "item-1",
    file: new File([Uint8Array.from(bytes).buffer], `private.${type.split("/")[1]}`, { type }),
  };
}

describe("local image optimize fallback", () => {
  it("uses pure JPEG metadata stripping for eligible lossless input", async () => {
    const runSmart = vi.fn();
    await expect(
      runLocalImageOptimizeFallback(item(jpeg(), "image/jpeg"), losslessSpec, { runSmart }),
    ).resolves.toMatchObject({ status: "fulfilled", mime: "image/jpeg", warnings: [] });
    expect(runSmart).not.toHaveBeenCalled();
  });

  it("requires the server for lossless WebP without invoking Canvas", async () => {
    const runSmart = vi.fn();
    await expect(
      runLocalImageOptimizeFallback(item(webp(), "image/webp"), losslessSpec, { runSmart }),
    ).resolves.toEqual({
      status: "unsupported",
      itemId: "item-1",
      reason: "LOSSLESS_SERVER_REQUIRED",
    });
    expect(runSmart).not.toHaveBeenCalled();
  });

  it("loads the smart executor only for an explicit smart request", async () => {
    const runSmart = vi.fn().mockResolvedValue({
      status: "fulfilled",
      itemId: "item-1",
      mime: "image/jpeg",
      bytes: new ArrayBuffer(1),
      byteLength: 1,
      width: 1,
      height: 1,
      warnings: [],
    });
    await runLocalImageOptimizeFallback(
      item(jpeg(), "image/jpeg"),
      { ...losslessSpec, mode: "smart" },
      { runSmart },
    );
    expect(runSmart).toHaveBeenCalledTimes(1);
  });
});
