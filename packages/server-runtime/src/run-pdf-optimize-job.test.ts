import type {
  PdfOptimizeCreateRequestV1,
  PdfOptimizeCreateResponse,
  PdfOptimizePolicyResponseV1,
  PdfOptimizeStatusResponseV1,
} from "@hereisit/tool-contracts/pdf-optimize";
import { describe, expect, it, vi } from "vitest";
import { createClientJobCredentials, RemoteJobError } from "./api-client";
import { fetchPdfOptimizeResult } from "./download";
import { runPdfOptimizeJob } from "./run-pdf-optimize-job";

const jobId = "123e4567-e89b-42d3-a456-426614174001";
const session = createClientJobCredentials().jobToken;
const digest = "sha-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

function policy(): PdfOptimizePolicyResponseV1 {
  return {
    contract: "tool-job@1",
    toolContract: "pdf.optimize@1",
    execution: "server",
    reason: null,
    maintainer: true,
    disclosure: {
      upload: true,
      inputDeletion: "terminal",
      resultDeletion: {
        mode: "server-temporary",
        acknowledged: "immediate-delete-attempt",
        unacknowledgedDueSeconds: 1800,
        applicationSloSeconds: 2100,
        lifecycleExpirationDays: 1,
        exceptionalDelayPossible: true,
      },
    },
    limits: { maxFiles: 1, maxBytesPerFile: 52_428_800, maxPagesPerFile: 100 },
  };
}

function created(): PdfOptimizeCreateResponse {
  return {
    contract: "tool-job@1",
    mode: "upload-required",
    jobId,
    reservedWeightedUnits: 1,
    upload: {
      kind: "worker-stream-put",
      method: "PUT",
      path: `/v1/jobs/${jobId}/input`,
      contentType: "application/pdf",
      byteLength: 100,
      expiresAt: "2099-08-12T01:00:00.000Z",
    },
  };
}

function status(
  state: "queued" | "running" | "succeeded" | "failed" = "succeeded",
  sequence = 1,
): PdfOptimizeStatusResponseV1 {
  const common = {
    contract: "tool-job@1" as const,
    jobId,
    sequence,
    attempt: 0,
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  if (state === "succeeded") {
    return {
      ...common,
      state,
      phase: "completed",
      phaseFraction: 1,
      result: {
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 100,
        byteLength: 90,
        pageCount: 1,
        profile: "structural",
        engineBuildId: "sha256:engine",
        warnings: ["SIGNATURES_INVALIDATED"],
      },
    };
  }
  if (state === "failed") {
    return {
      ...common,
      state,
      phase: "verifying",
      phaseFraction: null,
      error: {
        code: "VERIFICATION_FAILED",
        message: "PDF 처리 결과를 확인할 수 없습니다.",
        retryable: true,
      },
    };
  }
  return {
    ...common,
    state,
    phase: state === "queued" ? "queued" : "optimizing",
    phaseFraction: state === "queued" ? null : 0.5,
  };
}

function file(): File {
  return new File([new Uint8Array(100)], "private-report.pdf", { type: "application/pdf" });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    getPolicy: vi.fn(async () => policy()),
    createJob: vi.fn(async (_request: PdfOptimizeCreateRequestV1, _options: unknown) => created()),
    upload: vi.fn(async (_input: unknown) => undefined),
    getStatus: vi.fn(async (_input: unknown) => status()),
    download: vi.fn(async (_input: unknown) => ({
      blob: new Blob([new Uint8Array(90)], { type: "application/pdf" }),
      digest,
      acknowledge: vi.fn(async () => undefined),
    })),
    cancel: vi.fn(async (_input: unknown) => undefined),
    remove: vi.fn(async (_input: unknown) => undefined),
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
    jitter: vi.fn(() => 0),
    ...overrides,
  };
}

