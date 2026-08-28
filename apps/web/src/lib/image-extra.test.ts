import { describe, expect, it } from "vitest";
import {
  clampControl,
  editorFilterCss,
  encodeAnimatedGif,
  normalizeFaceRegions,
  removeBackgroundPixels,
  sanitizeHtmlMarkup,
} from "./image-extra";

describe("image extra utilities", () => {
  it("clamps numeric controls to a safe range", () => {
    expect(clampControl(Number.NaN, 0, 100)).toBe(0);
    expect(clampControl(-5, 0, 100)).toBe(0);
    expect(clampControl(42, 0, 100)).toBe(42);
    expect(clampControl(105, 0, 100)).toBe(100);
  });

  it("maps editor filters to deterministic canvas filter strings", () => {
    expect(editorFilterCss("none")).toBe("");
    expect(editorFilterCss("warm")).toContain("sepia");
    expect(editorFilterCss("cool")).toContain("hue-rotate");
    expect(editorFilterCss("vintage")).toContain("contrast");
    expect(editorFilterCss("mono")).toBe("grayscale(1)");
  });

  it("normalizes and expands detected face boxes without leaving the image", () => {
    expect(
      normalizeFaceRegions(
        [
          { x: 90, y: 30, width: 40, height: 50 },
          { x: -20, y: -10, width: 0, height: 8 },
        ],
        100,
        100,
      ),
    ).toEqual([{ id: "face-0", x: 0.8, y: 0.2, width: 0.2, height: 0.7 }]);
  });

  it("removes only connected pixels matching the corner background", () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255,
    ]);

    removeBackgroundPixels(pixels, 2, 2, 4);

    expect(Array.from(pixels)).toEqual([
      255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 0, 0, 255,
    ]);
  });

  it("sanitizes executable and remote markup before local rendering", () => {
    const sanitized = sanitizeHtmlMarkup(
      '<script>alert(1)</script><style>font-size:99px</style><div onclick="bad()" style="color:red;background:url(https://example.com/x.png)"><img src=https://example.com/x.png>안전</div>',
    );
    expect(sanitized).not.toMatch(/script|onclick|https:/i);
    expect(sanitized).toContain('style="color:red;background:"');
    expect(sanitized).not.toContain("font-size:99px");
    expect(sanitized).toContain("안전");
  });

  it("encodes one or more RGBA frames as a bounded GIF", () => {
    const frame = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const bytes = new Uint8Array(
      encodeAnimatedGif(
        [
          { width: 2, height: 2, pixels: frame },
          { width: 2, height: 2, pixels: frame },
        ],
        { delayMs: 100, loop: true },
      ),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("GIF89a");
    expect(new TextDecoder().decode(bytes)).toContain("NETSCAPE2.0");
    expect(bytes.at(-1)).toBe(0x3b);
    expect(bytes.byteLength).toBeLessThan(10_000);
  });
});
