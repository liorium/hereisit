import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "./bounded-json";

const maximumBytes = 16_384;

function makeStreamingRequest(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
  hooks: {
    onPull?: () => void;
    onCancel?: () => void;
  } = {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.();
      const chunk = chunks[index];
      index += 1;
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
    duplex: "half" as const,
  };
  return new Request("https://api.example/v1/policy", init);
}

function trackBodyAccess(request: Request, onBodyAccess: () => void): Request {
  return new Proxy(request, {
    get(target, property) {
      if (property === "body") {
        onBodyAccess();
      }
      return Reflect.get(target, property, target);
    },
  });
}

describe("readBoundedJson", () => {
  it("rejects an oversized declared body without pulling the stream", async () => {
    const onBodyAccess = vi.fn();
    const request = trackBodyAccess(
      makeStreamingRequest([new Uint8Array([123, 125])], {
        "content-length": `${maximumBytes + 1}`,
      }),
      onBodyAccess,
    );

    await expect(readBoundedJson(request, maximumBytes)).rejects.toThrow(/too large/i);
    expect(onBodyAccess).not.toHaveBeenCalled();
  });

  it("stream-counts chunked bodies and cancels immediately after crossing the bound", async () => {
    const onCancel = vi.fn();
    const chunks = [
      new Uint8Array(maximumBytes).fill(32),
      new Uint8Array([32]),
      new Uint8Array(8_000).fill(32),
    ];
    const request = makeStreamingRequest(chunks, {}, { onCancel });

    await expect(readBoundedJson(request, maximumBytes)).rejects.toThrow(/too large/i);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    "gzip",
    "br",
    "deflate",
    "identity, gzip",
  ])("rejects non-identity content encoding %s before reading", async (encoding) => {
    const onBodyAccess = vi.fn();
    const request = trackBodyAccess(
      makeStreamingRequest([new TextEncoder().encode("{}")], {
        "content-encoding": encoding,
      }),
      onBodyAccess,
    );

    await expect(readBoundedJson(request)).rejects.toThrow(/content-encoding/i);
    expect(onBodyAccess).not.toHaveBeenCalled();
  });

  it("accepts an explicit identity content encoding", async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    const request = makeStreamingRequest([bytes], {
      "content-encoding": "Identity",
      "content-length": `${bytes.byteLength}`,
    });

    await expect(readBoundedJson(request)).resolves.toEqual({ ok: true });
  });

  it.each([
    "-1",
    "1.5",
    "NaN",
    "01",
    `${Number.MAX_SAFE_INTEGER + 1}`,
  ])("rejects invalid Content-Length %s", async (contentLength) => {
    const request = makeStreamingRequest([new TextEncoder().encode("{}")], {
      "content-length": contentLength,
    });

    await expect(readBoundedJson(request)).rejects.toThrow(/content-length/i);
  });

  it("rejects a body whose streamed byte count differs from Content-Length", async () => {
    const bytes = new TextEncoder().encode("{}");
    const request = makeStreamingRequest([bytes], {
      "content-length": `${bytes.byteLength + 1}`,
    });

    await expect(readBoundedJson(request)).rejects.toThrow(/content-length/i);
  });

  it("still stream-counts a false-small Content-Length body against the real byte bound", async () => {
    const oversizedBody = new Uint8Array(maximumBytes + 1).fill(32);
    const request = makeStreamingRequest([oversizedBody], {
      "content-length": "2",
    });

    await expect(readBoundedJson(request, maximumBytes)).rejects.toThrow(/too large/i);
  });

  it.each([
    '{"unterminated":',
    "[1,2,]",
    '{"duplicate":"syntax",}',
    "",
  ])("rejects malformed JSON without buffering through Request helpers", async (body) => {
    const jsonSpy = vi.spyOn(Request.prototype, "json");
    const arrayBufferSpy = vi.spyOn(Request.prototype, "arrayBuffer");
    const bytes = new TextEncoder().encode(body);
    const request = makeStreamingRequest([bytes], {
      "content-length": `${bytes.byteLength}`,
    });

    await expect(readBoundedJson(request)).rejects.toThrow(/json/i);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 rather than silently replacing bytes", async () => {
    const request = makeStreamingRequest([new Uint8Array([0x7b, 0xff, 0x7d])]);

    await expect(readBoundedJson(request)).rejects.toThrow(/utf-8|json/i);
  });

  it("parses valid multi-chunk UTF-8 JSON at the byte boundary", async () => {
    const body = JSON.stringify({ message: "안녕하세요", values: [1, 2, 3] });
    const bytes = new TextEncoder().encode(body);
    const splitAt = Math.floor(bytes.byteLength / 2);
    const request = makeStreamingRequest([bytes.slice(0, splitAt), bytes.slice(splitAt)], {
      "content-length": `${bytes.byteLength}`,
    });
    const jsonSpy = vi.spyOn(Request.prototype, "json");
    const arrayBufferSpy = vi.spyOn(Request.prototype, "arrayBuffer");

    await expect(readBoundedJson(request, bytes.byteLength)).resolves.toEqual({
      message: "안녕하세요",
      values: [1, 2, 3],
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("requires an application/json media type and a readable body", async () => {
    await expect(
      readBoundedJson(
        new Request("https://api.example/v1/policy", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
      ),
    ).rejects.toThrow(/content-type/i);

    await expect(
      readBoundedJson(
        new Request("https://api.example/v1/policy", {
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow(/body/i);
  });
});
