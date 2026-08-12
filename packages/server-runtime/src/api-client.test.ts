import {
  IMAGE_OPTIMIZE_CONTRACT_ID,
  type ImageOptimizeCreateRequestV1,
} from "@hereisit/tool-contracts/image-optimize";
import {
  PDF_OPTIMIZE_CONTRACT_ID,
  type PdfOptimizeCreateRequestV1,
} from "@hereisit/tool-contracts/pdf-optimize";
import { TOOL_JOB_CONTRACT_ID } from "@hereisit/tool-contracts/tool-job";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClientJobCredentials,
  createImageOptimizeJob,
  createPdfOptimizeJob,
  getImageOptimizeStatus,
  getPdfOptimizeStatus,
  getPdfProcessingPolicy,
  getProcessingPolicy,
  RemoteJobError,
} from "./api-client";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "123e4567-e89b-42d3-a456-426614174001";

function request(): ImageOptimizeCreateRequestV1 {
  const credentials = createClientJobCredentials();
  return {
    jobContract: TOOL_JOB_CONTRACT_ID,
    toolContract: IMAGE_OPTIMIZE_CONTRACT_ID,
    anonymousSessionId: sessionId,
    ...credentials,
    input: { byteLength: 3, mimeHint: "image/jpeg", width: 1, height: 1 },
    spec: {
      version: 1,
      mode: "smart",
      preset: "balanced",
      output: "same-format",
      metadata: "strip",
      orientation: "apply",
      colorSpace: "srgb",
      minimumSavingsPercent: 1,
    },
  };
}

