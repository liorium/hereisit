import type { ImageOptimizeWorkerEvent } from "@hereisit/tool-contracts/image-optimize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileFormatMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  orientation: vi.fn(() => 1),
  stripJpeg: vi.fn((bytes: ArrayBuffer) => bytes.slice(0)),
  stripPng: vi.fn((bytes: ArrayBuffer) => bytes.slice(0)),
}));

vi.mock("@hereisit/image-tool", () => ({
  inspectImageHeader: fileFormatMocks.inspect,
  readJpegExifOrientation: fileFormatMocks.orientation,
  stripJpegMetadata: fileFormatMocks.stripJpeg,
  stripPngMetadata: fileFormatMocks.stripPng,
}));

class StubWorkerScope {
  readonly posts: Array<{ event: unknown; transfer: readonly Transferable[] }> = [];
  onmessage: ((message: MessageEvent<unknown>) => void) | null = null;

  postMessage(event: unknown, transfer: readonly Transferable[] = []): void {
    this.posts.push({ event, transfer });
  }

  dispatch(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

function file(bytes = Uint8Array.of(1, 2, 3), name = "photo.png", type = "image/png"): File {
  return new File([bytes], name, { type });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request(type: "inspect" | "lossless", source = file()): Record<string, unknown> {
  return {
    protocol: 1,
    type,
    jobId: "job-1",
    input: { name: source.name, mimeHint: source.type, byteLength: source.size, file: source },
  };
}

function terminal(scope: StubWorkerScope): ImageOptimizeWorkerEvent[] {
  return scope.posts
    .map(({ event }) => event)
    .filter(
      (event): event is ImageOptimizeWorkerEvent =>
        typeof event === "object" &&
        event !== null &&
        ["inspected", "complete", "unsupported", "failed"].includes(
          (event as { type?: unknown }).type as string,
        ),
    );
}

async function loadWorker(): Promise<StubWorkerScope> {
  const scope = new StubWorkerScope();
  vi.stubGlobal("self", scope);
  await import("./image-optimize.worker");
  return scope;
}

beforeEach(() => {
  vi.resetModules();
  fileFormatMocks.inspect.mockReset();
  fileFormatMocks.orientation.mockReset();
  fileFormatMocks.orientation.mockReturnValue(1);
  fileFormatMocks.stripJpeg.mockClear();
  fileFormatMocks.stripPng.mockClear();
  fileFormatMocks.inspect.mockReturnValue({
    mime: "image/png",
    width: 1,
    height: 1,
    animated: false,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("image optimize Worker", () => {
  it("reads the native File inside the Worker and returns a validated inspection", async () => {
    const source = file();
    const read = vi.spyOn(source, "arrayBuffer");
    const scope = await loadWorker();

    scope.dispatch(request("inspect", source));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(read).toHaveBeenCalledOnce();
    expect(terminal(scope)).toEqual([
      {
        protocol: 1,
        type: "inspected",
        jobId: "job-1",
        result: { mime: "image/png", width: 1, height: 1, animated: false },
      },
    ]);
  });

  it("rejects forged envelopes and matching zero or over-limit files safely", async () => {
    const scope = await loadWorker();
    const zero = file(new Uint8Array(), "zero.png");
    const forged = request("inspect", file());
    (forged.input as { mimeHint: string }).mimeHint = "image/jpeg";

    scope.dispatch({ ...request("inspect", zero), jobId: "zero" });
    scope.dispatch(forged);

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(2));
    expect(terminal(scope)).toMatchObject([
      { type: "failed", jobId: "zero", error: { code: "MEMORY_LIMIT", retryable: false } },
      { type: "failed", jobId: "job-1", error: { code: "INVALID_SPEC", retryable: false } },
    ]);
  });

  it("maps a real file larger than 30MiB to the memory limit without reading it", async () => {
    const scope = await loadWorker();
    const oversized = file(new Uint8Array(30 * 1024 * 1024 + 1), "large.png");
    const read = vi.spyOn(oversized, "arrayBuffer");

    scope.dispatch(request("inspect", oversized));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(terminal(scope)[0]).toMatchObject({ type: "failed", error: { code: "MEMORY_LIMIT" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects hostile file buffers or read failures without exposing private details", async () => {
    const scope = await loadWorker();
    const wrongLength = file();
    const readFailure = file();
    vi.spyOn(wrongLength, "arrayBuffer").mockResolvedValueOnce(new ArrayBuffer(2));
    vi.spyOn(readFailure, "arrayBuffer").mockRejectedValueOnce(new Error("PRIVATE_READ_DETAIL"));

    scope.dispatch({ ...request("inspect", wrongLength), jobId: "wrong-length" });
    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    scope.dispatch({ ...request("inspect", readFailure), jobId: "read-failure" });

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(2));
    expect(terminal(scope)).toMatchObject([
      { type: "failed", error: { code: "CORRUPT_INPUT" } },
      { type: "failed", error: { code: "CORRUPT_INPUT" } },
    ]);
    expect(JSON.stringify(terminal(scope))).not.toContain("PRIVATE_READ_DETAIL");
  });

  it("strips eligible PNG bytes and transfers only the successful output", async () => {
    const scope = await loadWorker();
    const output = Uint8Array.of(9, 8).buffer;
    fileFormatMocks.stripPng.mockReturnValueOnce(output);

    scope.dispatch(request("lossless"));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(terminal(scope)[0]).toMatchObject({
      type: "complete",
      result: { mime: "image/png", byteLength: 2, width: 1, height: 1, warnings: [] },
    });
    expect(scope.posts.at(-1)?.transfer).toEqual([output]);
  });

  it("inspects and strips an eligible JPEG before transferring the result", async () => {
    const scope = await loadWorker();
    const output = Uint8Array.of(8, 7, 6).buffer;
    fileFormatMocks.inspect.mockReturnValue({
      mime: "image/jpeg",
      width: 2,
      height: 1,
      animated: false,
    });
    fileFormatMocks.stripJpeg.mockReturnValueOnce(output);

    scope.dispatch(request("lossless", file(Uint8Array.of(1, 2, 3), "photo.jpg", "image/jpeg")));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(fileFormatMocks.stripJpeg).toHaveBeenCalledOnce();
    expect(terminal(scope)[0]).toMatchObject({
      type: "complete",
      result: { mime: "image/jpeg", byteLength: 3, width: 2, height: 1 },
    });
    expect(scope.posts.at(-1)?.transfer).toEqual([output]);
  });

  it("bounds metadata-strip exceptions without exposing private details", async () => {
    const scope = await loadWorker();
    fileFormatMocks.stripPng.mockImplementationOnce(() => {
      throw new Error("PRIVATE_STRIP_DETAIL");
    });

    scope.dispatch(request("lossless"));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(terminal(scope)[0]).toMatchObject({ type: "failed", error: { code: "CORRUPT_INPUT" } });
    expect(JSON.stringify(terminal(scope))).not.toContain("PRIVATE_STRIP_DETAIL");
  });

  it("keeps WebP and metadata-sensitive JPEG or PNG work on the server", async () => {
    const scope = await loadWorker();
    fileFormatMocks.inspect.mockReturnValueOnce({
      mime: "image/webp",
      width: 1,
      height: 1,
      animated: false,
    });

    scope.dispatch(request("lossless"));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(terminal(scope)).toEqual([
      { protocol: 1, type: "unsupported", jobId: "job-1", reason: "LOSSLESS_SERVER_REQUIRED" },
    ]);
  });

  it.each([
    [
      "a rotated JPEG",
      "image/jpeg",
      Uint8Array.of(1, 2, 3),
      { mime: "image/jpeg", width: 1, height: 1, animated: false },
      6,
    ],
    [
      "a JPEG ICC profile",
      "image/jpeg",
      new TextEncoder().encode("ICC_PROFILE\0"),
      { mime: "image/jpeg", width: 1, height: 1, animated: false },
      1,
    ],
    [
      "a PNG iCCP chunk",
      "image/png",
      new TextEncoder().encode("iCCP"),
      { mime: "image/png", width: 1, height: 1, animated: false },
      1,
    ],
  ])("keeps %s on the server", async (_label, type, bytes, inspected, orientation) => {
    const scope = await loadWorker();
    fileFormatMocks.inspect.mockReturnValueOnce(inspected);
    fileFormatMocks.orientation.mockReturnValueOnce(orientation);

    scope.dispatch(request("lossless", file(bytes, "photo", type)));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(terminal(scope)[0]).toMatchObject({
      type: "unsupported",
      reason: "LOSSLESS_SERVER_REQUIRED",
    });
  });

  it("rejects animated and over-40MP lossless sources while inspection reports their metadata", async () => {
    const scope = await loadWorker();
    fileFormatMocks.inspect
      .mockReturnValueOnce({ mime: "image/heic", width: 10, height: 20, animated: true })
      .mockReturnValueOnce({ mime: "image/png", width: 8000, height: 5001, animated: false });

    scope.dispatch({ ...request("inspect"), jobId: "inspect" });
    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    scope.dispatch({ ...request("lossless"), jobId: "large" });

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(2));
    expect(terminal(scope)).toMatchObject([
      { type: "inspected", jobId: "inspect", result: { mime: "image/heic", animated: true } },
      { type: "failed", jobId: "large", error: { code: "DIMENSION_LIMIT" } },
    ]);
  });

  it("rejects lossless dimensions above the per-axis limit while inspection returns them", async () => {
    const scope = await loadWorker();
    fileFormatMocks.inspect
      .mockReturnValueOnce({ mime: "image/png", width: 32_769, height: 1, animated: false })
      .mockReturnValueOnce({ mime: "image/png", width: 32_769, height: 1, animated: false });

    scope.dispatch({ ...request("inspect"), jobId: "inspect" });
    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    scope.dispatch({ ...request("lossless"), jobId: "lossless" });

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(2));
    expect(terminal(scope)).toMatchObject([
      { type: "inspected", result: { width: 32_769 } },
      { type: "failed", error: { code: "DIMENSION_LIMIT" } },
    ]);
  });

  it("rejects hostile file reads, concurrent jobs, and a cancelled read without late completion", async () => {
    const blocked = deferred<ArrayBuffer>();
    const source = file();
    vi.spyOn(source, "arrayBuffer").mockReturnValueOnce(blocked.promise);
    const scope = await loadWorker();

    scope.dispatch({ ...request("inspect", source), jobId: "slow" });
    scope.dispatch({ ...request("inspect"), jobId: "other" });
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "slow" });
    blocked.resolve(Uint8Array.of(1, 2, 3).buffer);

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(2));
    expect(terminal(scope)).toMatchObject([
      { type: "failed", jobId: "other", error: { code: "WORKER_CRASH" } },
      { type: "failed", jobId: "slow", error: { code: "CANCELLED" } },
    ]);
    expect(
      terminal(scope).some((event) => event.type === "inspected" && event.jobId === "slow"),
    ).toBe(false);
  });

  it("releases cancelled ownership so the next request can run", async () => {
    const blocked = deferred<ArrayBuffer>();
    const source = file();
    vi.spyOn(source, "arrayBuffer").mockReturnValueOnce(blocked.promise);
    const scope = await loadWorker();

    scope.dispatch({ ...request("inspect", source), jobId: "slow" });
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "slow" });
    blocked.resolve(Uint8Array.of(1, 2, 3).buffer);
    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));

    scope.dispatch({ ...request("inspect"), jobId: "next" });
    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(2));
    expect(terminal(scope)).toMatchObject([
      { type: "failed", jobId: "slow", error: { code: "CANCELLED" } },
      { type: "inspected", jobId: "next" },
    ]);
  });

  it("bounds parser failures without exposing private exception text", async () => {
    const scope = await loadWorker();
    fileFormatMocks.inspect.mockImplementationOnce(() => {
      throw new Error("PRIVATE_IMAGE_PARSE_DETAIL");
    });

    scope.dispatch(request("inspect"));

    await vi.waitFor(() => expect(terminal(scope)).toHaveLength(1));
    expect(terminal(scope)[0]).toMatchObject({ type: "failed", error: { code: "CORRUPT_INPUT" } });
    expect(JSON.stringify(terminal(scope))).not.toContain("PRIVATE_IMAGE_PARSE_DETAIL");
  });
});
