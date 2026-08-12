import { describe, expect, it } from "vitest";

describe("PDF upload digest Worker core", () => {
  it("computes canonical SHA-256 incrementally from a byte stream", async () => {
    const { digestPdfStream } = await import("./pdf-upload-digest.worker");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        controller.enqueue(Uint8Array.of(2, 3));
        controller.close();
      },
    });
    await expect(digestPdfStream(stream, new AbortController().signal)).resolves.toBe(
      "sha-256=A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=",
    );
  });

  it("matches Web Crypto across SHA-256 block boundaries", async () => {
    const { digestPdfStream } = await import("./pdf-upload-digest.worker");
    const bytes = Uint8Array.from({ length: 257 }, (_, index) => index % 251);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 13) {
          controller.enqueue(bytes.slice(offset, offset + 13));
        }
        controller.close();
      },
    });
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of hash) binary += String.fromCharCode(byte);
    await expect(digestPdfStream(stream, new AbortController().signal)).resolves.toBe(
      `sha-256=${btoa(binary)}`,
    );
  });
});