describe("remote API client", () => {
  beforeEach(() => vi.useRealTimers());

  it("creates a UUID and an exact 32-byte base64url token", () => {
    const credentials = createClientJobCredentials();
    expect(credentials.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(credentials.jobToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("maps a public error without retaining request secrets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          contract: "tool-job@1",
          error: {
            code: "QUEUE_UNAVAILABLE",
            message: "잠시 후 다시 시도해 주세요.",
            retryable: true,
          },
        },
        { status: 503 },
      ),
    );
    const input = request();
    const error = await createImageOptimizeJob(input, {
      apiOrigin: "https://processing.example",
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "QUEUE_UNAVAILABLE", retryable: true });
    expect(JSON.stringify(error)).not.toContain(input.jobToken);
    expect(JSON.stringify(error)).not.toContain("Bearer");
    expect(String(fetchMock.mock.calls)).not.toContain("private.jpg");
  });

  it("retries a lost create response with the exact same body", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(
        Response.json({
          contract: "tool-job@1",
          mode: "existing-job",
          jobId,
          state: "queued",
          reservedWeightedUnits: 12,
        }),
      );
    await createImageOptimizeJob(request(), {
      apiOrigin: "https://processing.example",
      fetch: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it("rejects runtime-only fields and unsafe job paths before fetch", async () => {
    const fetchMock = vi.fn();
    await expect(
      createImageOptimizeJob(
        { ...request(), filename: "private.jpg" } as ImageOptimizeCreateRequestV1,
        { apiOrigin: "https://processing.example", fetch: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      getImageOptimizeStatus({
        apiOrigin: "https://processing.example",
        jobId: "../policy?token=unsafe",
        jobToken: createClientJobCredentials().jobToken,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps malformed JSON and aborts to bounded public errors", async () => {
    await expect(
      createImageOptimizeJob(request(), {
        apiOrigin: "https://processing.example",
        fetch: async () => new Response("not-json", { status: 500 }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      createImageOptimizeJob(request(), {
        apiOrigin: "https://processing.example",
        signal: aborted.signal,
        fetch: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("sends a status token only in Authorization with no-store", async () => {
    const token = createClientJobCredentials().jobToken;
    const fetchMock = vi.fn().mockImplementation(async () =>
      Response.json({
        contract: "tool-job@1",
        jobId,
        state: "queued",
        phase: "queued",
        phaseFraction: null,
        sequence: 1,
        attempt: 0,
        updatedAt: "2026-07-16T00:00:00.000Z",
      }),
    );
    await getImageOptimizeStatus({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: token,
      fetch: fetchMock,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain(token);
    expect(init).toMatchObject({ cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("deduplicates and briefly caches successful policy POST requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      Response.json({
        contract: "tool-job@1",
        toolContract: "image.optimize@1",
        execution: "local",
        reason: "SERVER_PROCESSING_DISABLED",
        maintainer: false,
        disclosure: {
          upload: false,
          inputDeletion: "not-uploaded",
          resultDeletion: { mode: "not-uploaded" },
        },
        limits: { maxFiles: 20, maxBytesPerFile: 31_457_280, maxPixelsPerFile: 40_000_000 },
      }),
    );
    const input = {
      apiOrigin: "https://processing.example",
      anonymousSessionId: sessionId,
      fetch: fetchMock,
    };
    await Promise.all([getProcessingPolicy(input), getProcessingPolicy(input)]);
    await getProcessingPolicy(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", cache: "no-store" });
    await Promise.all([
      getProcessingPolicy({ ...input, forceRefresh: true }),
      getProcessingPolicy({ ...input, forceRefresh: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes a cached session policy after five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () =>
      Response.json({
        contract: "tool-job@1",
        toolContract: "image.optimize@1",
        execution: "local",
        reason: "SERVER_PROCESSING_DISABLED",
        maintainer: false,
        disclosure: {
          upload: false,
          inputDeletion: "not-uploaded",
          resultDeletion: { mode: "not-uploaded" },
        },
        limits: { maxFiles: 20, maxBytesPerFile: 31_457_280, maxPixelsPerFile: 40_000_000 },
      }),
    );
    const input = {
      apiOrigin: "https://short-cache.example",
      anonymousSessionId: "123e4567-e89b-42d3-a456-426614174099",
      fetch: fetchMock,
    };
    await getProcessingPolicy(input);
    await getProcessingPolicy(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    await getProcessingPolicy(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serializes RemoteJobError without internal causes", () => {
    const error = new RemoteJobError("STORAGE_FAILURE", "실패", true);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "STORAGE_FAILURE",
      message: "실패",
      retryable: true,
    });
  });

  it("uses strict PDF policy, create, and status schemas without sending a filename", async () => {
    const credentials = createClientJobCredentials();
    const pdfRequest: PdfOptimizeCreateRequestV1 = {
      contract: TOOL_JOB_CONTRACT_ID,
      toolContract: PDF_OPTIMIZE_CONTRACT_ID,
      anonymousSessionId: credentials.jobToken,
      ...credentials,
      input: { byteLength: 100, mime: "application/pdf", pageCount: 1 },
      spec: { version: 1, preset: "balanced" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          contract: TOOL_JOB_CONTRACT_ID,
          toolContract: PDF_OPTIMIZE_CONTRACT_ID,
          execution: "local",
          reason: "SERVER_PROCESSING_DISABLED",
          maintainer: false,
          disclosure: {
            upload: false,
            inputDeletion: "not-uploaded",
            resultDeletion: { mode: "not-uploaded" },
          },
          limits: { maxFiles: 1, maxBytesPerFile: 52_428_800, maxPagesPerFile: 100 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          contract: TOOL_JOB_CONTRACT_ID,
          mode: "existing-job",
          jobId,
          state: "queued",
          reservedWeightedUnits: 1,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          contract: TOOL_JOB_CONTRACT_ID,
          jobId,
          state: "queued",
          phase: "queued",
          phaseFraction: null,
          sequence: 1,
          attempt: 0,
          updatedAt: "2026-08-12T00:00:00.000Z",
        }),
      );

    await getPdfProcessingPolicy({
      apiOrigin: "https://processing.example",
      anonymousSessionId: credentials.jobToken,
      forceRefresh: true,
      fetch: fetchMock,
    });
    await createPdfOptimizeJob(pdfRequest, {
      apiOrigin: "https://processing.example",
      fetch: fetchMock,
    });
    await getPdfOptimizeStatus({
      apiOrigin: "https://processing.example",
      jobId,
      jobToken: credentials.jobToken,
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls)).not.toContain("private.pdf");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(pdfRequest);
  });

  it("rejects a cross-tool status at the PDF boundary", async () => {
    await expect(
      getPdfOptimizeStatus({
        apiOrigin: "https://processing.example",
        jobId,
        jobToken: createClientJobCredentials().jobToken,
        fetch: async () =>
          Response.json({
            contract: TOOL_JOB_CONTRACT_ID,
            jobId,
            state: "succeeded",
            phase: "completed",
            phaseFraction: 1,
            sequence: 1,
            attempt: 0,
            updatedAt: "2026-08-12T00:00:00.000Z",
            result: {
              kind: "download",
              mime: "image/jpeg",
              byteLength: 1,
              width: 1,
              height: 1,
              engineBuildId: "private",
              codecBuildId: "private",
              warnings: [],
              testedCandidates: 1,
            },
          }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
