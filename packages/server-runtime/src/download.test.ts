import type { ImageOptimizeResultDescriptor } from "@hereisit/tool-contracts/image-optimize";
import { describe, expect, it, vi } from "vitest";
import { createClientJobCredentials } from "./api-client";
import { createRemoteDownloadHandle } from "./download";

const jobId = "123e4567-e89b-42d3-a456-426614174001";
const descriptor: Extract<ImageOptimizeResultDescriptor, { kind: "download" }> = {
  kind: "download",
  mime: "image/jpeg",
  byteLength: 3,
  width: 1,
  height: 1,
  engineBuildId: "engine",
  codecBuildId: "codec",
  warnings: [],
  timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
  expiresAt: "2026-07-17T00:00:00.000Z",
};

function response() {
  return new Response(Uint8Array.of(0xff, 0xd8, 0xff), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": "3",
      "x-download-lease": createClientJobCredentials().jobToken,
    },
  });
}

describe("remote result download", () => {
  it("downloads directly without share or navigation and acknowledges after proven handoff", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return path.endsWith("/result") ? response() : new Response(null, { status: 204 });
    });
    const clickAnchor = vi.fn();
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
      createObjectURL: () => "blob:result",
      revokeObjectURL: vi.fn(),
      clickAnchor,
      confirmDownloadHandoff: async () => true,
      scheduleRevoke: (callback) => callback(),
    });
    await handle.download({ filename: "photo-hereisit.jpg" });
    expect(clickAnchor).toHaveBeenCalledWith({
      href: "blob:result",
      download: "photo-hereisit.jpg",
    });
    expect(calls).toEqual([`GET /v1/jobs/${jobId}/result`, `POST /v1/jobs/${jobId}/downloaded`]);
  });

  it("does not acknowledge from anchor click alone", async () => {
    const fetchMock = vi.fn(async () => response());
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
      createObjectURL: () => "blob:result",
      revokeObjectURL: vi.fn(),
      clickAnchor: vi.fn(),
      confirmDownloadHandoff: async () => false,
      scheduleRevoke: (callback) => callback(),
    });
    await handle.download({ filename: "result.jpg" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects archive budget before fetching and streams without making a Blob", async () => {
    const fetchMock = vi.fn(async () => response());
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
    });
    await expect(handle.fetchForArchive({ remainingByteBudget: 2 })).rejects.toMatchObject({
      code: "INPUT_LIMIT_EXCEEDED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const part = await handle.fetchForArchive({ remainingByteBudget: 3 });
    expect(new Uint8Array(await new Response(part.stream).arrayBuffer())).toEqual(
      Uint8Array.of(0xff, 0xd8, 0xff),
    );
    expect(part.byteLength).toBe(3);
  });

  it("acknowledges an archive part only after the stream is fully consumed and explicitly handed off", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).pathname.endsWith("/result")
        ? response()
        : new Response(null, { status: 204 }),
    );
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
    });
    const part = await handle.fetchForArchive({ remainingByteBudget: 3 });
    await expect(part.acknowledge()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await new Response(part.stream).arrayBuffer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await part.acknowledge();
    await part.acknowledge();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts the body independently of Content-Length before clicking", async () => {
    const clickAnchor = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(Uint8Array.of(1, 2), {
          headers: {
            "content-type": "image/jpeg",
            "content-length": "3",
            "x-download-lease": createClientJobCredentials().jobToken,
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
      createObjectURL: vi.fn(),
      clickAnchor,
      revokeObjectURL: vi.fn(),
    });
    await expect(handle.download({ filename: "result.jpg" })).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    expect(clickAnchor).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("keeps an interrupted result available for retry", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        controller.error(new TypeError("connection lost"));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          "content-type": "image/jpeg",
          "content-length": "3",
          "x-download-lease": createClientJobCredentials().jobToken,
        },
      }),
    );
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
      createObjectURL: vi.fn(),
      clickAnchor: vi.fn(),
      revokeObjectURL: vi.fn(),
    });
    await expect(handle.download({ filename: "result.jpg" })).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects MIME or length mismatches and best-effort deletes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(Uint8Array.of(1, 2), {
          headers: {
            "content-type": "image/png",
            "content-length": "2",
            "x-download-lease": createClientJobCredentials().jobToken,
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const handle = createRemoteDownloadHandle({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: createClientJobCredentials().jobToken,
      descriptor,
      fetch: fetchMock,
      createObjectURL: vi.fn(),
      clickAnchor: vi.fn(),
      revokeObjectURL: vi.fn(),
    });
    await expect(handle.download({ filename: "result.jpg" })).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
