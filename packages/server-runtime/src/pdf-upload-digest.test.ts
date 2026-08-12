import { afterEach, describe, expect, it, vi } from "vitest";
import { digestPdfFile } from "./pdf-upload-digest";

class StubWorker {
  static instances: StubWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminate = vi.fn();

  constructor() {
    StubWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  emit(message: unknown) {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  StubWorker.instances = [];
});

describe("PDF upload digest coordinator", () => {
  it("passes the native File to a Worker without reading it in the caller realm", async () => {
    vi.stubGlobal("Worker", StubWorker);
    const file = new File([Uint8Array.of(1, 2, 3)], "private.pdf", {
      type: "application/pdf",
    });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const result = digestPdfFile(file);
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("worker");
    worker.emit({ protocol: 1, type: "ready" });
    const request = worker.messages[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["file", "jobId", "protocol", "type"]);
    expect(request.file).toBe(file);
    expect(arrayBuffer).not.toHaveBeenCalled();
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: request.jobId,
      digest: "sha-256=A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=",
    });
    await expect(result).resolves.toBe("sha-256=A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
