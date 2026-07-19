import { describe, expect, it, vi } from "vitest";
import { createClientJobCredentials } from "./api-client";
import { uploadImageInput, type XhrLike } from "./upload";

const jobId = "123e4567-e89b-42d3-a456-426614174001";

class FakeXhr implements XhrLike {
  status = 204;
  timeout = 0;
  upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  readonly headers = new Map<string, string>();
  open = vi.fn();
  setRequestHeader = vi.fn((name: string, value: string) => this.headers.set(name, value));
  send = vi.fn((_body: XMLHttpRequestBodyInit | null) => {
    this.upload.onprogress?.({ loaded: 2, total: 3, lengthComputable: true } as ProgressEvent);
    this.upload.onload?.();
    this.onload?.();
  });
  abort = vi.fn(() => this.onabort?.());
}

function descriptor() {
  return {
    kind: "worker-stream-put" as const,
    method: "PUT" as const,
    path: `/v1/jobs/${jobId}/input` as const,
    contentType: "image/jpeg" as const,
    byteLength: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("remote input upload", () => {
  it("sends the original File with exact descriptor-controlled headers and progress", async () => {
    const xhr = new FakeXhr();
    const file = new File([Uint8Array.of(1, 2, 3)], "private.jpg", { type: "image/jpeg" });
    const progress = vi.fn();
    const jobToken = createClientJobCredentials().jobToken;
    await uploadImageInput({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken,
      descriptor: descriptor(),
      file,
      onProgress: progress,
      xhrFactory: () => xhr,
    });
    expect(xhr.open).toHaveBeenCalledWith(
      "PUT",
      `https://processing.example/v1/jobs/${jobId}/input`,
      true,
    );
    expect(xhr.send).toHaveBeenCalledWith(file);
    expect(xhr.headers).toEqual(
      new Map([
        ["Authorization", `Bearer ${jobToken}`],
        ["Content-Type", "image/jpeg"],
      ]),
    );
    expect(progress).toHaveBeenCalledWith(2, 3);
    expect(String(xhr.open.mock.calls)).not.toContain("private.jpg");
  });

  it("rejects descriptor confusion before creating an XHR", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "private.jpg", { type: "image/jpeg" });
    const xhrFactory = vi.fn(() => new FakeXhr());
    for (const changed of [
      { ...descriptor(), path: `/v1/jobs/${crypto.randomUUID()}/input` },
      { ...descriptor(), path: `/v1/jobs/${jobId}/../input` },
      { ...descriptor(), byteLength: 4 },
      { ...descriptor(), contentType: "image/png" },
      { ...descriptor(), headers: { "x-unsafe": "1" } },
    ]) {
      await expect(
        uploadImageInput({
          apiOrigin: "https://processing.example",
          jobId,
          jobToken: createClientJobCredentials().jobToken,
          descriptor: changed,
          file,
          xhrFactory,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(xhrFactory).not.toHaveBeenCalled();
  });

  it("maps non-2xx, network, timeout, and abort outcomes", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "x.jpg", { type: "image/jpeg" });
    const run = (configure: (xhr: FakeXhr) => void, signal?: AbortSignal) => {
      const xhr = new FakeXhr();
      configure(xhr);
      return uploadImageInput({
        apiOrigin: "https://processing.example",
        jobId,
        jobToken: createClientJobCredentials().jobToken,
        descriptor: descriptor(),
        file,
        ...(signal === undefined ? {} : { signal }),
        xhrFactory: () => xhr,
      });
    };
    await expect(run((xhr) => (xhr.status = 503))).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
    });
    await expect(run((xhr) => (xhr.send = vi.fn(() => xhr.onerror?.())))).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
    });
    await expect(run((xhr) => (xhr.send = vi.fn(() => xhr.ontimeout?.())))).rejects.toMatchObject({
      code: "UPLOAD_EXPIRED",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(run(() => undefined, controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});
