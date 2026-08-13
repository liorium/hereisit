import { describe, expect, it, vi } from "vitest";
import { hashJobToken } from "../auth";
import { routeRequestWithDependencies } from "../router";
import type { PolicyRouteRuntime } from "./policy";
import { routeUploadRequest, type UploadRouteRuntime } from "./uploads";

const allowedOrigin = "https://app.example";
const fixedNow = Date.parse("2026-07-16T12:00:00.000Z");
const jobId = "550e8400-e29b-41d4-a716-446655440000";
const jobToken = "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA";
const foreignJobToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const currentSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString(
  "base64url",
);
const previousSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString(
  "base64url",
);
const inputKey = "inputs/11111111-1111-4111-8111-111111111111";
const pdfDigest = "sha-256=A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=";

function readyJob() {
  return {
    jobId,
    declaredBytes: 3,
    declaredMime: "image/png" as const,
    inputKey,
    uploadVersion: 1,
    uploadExpiresAt: fixedNow + 10 * 60_000,
  };
}

function request(
  token = jobToken,
  body: BodyInit = Uint8Array.of(1, 2, 3),
  url = `https://api.example/v1/jobs/${jobId}/input`,
): Request {
  return new Request(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": "203.0.113.77",
      "content-length": "3",
      "content-type": "image/png",
      origin: allowedOrigin,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
  } as RequestInit);
}

async function makeRuntime(
  overrides: Partial<UploadRouteRuntime> = {},
): Promise<UploadRouteRuntime> {
  return {
    config: { appOrigins: [new URL(allowedOrigin)] },
    currentSecret,
    previousSecret,
    networkRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    repository: {
      loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
      beginUpload: vi.fn(async () => ({
        kind: "already-committed" as const,
        state: "queued" as const,
        inputEtag: "raw-etag",
        declaredBytes: 3,
        declaredMime: "image/png" as const,
      })),
      commitStoredInput: vi.fn(),
      settlePreEngineFailure: vi.fn(),
      openInvariantCircuit: vi.fn(),
    },
    storeInput: vi.fn(),
    deleteInput: vi.fn(),
    dispatchOutbox: vi.fn(),
    now: () => fixedNow,
    ...overrides,
  };
}

function makePolicyRuntimeForRouter(uploadRuntime: UploadRouteRuntime): PolicyRouteRuntime {
  return {
    config: {
      appOrigins: uploadRuntime.config.appOrigins,
      rolloutPercent: 100,
      accountDailyWeightedUnitLimit: Number.MAX_SAFE_INTEGER,
      anonymousDailyWeightedUnitLimit: Number.MAX_SAFE_INTEGER,
      networkDailyWeightedUnitLimit: Number.MAX_SAFE_INTEGER,
      accountPendingJobLimit: 10,
      networkPendingJobLimit: 3,
      maximumQueuedAgeSeconds: 600,
      maintainerSessionHashes: new Set<string>(),
    },
    currentSecret,
    previousSecret,
    policyRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    readState: vi.fn(async () => ({
      circuitClosed: true,
      accountReservedToday: 0,
      accountSettledToday: 0,
      accountPendingJobs: 0,
      anonymousReservedToday: 0,
      anonymousSettledToday: 0,
      activeJobs: 0,
      networkReservedToday: 0,
      networkSettledToday: 0,
      networkPendingJobs: 0,
      oldestQueuedAgeSeconds: 0,
    })),
    readJson: vi.fn(),
    now: () => new Date(fixedNow),
    timeoutMilliseconds: 100,
  };
}

