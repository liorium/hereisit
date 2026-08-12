import { pdfOptimizeStatusResponseSchema } from "@hereisit/tool-contracts/pdf-optimize";
import { describe, expect, it, vi } from "vitest";
import { hashJobToken } from "../auth";
import { routeRequestWithDependencies } from "../router";
import {
  type LifecycleJob,
  type LifecycleRouteRuntime,
  routeJobCancelRequest,
  routeJobDeleteRequest,
  routeJobDownloadedRequest,
  routeJobResultRequest,
  routeJobStatusRequest,
} from "./results";

const jobId = "550e8400-e29b-41d4-a716-446655440000";
const token = "A".repeat(43);
const inputKey = "inputs/11111111-1111-4111-8111-111111111111";
const outputKey = "outputs/22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-07-16T12:00:00.000Z");
const leaseToken = `${"B".repeat(42)}A`;

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("cf-connecting-ip", "203.0.113.7");
  return new Request(`https://api.example${path}`, { ...init, headers });
}

function succeededJob(overrides: Partial<LifecycleJob> = {}): LifecycleJob {
  return {
    jobId,
    contractId: "image.optimize@1",
    declaredBytes: 3,
    declaredPageCount: null,
    state: "succeeded",
    phase: "completed",
    phaseFraction: 1,
    sequence: 8,
    attempt: 1,
    inputKey,
    outputKey,
    outputBytes: 2,
    outputMime: "image/png",
    outputWidth: 1,
    outputHeight: 1,
    outputPageCount: null,
    pdfProfile: null,
    resultKind: "download",
    engineBuildId: "engine-1",
    codecBuildId: "codec-1",
    warnings: [],
    testedCandidates: 1,
    errorCode: null,
    errorGuidance: null,
    actualWeightedUnits: 10,
    queuedAt: now - 2_000,
    startedAt: now - 1_000,
    engineContactStartedAt: now - 900,
    finishedAt: now - 100,
    resultExpiresAt: now + 30 * 60_000,
    downloadAcknowledgedAt: null,
    downloadLeaseExpiresAt: null,
    createdAt: now - 3_000,
    updatedAt: now - 100,
    ...overrides,
  };
}