describe("runPdfOptimizeJob", () => {
  it("creates the exact versioned body, uploads once, polls monotonically, and never sends a filename", async () => {
    const deps = dependencies();
    vi.mocked(deps.getStatus)
      .mockResolvedValueOnce(status("running", 2))
      .mockResolvedValueOnce(status("queued", 1))
      .mockResolvedValueOnce(status("succeeded", 3));
    const input = file();
    const handle = runPdfOptimizeJob(
      input,
      { version: 1, preset: "balanced" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: deps,
      },
    );

    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    const request = vi.mocked(deps.createJob).mock.calls[0]?.[0] as PdfOptimizeCreateRequestV1;
    expect(request).toEqual({
      contract: "tool-job@1",
      toolContract: "pdf.optimize@1",
      anonymousSessionId: session,
      clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      jobToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      input: { byteLength: 100, mime: "application/pdf", pageCount: 1 },
      spec: { version: 1, preset: "balanced" },
    });
    expect(JSON.stringify(request)).not.toContain(input.name);
    expect(deps.upload).toHaveBeenCalledOnce();
  });

  it("reuses the idempotent create request after an expired upload descriptor", async () => {
    const deps = dependencies();
    vi.mocked(deps.createJob).mockResolvedValueOnce(created()).mockResolvedValueOnce({
      contract: "tool-job@1",
      mode: "existing-job",
      jobId,
      state: "queued",
      reservedWeightedUnits: 1,
    });
    vi.mocked(deps.upload)
      .mockRejectedValueOnce(new RemoteJobError("UPLOAD_EXPIRED", "expired", true))
      .mockResolvedValueOnce(undefined);
    const handle = runPdfOptimizeJob(
      file(),
      { version: 1, preset: "minimum" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: deps,
      },
    );
    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    expect(deps.createJob).toHaveBeenCalledTimes(2);
    expect(deps.createJob.mock.calls[0]?.[0]).toEqual(deps.createJob.mock.calls[1]?.[0]);
  });

  it("returns original-retained without download and deletes terminal state", async () => {
    const retained = status("succeeded");
    if (retained.state !== "succeeded") throw new Error("fixture");
    const deps = dependencies({
      getStatus: vi.fn(
        async () =>
          ({
            ...retained,
            result: {
              kind: "original-retained",
              sourceByteLength: 100,
              pageCount: 1,
              engineBuildId: "sha256:engine",
              warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
            },
          }) satisfies PdfOptimizeStatusResponseV1,
      ),
    });
    const handle = runPdfOptimizeJob(
      file(),
      { version: 1, preset: "balanced" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: deps,
      },
    );
    await expect(handle.result).resolves.toMatchObject({ status: "original-retained" });
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.remove).toHaveBeenCalledOnce();
  });

  it("cancels and deletes a started job exactly once while ignoring a late success", async () => {
    let resolveStatus: (value: PdfOptimizeStatusResponseV1) => void = () => undefined;
    const late = new Promise<PdfOptimizeStatusResponseV1>((resolve) => {
      resolveStatus = resolve;
    });
    const deps = dependencies({ getStatus: vi.fn(() => late) });
    const handle = runPdfOptimizeJob(
      file(),
      { version: 1, preset: "balanced" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: deps,
      },
    );
    await vi.waitFor(() => expect(deps.getStatus).toHaveBeenCalledOnce());
    handle.cancel();
    resolveStatus(status());
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(deps.cancel).toHaveBeenCalledOnce();
    expect(deps.remove).toHaveBeenCalledOnce();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("deletes on terminal failure and acknowledges a download exactly once", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const deps = dependencies({
      download: vi.fn(async () => ({
        blob: new Blob([new Uint8Array(90)], { type: "application/pdf" }),
        digest,
        acknowledge,
      })),
    });
    const first = runPdfOptimizeJob(
      file(),
      { version: 1, preset: "balanced" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: deps,
      },
    );
    await expect(first.result).resolves.toMatchObject({ status: "fulfilled" });
    const outcome = await first.result;
    if (outcome.status !== "fulfilled") throw new Error("fixture");
    await outcome.value.acknowledge();
    await outcome.value.acknowledge();
    expect(acknowledge).toHaveBeenCalledOnce();

    const failedDeps = dependencies({ getStatus: vi.fn(async () => status("failed")) });
    const second = runPdfOptimizeJob(
      file(),
      { version: 1, preset: "balanced" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: failedDeps,
      },
    );
    await expect(second.result).resolves.toMatchObject({ status: "rejected" });
    expect(failedDeps.remove).toHaveBeenCalledOnce();
  });

  it("rejects a higher-sequence state regression and cleans up", async () => {
    const deps = dependencies();
    vi.mocked(deps.getStatus)
      .mockResolvedValueOnce(status("running", 1))
      .mockResolvedValueOnce(status("queued", 2));
    const handle = runPdfOptimizeJob(
      file(),
      { version: 1, preset: "balanced" },
      {
        apiOrigin: "https://processing.example",
        anonymousSessionId: session,
        pageCount: 1,
        dependencies: deps,
      },
    );
    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "VERIFICATION_FAILED" },
    });
    expect(deps.remove).toHaveBeenCalledOnce();
  });

  it("checks exact download length, MIME, and SHA-256 before acknowledging", async () => {
    const bytes = new Uint8Array(90);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of hash) binary += String.fromCharCode(byte);
    const expectedDigest = `sha-256=${btoa(binary)}`;
    const token = createClientJobCredentials().jobToken;
    const succeeded = status();
    if (succeeded.state !== "succeeded" || succeeded.result.kind !== "download") {
      throw new Error("fixture");
    }
    const descriptor = succeeded.result;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(bytes, {
          headers: {
            "content-type": "application/pdf",
            "content-length": "90",
            "x-download-lease": token,
            digest: expectedDigest,
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await fetchPdfOptimizeResult({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: token,
      descriptor,
      fetch: fetchMock,
    });
    expect(result.blob).toMatchObject({ size: 90, type: "application/pdf" });
    await result.acknowledge();
    await result.acknowledge();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(
      fetchPdfOptimizeResult({
        apiOrigin: "https://processing.example",
        jobId,
        jobToken: token,
        descriptor,
        fetch: async () =>
          new Response(bytes, {
            headers: {
              "content-type": "application/pdf",
              "content-length": "90",
              "x-download-lease": token,
              digest: `sha-256=${"A".repeat(43)}=`,
            },
          }),
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  });
});
