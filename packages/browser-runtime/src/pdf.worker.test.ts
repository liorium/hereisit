import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  runFiles: vi.fn(),
  run: vi.fn(),
  toErrorPayload: vi.fn(),
}));

vi.mock("./pdf-pipeline", () => ({
  inspectPdfInput: pipelineMocks.inspect,
  runPdfFilePipeline: pipelineMocks.runFiles,
  runPdfPipeline: pipelineMocks.run,
  toPdfErrorPayload: pipelineMocks.toErrorPayload,
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

async function loadWorker(): Promise<StubWorkerScope> {
  const scope = new StubWorkerScope();
  vi.stubGlobal("self", scope);
  await import("./pdf.worker");
  return scope;
}

function inspectRequest(file: File, input: Record<string, unknown> = {}): unknown {
  return {
    protocol: 1,
    type: "inspect",
    jobId: "inspect-file",
    input: {
      name: file.name,
      mimeHint: file.type,
      byteLength: file.size,
      file,
      ...input,
    },
  };
}

async function waitForFailure(scope: StubWorkerScope): Promise<unknown> {
  await vi.waitFor(() =>
    expect(
      scope.posts.some(
        ({ event }) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "failed",
      ),
    ).toBe(true),
  );
  return scope.posts.at(-1)?.event;
}

beforeEach(() => {
  vi.resetModules();
  pipelineMocks.inspect.mockReset();
  pipelineMocks.runFiles.mockReset();
  pipelineMocks.run.mockReset();
  pipelineMocks.toErrorPayload.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PDF Worker File inspection boundary", () => {
  it.each([
    ["name", "different.pdf"],
    ["mimeHint", "text/plain"],
    ["byteLength", 1],
  ])("rejects mismatched %s metadata without inspecting bytes", async (field, value) => {
    const file = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });
    const scope = await loadWorker();

    scope.dispatch(inspectRequest(file, { [field]: value }));

    expect(await waitForFailure(scope)).toMatchObject({
      type: "failed",
      jobId: "inspect-file",
      error: { code: "CORRUPT_PDF" },
    });
    expect(pipelineMocks.inspect).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreadable File", () => Promise.reject(new Error("private detail"))],
    ["a File whose read size changed", () => Promise.resolve(new ArrayBuffer(1))],
  ])("rejects %s without inspecting bytes", async (_name, read) => {
    const file = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });
    vi.spyOn(file, "arrayBuffer").mockImplementationOnce(read);
    const scope = await loadWorker();

    scope.dispatch(inspectRequest(file));

    expect(await waitForFailure(scope)).toMatchObject({
      type: "failed",
      jobId: "inspect-file",
      error: { code: "CORRUPT_PDF" },
    });
    expect(pipelineMocks.inspect).not.toHaveBeenCalled();
  });
});