async function runtime(job: LifecycleJob = succeededJob()): Promise<LifecycleRouteRuntime> {
  const tokenHash = await hashJobToken(token);
  const leaseHash = await hashJobToken(leaseToken);
  return {
    now: () => now,
    randomLeaseToken: () => leaseToken,
    networkKey: vi.fn(async () => "c".repeat(64)),
    networkRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    jobRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    downloadRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    repository: {
      loadExpectedTokenHash: vi.fn(async () => tokenHash),
      readJob: vi.fn(async () => job),
      cancelJob: vi.fn(async () => ({ kind: "terminal" as const, job })),
      deleteJob: vi.fn(async () => ({ kind: "terminal" as const, job })),
      claimDownload: vi.fn(async () => ({ kind: "claimed" as const, job })),
      loadDownloadLeaseHash: vi.fn(async () => leaseHash),
      acknowledgeDownload: vi.fn(async () => ({
        kind: "acknowledged" as const,
        outputKey,
      })),
      completeResultDeletion: vi.fn(async () => true),
    },
    artifacts: {
      getOutput: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2));
            controller.close();
          },
        }),
        size: job.outputBytes ?? 0,
        httpEtag: '"result-etag"',
        contentType: job.outputMime ?? undefined,
        kind: "output",
        jobId,
      })),
      deleteInput: vi.fn(async () => undefined),
      deleteOutput: vi.fn(async () => undefined),
    },
    engine: {
      cancel: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

describe("authenticated job lifecycle routes", () => {
  it("projects a strict PDF status and downloads only application/pdf", async () => {
    const pdfJob = succeededJob({
      contractId: "pdf.optimize@1",
      declaredBytes: 1_000,
      declaredPageCount: 3,
      outputBytes: 900,
      outputMime: "application/pdf",
      outputWidth: null,
      outputHeight: null,
      outputPageCount: 3,
      pdfProfile: "structural",
      codecBuildId: null,
      warnings: ["SIGNATURES_INVALIDATED"],
      testedCandidates: 2,
    });
    const routeRuntime = await runtime(pdfJob);
    const status = await routeJobStatusRequest(request(`/v1/jobs/${jobId}`), jobId, routeRuntime);
    expect(pdfOptimizeStatusResponseSchema.parse(await status.json())).toMatchObject({
      state: "succeeded",
      result: {
        kind: "download",
        mime: "application/pdf",
        sourceByteLength: 1_000,
        byteLength: 900,
        pageCount: 3,
        profile: "structural",
      },
    });

    const result = await routeJobResultRequest(
      request(`/v1/jobs/${jobId}/result`),
      jobId,
      routeRuntime,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/pdf");
    expect(result.headers.get("content-disposition")).toBe(
      'attachment; filename="hereisit-compressed.pdf"',
    );
  });

  it("projects the exact retryable PDF engine failure contract", async () => {
    const pdfJob = succeededJob({
      contractId: "pdf.optimize@1",
      declaredPageCount: 1,
      state: "failed",
      phase: "optimizing",
      phaseFraction: 0.5,
      resultKind: null,
      outputBytes: null,
      outputMime: null,
      outputWidth: null,
      outputHeight: null,
      resultExpiresAt: null,
      errorCode: "ENGINE_TIMEOUT",
    });
    const routeRuntime = await runtime(pdfJob);

    const response = await routeJobStatusRequest(request(`/v1/jobs/${jobId}`), jobId, routeRuntime);

    expect(response.status).toBe(200);
    expect(pdfOptimizeStatusResponseSchema.parse(await response.json())).toMatchObject({
      state: "failed",
      error: {
        code: "ENGINE_TIMEOUT",
        message: "처리 서버에서 PDF 압축을 완료하지 못했습니다.",
        retryable: true,
      },
    });
  });
  it("returns a strict status envelope after both rate-limit fences and token auth", async () => {
    const rt = await runtime();
    const response = await routeJobStatusRequest(request(`/v1/jobs/${jobId}`), jobId, rt);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contract: "tool-job@1",
      jobId,
      state: "succeeded",
      result: { kind: "download", mime: "image/png", byteLength: 2 },
    });
    expect(rt.networkRateLimiter.limit).toHaveBeenCalledBefore(vi.mocked(rt.jobRateLimiter.limit));
    expect(rt.jobRateLimiter.limit).toHaveBeenCalledBefore(
      vi.mocked(rt.repository.loadExpectedTokenHash),
    );
  });

  it("returns 429 before D1, R2, or container work", async () => {
    const rt = await runtime();
    vi.mocked(rt.networkRateLimiter.limit).mockResolvedValueOnce({ success: false });

    const response = await routeJobStatusRequest(request(`/v1/jobs/${jobId}`), jobId, rt);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(rt.repository.loadExpectedTokenHash).not.toHaveBeenCalled();
    expect(rt.repository.readJob).not.toHaveBeenCalled();
    expect(rt.artifacts.getOutput).not.toHaveBeenCalled();
    expect(rt.engine.cancel).not.toHaveBeenCalled();
  });

  it("does not disclose a cross-job token or read job state", async () => {
    const rt = await runtime();
    vi.mocked(rt.repository.loadExpectedTokenHash).mockResolvedValueOnce(
      await hashJobToken(`${"D".repeat(42)}A`),
    );

    const response = await routeJobStatusRequest(request(`/v1/jobs/${jobId}`), jobId, rt);

    expect(response.status).toBe(401);
    expect(rt.repository.readJob).not.toHaveBeenCalled();
  });

  it("preserves candidate-timeout guidance in the public failed status", async () => {
    const failed = succeededJob({
      state: "failed",
      resultKind: null,
      outputBytes: null,
      outputMime: null,
      outputWidth: null,
      outputHeight: null,
      resultExpiresAt: null,
      errorCode: "ENGINE_TIMEOUT",
      errorGuidance: "TRY_BALANCED_PRESET",
    });
    const rt = await runtime(failed);

    const response = await routeJobStatusRequest(request(`/v1/jobs/${jobId}`), jobId, rt);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "failed",
      error: {
        code: "ENGINE_TIMEOUT",
        guidance: "TRY_BALANCED_PRESET",
        message: expect.stringContaining("균형 프리셋"),
      },
    });
  });

  it("settles and cleans a queued cancellation", async () => {
    const queued = succeededJob({
      state: "queued",
      phase: "queued",
      phaseFraction: null,
      resultKind: null,
      outputBytes: null,
      outputMime: null,
      outputWidth: null,
      outputHeight: null,
      resultExpiresAt: null,
    });
    const rt = await runtime(queued);
    vi.mocked(rt.repository.cancelJob).mockResolvedValueOnce({
      kind: "cancelled-and-settled",
      job: { ...queued, state: "cancelled", phase: "completed", phaseFraction: 1 },
      inputKey,
      outputKey,
    });

    const response = await routeJobCancelRequest(
      request(`/v1/jobs/${jobId}/cancel`, { method: "POST" }),
      jobId,
      rt,
    );

    expect(response.status).toBe(202);
    expect(rt.artifacts.deleteInput).toHaveBeenCalledWith(inputKey);
    expect(rt.artifacts.deleteOutput).toHaveBeenCalledWith(outputKey);
    expect(rt.engine.remove).toHaveBeenCalledWith(jobId);
  });

  it("only records and signals cancellation for an actively leased job", async () => {
    const running = succeededJob({
      state: "running",
      phase: "optimizing",
      phaseFraction: 0.5,
      resultKind: null,
      outputBytes: null,
      outputMime: null,
      outputWidth: null,
      outputHeight: null,
      resultExpiresAt: null,
    });
    const rt = await runtime(running);
    vi.mocked(rt.repository.cancelJob).mockResolvedValueOnce({ kind: "running", job: running });

    const response = await routeJobCancelRequest(
      request(`/v1/jobs/${jobId}/cancel`, { method: "POST" }),
      jobId,
      rt,
    );

    expect(response.status).toBe(202);
    expect(rt.engine.cancel).toHaveBeenCalledWith(jobId);
    expect(rt.artifacts.deleteInput).not.toHaveBeenCalled();
    expect(rt.artifacts.deleteOutput).not.toHaveBeenCalled();
    expect(rt.engine.remove).not.toHaveBeenCalled();
  });

  it("rejects cancellation after success without deleting the result", async () => {
    const rt = await runtime();
    const response = await routeJobCancelRequest(
      request(`/v1/jobs/${jobId}/cancel`, { method: "POST" }),
      jobId,
      rt,
    );

    expect(response.status).toBe(409);
    expect(rt.artifacts.deleteInput).not.toHaveBeenCalled();
    expect(rt.artifacts.deleteOutput).not.toHaveBeenCalled();
  });

  it("claims a download lease and streams an attachment without an R2 URL", async () => {
    const rt = await runtime();
    const response = await routeJobResultRequest(request(`/v1/jobs/${jobId}/result`), jobId, rt);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="hereisit-compressed.png"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-download-lease")).toBe(leaseToken);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.arrayBuffer()).resolves.toEqual(Uint8Array.of(1, 2).buffer);
  });

  it("download rate limiting never claims a lease or touches the result", async () => {
    const rt = await runtime();
    vi.mocked(rt.downloadRateLimiter.limit).mockResolvedValueOnce({ success: false });

    const response = await routeJobResultRequest(request(`/v1/jobs/${jobId}/result`), jobId, rt);

    expect(response.status).toBe(429);
    expect(rt.repository.claimDownload).not.toHaveBeenCalled();
    expect(rt.artifacts.getOutput).not.toHaveBeenCalled();
    expect(rt.artifacts.deleteOutput).not.toHaveBeenCalled();
  });

  it("acknowledges the exact lease, deletes output, and rejects a wrong lease", async () => {
    const rt = await runtime();
    vi.mocked(rt.repository.acknowledgeDownload).mockResolvedValue({
      kind: "acknowledged",
      outputKey,
    });
    const wrong = await routeJobDownloadedRequest(
      request(`/v1/jobs/${jobId}/downloaded`, {
        method: "POST",
        headers: { "x-download-lease": `${"C".repeat(42)}A` },
      }),
      jobId,
      rt,
    );
    expect(wrong.status).toBe(409);
    expect(rt.artifacts.deleteOutput).not.toHaveBeenCalled();
    expect(rt.repository.acknowledgeDownload).not.toHaveBeenCalled();

    const accepted = await routeJobDownloadedRequest(
      request(`/v1/jobs/${jobId}/downloaded`, {
        method: "POST",
        headers: { "x-download-lease": leaseToken },
      }),
      jobId,
      rt,
    );
    expect(accepted.status).toBe(204);
    expect(rt.artifacts.deleteOutput).toHaveBeenCalledWith(outputKey);
    expect(rt.repository.completeResultDeletion).toHaveBeenCalledWith(jobId, now);
  });

  it("returns 409 instead of downloading an original-retained result", async () => {
    const original = succeededJob({
      resultKind: "original-retained",
      outputBytes: null,
      outputMime: null,
      outputWidth: null,
      outputHeight: null,
      resultExpiresAt: null,
    });
    const rt = await runtime(original);
    vi.mocked(rt.repository.claimDownload).mockResolvedValueOnce({
      kind: "original-retained",
      job: original,
    });

    const response = await routeJobResultRequest(request(`/v1/jobs/${jobId}/result`), jobId, rt);
    expect(response.status).toBe(409);
    expect(rt.artifacts.getOutput).not.toHaveBeenCalled();
  });

  it("does not destroy artifacts or workspace when deleting a running job", async () => {
    const running = succeededJob({ state: "running", phase: "optimizing", phaseFraction: 0.5 });
    const rt = await runtime(running);
    vi.mocked(rt.repository.deleteJob).mockResolvedValueOnce({ kind: "running", job: running });

    const response = await routeJobDeleteRequest(
      request(`/v1/jobs/${jobId}`, { method: "DELETE" }),
      jobId,
      rt,
    );
    expect(response.status).toBe(202);
    expect(rt.engine.cancel).toHaveBeenCalledWith(jobId);
    expect(rt.artifacts.deleteInput).not.toHaveBeenCalled();
    expect(rt.artifacts.deleteOutput).not.toHaveBeenCalled();
    expect(rt.engine.remove).not.toHaveBeenCalled();
  });

  it("routes exact lifecycle paths and exposes health readiness only on the explicit query", async () => {
    const rt = await runtime();
    const status = await routeRequestWithDependencies(request(`/v1/jobs/${jobId}`), {} as never, {
      lifecycle: rt,
    });
    expect(status.status).toBe(200);

    const query = await routeRequestWithDependencies(
      request(`/v1/jobs/${jobId}?leak=1`),
      {} as never,
      { lifecycle: rt },
    );
    expect(query.status).toBe(404);

    const healthy = await routeRequestWithDependencies(
      new Request("https://api.example/health"),
      {} as never,
      { health: { buildId: "build-1", serverJobsEnabled: false } },
    );
    expect(healthy.status).toBe(200);
    await expect(healthy.json()).resolves.toMatchObject({
      status: "ok",
      buildId: "build-1",
      serverJobsEnabled: false,
    });

    const required = await routeRequestWithDependencies(
      new Request("https://api.example/health?requireJobs=1"),
      {} as never,
      { health: { buildId: "build-1", serverJobsEnabled: false } },
    );
    expect(required.status).toBe(503);
  });
});
