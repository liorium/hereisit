import type {
  PdfThumbnailProgress,
  PdfThumbnailResult,
  PdfThumbnailRunRequest,
  PdfThumbnailUpdate,
} from "@hereisit/tool-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMocks = vi.hoisted(() => ({
  run: vi.fn(),
  toErrorPayload: vi.fn(),
}));

vi.mock("./pdf-thumbnail-pipeline", () => ({
  runPdfThumbnailPipeline: pipelineMocks.run,
  toPdfThumbnailErrorPayload: pipelineMocks.toErrorPayload,
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

class WorkerProbeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}

  getContext(): object {
    return {};
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob();
  }
}

function runRequest(overrides: Record<string, unknown> = {}): PdfThumbnailRunRequest {
  const bytes = new TextEncoder().encode("%PDF-1.7").buffer;
  return {
    protocol: 1,
    type: "run",
    jobId: "job-1",
    tool: "pdf.thumbnail",
    toolVersion: 1,
    input: {
      name: "private.pdf",
      mimeHint: "application/pdf",
      byteLength: bytes.byteLength,
      bytes,
    },
    ...overrides,
  } as PdfThumbnailRunRequest;
}

async function loadWorker(): Promise<StubWorkerScope> {
  const scope = new StubWorkerScope();
  vi.stubGlobal("self", scope);
  vi.stubGlobal("OffscreenCanvas", WorkerProbeCanvas);
  await import("./pdf-thumbnail.worker");
  return scope;
}

async function flushWorker(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  pipelineMocks.run.mockReset();
  pipelineMocks.toErrorPayload.mockReset();
  pipelineMocks.toErrorPayload.mockReturnValue({
    code: "WORKER_CRASH",
    message: "미리보기 실패",
    retryable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PDF thumbnail Worker", () => {
  it("announces the exact versioned capability", async () => {
    const scope = await loadWorker();

    expect(scope.posts).toEqual([
      {
        event: {
          protocol: 1,
          type: "ready",
          capabilities: { tool: "pdf.thumbnail", toolVersion: 1 },
        },
        transfer: [],
      },
    ]);
  });

  it("ignores malformed input and rejects an exact tool mismatch", async () => {
    const scope = await loadWorker();
    scope.dispatch(null);
    scope.dispatch(runRequest({ input: { bytes: new ArrayBuffer(1), byteLength: 2 } }));
    scope.dispatch(runRequest({ jobId: "wrong-tool", tool: "pdf.merge" }));
    await flushWorker();

    expect(pipelineMocks.run).not.toHaveBeenCalled();
    expect(scope.posts.at(-1)).toMatchObject({
      event: { type: "failed", jobId: "wrong-tool", error: { code: "INVALID_SPEC" } },
    });
  });

  it("streams progress and thumbnails before one completion", async () => {
    const update: PdfThumbnailUpdate = {
      status: "ready",
      sourcePage: 1,
      width: 160,
      height: 80,
      mime: "image/webp",
      bytes: new ArrayBuffer(12),
    };
    const progress: PdfThumbnailProgress = { completedPages: 1, totalPages: 1, fraction: 1 };
    const result: PdfThumbnailResult = {
      pageCount: 1,
      renderedPageCount: 1,
      failedPageCount: 0,
      omittedPageCount: 0,
    };
    pipelineMocks.run.mockImplementation(
      async (
        _input: unknown,
        options: {
          onThumbnail(update: PdfThumbnailUpdate): void;
          onProgress(progress: PdfThumbnailProgress): void;
        },
      ) => {
        options.onThumbnail(update);
        options.onProgress(progress);
        return result;
      },
    );
    const scope = await loadWorker();
    scope.dispatch(runRequest());
    await vi.waitFor(() =>
      expect(
        scope.posts.some(({ event }) => (event as { type?: string }).type === "complete"),
      ).toBe(true),
    );

    const streamed = scope.posts.filter(
      ({ event }) => (event as { jobId?: string }).jobId === "job-1",
    );
    expect(streamed.map(({ event }) => (event as { type: string }).type)).toEqual([
      "thumbnail",
      "progress",
      "complete",
    ]);
    expect(streamed[0]?.transfer).toEqual([update.bytes]);
    expect(streamed[1]?.transfer).toEqual([]);
  });

  it("cancels the active pipeline and suppresses a late terminal event", async () => {
    let signal: AbortSignal | undefined;
    pipelineMocks.run.mockImplementation((_input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<PdfThumbnailResult>(() => undefined);
    });
    const scope = await loadWorker();
    scope.dispatch(runRequest());
    await vi.waitFor(() => expect(pipelineMocks.run).toHaveBeenCalledOnce());
    scope.dispatch({ protocol: 1, type: "cancel", jobId: "job-1" });

    expect(signal?.aborted).toBe(true);
    expect(
      scope.posts.filter(({ event }) => (event as { jobId?: string }).jobId === "job-1"),
    ).toEqual([]);
  });
});