describe("PUT /v1/jobs/:jobId/input", () => {
  it("requires a canonical PDF digest and passes it to authoritative storage", async () => {
    const storeInput = vi.fn(async () => ({
      kind: "stored" as const,
      artifact: {
        key: inputKey as `inputs/${string}`,
        byteLength: 3,
        mime: "application/pdf" as const,
        etag: "raw-etag",
        uploadVersion: 1,
      },
    }));
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({
          kind: "ready" as const,
          ...readyJob(),
          declaredMime: "application/pdf" as const,
        })),
        commitStoredInput: vi.fn(async () => ({ kind: "queued" as const })),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput,
    });
    const missing = request();
    missing.headers.set("content-type", "application/pdf");
    expect((await routeUploadRequest(missing, jobId, runtime)).status).toBe(400);
    expect(storeInput).not.toHaveBeenCalled();

    const valid = request();
    valid.headers.set("content-type", "application/pdf");
    valid.headers.set("digest", pdfDigest);
    expect((await routeUploadRequest(valid, jobId, runtime)).status).toBe(204);
    expect(storeInput).toHaveBeenCalledWith(expect.objectContaining({ expectedSha256: pdfDigest }));
    expect(JSON.stringify(storeInput.mock.calls)).not.toContain("private");
  });

  it("requires an allowed browser Origin before network, D1, or body work", async () => {
    const runtime = await makeRuntime();
    const uploadRequest = request();
    uploadRequest.headers.delete("origin");

    const response = await routeUploadRequest(uploadRequest, jobId, runtime);

    expect(response.status).toBe(403);
    expect(runtime.networkRateLimiter.limit).not.toHaveBeenCalled();
    expect(runtime.repository.loadExpectedTokenHash).not.toHaveBeenCalled();
    expect(runtime.storeInput).not.toHaveBeenCalled();
  });

  it("acknowledges an authenticated committed replay without consuming its body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("committed replay body must remain unread");
      },
    });
    const runtime = await makeRuntime();

    const response = await routeUploadRequest(request(jobToken, body), jobId, runtime);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(runtime.storeInput).not.toHaveBeenCalled();
    expect(runtime.repository.commitStoredInput).not.toHaveBeenCalled();
  });

  it("rejects a malformed Bearer token before any D1 access", async () => {
    const runtime = await makeRuntime();

    const response = await routeUploadRequest(request("not-a-token"), jobId, runtime);

    expect(response.status).toBe(401);
    expect(runtime.repository.loadExpectedTokenHash).not.toHaveBeenCalled();
    expect(runtime.repository.beginUpload).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical 32-byte-looking token before any D1 access", async () => {
    const runtime = await makeRuntime();

    const response = await routeUploadRequest(request(`${"A".repeat(42)}B`), jobId, runtime);

    expect(response.status).toBe(401);
    expect(runtime.repository.loadExpectedTokenHash).not.toHaveBeenCalled();
  });

  it("rejects a canonical foreign token after hash lookup but before upload mutation", async () => {
    const runtime = await makeRuntime();

    const response = await routeUploadRequest(request(foreignJobToken), jobId, runtime);

    expect(response.status).toBe(401);
    expect(runtime.repository.loadExpectedTokenHash).toHaveBeenCalledWith(jobId);
    expect(runtime.repository.beginUpload).not.toHaveBeenCalled();
    expect(runtime.storeInput).not.toHaveBeenCalled();
  });

  it("validates exact upload headers before acknowledging a committed replay", async () => {
    const runtime = await makeRuntime();
    const replay = request();
    replay.headers.set("content-type", "image/jpeg");

    const response = await routeUploadRequest(replay, jobId, runtime);

    expect(response.status).toBe(400);
    expect(runtime.storeInput).not.toHaveBeenCalled();
  });

  it("deletes only a canonical authorization returned after an expired begin settlement", async () => {
    const deleteAuthorization = {
      kind: "delete-unowned-object" as const,
      key: inputKey,
    };
    const deleteInput = vi.fn(async () => undefined);
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({
          kind: "rejected" as const,
          reason: "expired" as const,
          deleteAuthorization,
        })),
        commitStoredInput: vi.fn(),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      deleteInput,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(410);
    expect(deleteInput).toHaveBeenCalledWith(deleteAuthorization);
    expect(runtime.storeInput).not.toHaveBeenCalled();
  });

  it("never honors a rejected-begin deletion authorization for an invalid state", async () => {
    const deleteInput = vi.fn();
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({
          kind: "rejected" as const,
          reason: "invalid-state" as const,
          deleteAuthorization: {
            kind: "delete-unowned-object" as const,
            key: inputKey,
          },
        })),
        commitStoredInput: vi.fn(),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      deleteInput,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(409);
    expect(deleteInput).not.toHaveBeenCalled();
  });

  it("streams the exact body, commits the immutable ETag, and returns bodyless 204", async () => {
    const beginUpload = vi.fn(async () => ({ kind: "ready" as const, ...readyJob() }));
    const commitStoredInput = vi.fn(async () => ({ kind: "queued" as const }));
    const storeInput = vi.fn(async () => ({
      kind: "stored" as const,
      artifact: {
        key: inputKey as `inputs/${string}`,
        byteLength: 3,
        mime: "image/png" as const,
        etag: "raw-etag",
        uploadVersion: 1,
      },
    }));
    const dispatchOutbox = vi.fn(async () => true);
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload,
        commitStoredInput,
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput,
      dispatchOutbox,
    });
    const uploadRequest = request();

    const response = await routeUploadRequest(uploadRequest, jobId, runtime);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(storeInput).toHaveBeenCalledWith({
      source: uploadRequest.body,
      key: inputKey,
      byteLength: 3,
      mime: "image/png",
      uploadVersion: 1,
      deadlineAt: fixedNow + 10 * 60_000,
    });
    expect(commitStoredInput).toHaveBeenCalledWith({
      jobId,
      uploadVersion: 1,
      inputEtag: "raw-etag",
      now: fixedNow,
    });
    expect(dispatchOutbox).toHaveBeenCalledWith(jobId, fixedNow);
  });

  it("records commit and dispatch time after a long stream instead of at request start", async () => {
    const completedAt = fixedNow + 9 * 60_000;
    const times = [fixedNow, completedAt];
    const beginUpload = vi.fn(async () => ({ kind: "ready" as const, ...readyJob() }));
    const commitStoredInput = vi.fn(async () => ({ kind: "queued" as const }));
    const dispatchOutbox = vi.fn(async () => true);
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload,
        commitStoredInput,
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput: vi.fn(async () => ({
        kind: "stored" as const,
        artifact: {
          key: inputKey as `inputs/${string}`,
          byteLength: 3,
          mime: "image/png" as const,
          etag: "raw-etag",
          uploadVersion: 1,
        },
      })),
      dispatchOutbox,
      now: () => times.shift() ?? completedAt,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(204);
    expect(beginUpload).toHaveBeenCalledWith({ jobId, now: fixedNow });
    expect(commitStoredInput).toHaveBeenCalledWith({
      jobId,
      uploadVersion: 1,
      inputEtag: "raw-etag",
      now: completedAt,
    });
    expect(dispatchOutbox).toHaveBeenCalledWith(jobId, completedAt);
  });

  it("keeps an accepted upload successful when immediate Queue dispatch fails", async () => {
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(async () => ({ kind: "queued" as const })),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput: vi.fn(async () => ({
        kind: "stored" as const,
        artifact: {
          key: inputKey as `inputs/${string}`,
          byteLength: 3,
          mime: "image/png" as const,
          etag: "raw-etag",
          uploadVersion: 1,
        },
      })),
      dispatchOutbox: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("applies the network limiter before token lookup or any other D1 access", async () => {
    const repository = {
      loadExpectedTokenHash: vi.fn(),
      beginUpload: vi.fn(),
      commitStoredInput: vi.fn(),
      settlePreEngineFailure: vi.fn(),
      openInvariantCircuit: vi.fn(),
    };
    const runtime = await makeRuntime({
      repository,
      networkRateLimiter: { limit: vi.fn(async () => ({ success: false })) },
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(429);
    expect(repository.loadExpectedTokenHash).not.toHaveBeenCalled();
  });

  it.each([
    ["missing length", (headers: Headers) => headers.delete("content-length")],
    ["wrong length", (headers: Headers) => headers.set("content-length", "4")],
    ["noncanonical length", (headers: Headers) => headers.set("content-length", "03")],
    ["wrong MIME", (headers: Headers) => headers.set("content-type", "image/jpeg")],
    ["encoded body", (headers: Headers) => headers.set("content-encoding", "gzip")],
    ["chunked body", (headers: Headers) => headers.set("transfer-encoding", "chunked")],
  ])("rejects a %s before streaming the body", async (_label, mutate) => {
    const storeInput = vi.fn();
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput,
    });
    const uploadRequest = request();
    mutate(uploadRequest.headers);

    const response = await routeUploadRequest(uploadRequest, jobId, runtime);

    expect(response.status).toBe(400);
    expect(storeInput).not.toHaveBeenCalled();
  });

  it("settles an object mismatch and deletes only the repository-authorized key", async () => {
    const deleteAuthorization = {
      kind: "delete-unowned-object" as const,
      key: inputKey,
    };
    const settlePreEngineFailure = vi.fn(async () => ({
      kind: "settled" as const,
      state: "failed" as const,
      deleteAuthorization,
    }));
    const deleteInput = vi.fn(async () => undefined);
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(),
        settlePreEngineFailure,
        openInvariantCircuit: vi.fn(),
      },
      storeInput: vi.fn(async () => {
        throw { code: "UPLOAD_MISMATCH" };
      }),
      deleteInput,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(400);
    expect(settlePreEngineFailure).toHaveBeenCalledWith({
      jobId,
      inputKey,
      uploadVersion: 1,
      now: fixedNow,
      outcome: "failed",
      errorCode: "UPLOAD_MISMATCH",
    });
    expect(deleteInput).toHaveBeenCalledOnce();
    expect(deleteInput).toHaveBeenCalledWith(deleteAuthorization);
  });

  it("rejects a deletion authorization for any key other than the fenced upload key", async () => {
    const deleteInput = vi.fn();
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(),
        settlePreEngineFailure: vi.fn(async () => ({
          kind: "settled" as const,
          state: "failed" as const,
          deleteAuthorization: {
            kind: "delete-unowned-object" as const,
            key: "inputs/99999999-9999-4999-8999-999999999999",
          },
        })),
        openInvariantCircuit: vi.fn(),
      },
      storeInput: vi.fn(async () => {
        throw { code: "UPLOAD_MISMATCH" };
      }),
      deleteInput,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(400);
    expect(deleteInput).not.toHaveBeenCalled();
  });

  it("never deletes the authoritative object for a same-ETag commit replay", async () => {
    const deleteInput = vi.fn();
    const dispatchOutbox = vi.fn(async () => true);
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(async () => ({
          kind: "already-queued-same-etag" as const,
          state: "queued" as const,
        })),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput: vi.fn(async () => ({
        kind: "existing-authoritative" as const,
        artifact: {
          key: inputKey as `inputs/${string}`,
          byteLength: 3,
          mime: "image/png" as const,
          etag: "raw-etag",
          uploadVersion: 1,
        },
      })),
      deleteInput,
      dispatchOutbox,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(204);
    expect(deleteInput).not.toHaveBeenCalled();
    expect(dispatchOutbox).toHaveBeenCalledWith(jobId, fixedNow);
  });

  it.each([
    ["cancelled", "cancelled", "CANCELLED"],
    ["expired", "expired", "UPLOAD_EXPIRED"],
    ["upload-version-changed", "failed", "UPLOAD_MISMATCH"],
    ["no-owner", "failed", "UPLOAD_MISMATCH"],
  ] as const)("settles a %s commit race before deleting the repository-authorized object", async (reason, outcome, errorCode) => {
    const deleteAuthorization = {
      kind: "delete-unowned-object" as const,
      key: inputKey,
    };
    const settlePreEngineFailure = vi.fn(async () => ({
      kind: "settled" as const,
      state: outcome,
      deleteAuthorization,
    }));
    const deleteInput = vi.fn(async () => undefined);
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(async () => ({
          kind: "delete-unowned-object" as const,
          reason,
        })),
        settlePreEngineFailure,
        openInvariantCircuit: vi.fn(),
      },
      storeInput: vi.fn(async () => ({
        kind: "stored" as const,
        artifact: {
          key: inputKey as `inputs/${string}`,
          byteLength: 3,
          mime: "image/png" as const,
          etag: "raw-etag",
          uploadVersion: 1,
        },
      })),
      deleteInput,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(reason === "expired" ? 410 : 409);
    expect(settlePreEngineFailure).toHaveBeenCalledWith({
      jobId,
      inputKey,
      uploadVersion: 1,
      now: fixedNow,
      outcome,
      errorCode,
    });
    expect(deleteInput).toHaveBeenCalledWith(deleteAuthorization);
  });

  it("opens the circuit and preserves the object for a conflicting D1-owned ETag", async () => {
    const openInvariantCircuit = vi.fn(async () => undefined);
    const deleteInput = vi.fn();
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput: vi.fn(async () => ({ kind: "conflicting-owned-etag" as const })),
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit,
      },
      storeInput: vi.fn(async () => ({
        kind: "stored" as const,
        artifact: {
          key: inputKey as `inputs/${string}`,
          byteLength: 3,
          mime: "image/png" as const,
          etag: "new-etag",
          uploadVersion: 1,
        },
      })),
      deleteInput,
    });

    const response = await routeUploadRequest(request(), jobId, runtime);

    expect(response.status).toBe(503);
    expect(openInvariantCircuit).toHaveBeenCalledWith({
      now: fixedNow,
      reason: "INPUT_ETAG_CONFLICT",
    });
    expect(deleteInput).not.toHaveBeenCalled();
  });

  it("lets two same-version uploads converge on one queued commit without deleting", async () => {
    let commits = 0;
    let releaseCommit: (() => void) | undefined;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitStoredInput = vi.fn(async () => {
      commits += 1;
      const ordinal = commits;
      if (commits === 2) releaseCommit?.();
      await commitGate;
      return ordinal === 1
        ? ({ kind: "queued" } as const)
        : ({ kind: "already-queued-same-etag", state: "queued" } as const);
    });
    const dispatchOutbox = vi.fn(async () => true);
    const deleteInput = vi.fn();
    const repository = {
      loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
      beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
      commitStoredInput,
      settlePreEngineFailure: vi.fn(),
      openInvariantCircuit: vi.fn(),
    };
    const storeInput = vi.fn(async () => ({
      kind: "existing-authoritative" as const,
      artifact: {
        key: inputKey as `inputs/${string}`,
        byteLength: 3,
        mime: "image/png" as const,
        etag: "same-etag",
        uploadVersion: 1,
      },
    }));
    const runtime = await makeRuntime({
      repository,
      storeInput,
      dispatchOutbox,
      deleteInput,
    });

    const responses = await Promise.all([
      routeUploadRequest(request(), jobId, runtime),
      routeUploadRequest(request(), jobId, runtime),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([204, 204]);
    expect(commitStoredInput).toHaveBeenCalledTimes(2);
    expect(dispatchOutbox).toHaveBeenCalledTimes(2);
    expect(deleteInput).not.toHaveBeenCalled();
  });

  it("recovers when R2 succeeded but the first D1 commit response failed", async () => {
    let commitAttempt = 0;
    const commitStoredInput = vi.fn(async () => {
      commitAttempt += 1;
      if (commitAttempt === 1) throw new Error("D1 response lost");
      return { kind: "queued" as const };
    });
    const storeInput = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "stored",
        artifact: {
          key: inputKey,
          byteLength: 3,
          mime: "image/png",
          etag: "same-etag",
          uploadVersion: 1,
        },
      })
      .mockResolvedValueOnce({
        kind: "existing-authoritative",
        artifact: {
          key: inputKey,
          byteLength: 3,
          mime: "image/png",
          etag: "same-etag",
          uploadVersion: 1,
        },
      });
    const deleteInput = vi.fn();
    const runtime = await makeRuntime({
      repository: {
        loadExpectedTokenHash: vi.fn(async () => hashJobToken(jobToken)),
        beginUpload: vi.fn(async () => ({ kind: "ready" as const, ...readyJob() })),
        commitStoredInput,
        settlePreEngineFailure: vi.fn(),
        openInvariantCircuit: vi.fn(),
      },
      storeInput,
      deleteInput,
      dispatchOutbox: vi.fn(async () => true),
    });

    const first = await routeUploadRequest(request(), jobId, runtime);
    const second = await routeUploadRequest(request(), jobId, runtime);

    expect(first.status).toBe(503);
    expect(second.status).toBe(204);
    expect(storeInput).toHaveBeenCalledTimes(2);
    expect(deleteInput).not.toHaveBeenCalled();
  });

  it("routes only the canonical fixed upload path with no query string", async () => {
    const uploadRuntime = await makeRuntime();
    const policyRuntime = makePolicyRuntimeForRouter(uploadRuntime);
    const exact = await routeRequestWithDependencies(request(), policyRuntime, {
      upload: uploadRuntime,
    });
    const query = await routeRequestWithDependencies(
      request(
        jobToken,
        Uint8Array.of(1, 2, 3),
        `https://api.example/v1/jobs/${jobId}/input?key=arbitrary`,
      ),
      policyRuntime,
      { upload: uploadRuntime },
    );
    const uppercase = await routeRequestWithDependencies(
      request(
        jobToken,
        Uint8Array.of(1, 2, 3),
        `https://api.example/v1/jobs/${jobId.toUpperCase()}/input`,
      ),
      policyRuntime,
      { upload: uploadRuntime },
    );

    expect(exact.status).toBe(204);
    expect(query.status).toBe(404);
    expect(uppercase.status).toBe(404);
  });
});
