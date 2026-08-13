import { imageOptimizeCreateResponseSchema } from "@hereisit/tool-contracts/image-optimize";
import { pdfOptimizeCreateResponseSchema } from "@hereisit/tool-contracts/pdf-optimize";
import { describe, expect, it, vi } from "vitest";
import type {
  PdfReservationJob,
  PdfReserveAndCreateInput,
  ReservationJob,
  ReserveAndCreateInput,
} from "../d1-job-repository";
import { routeRequestWithDependencies } from "../router";
import { type CreateJobRouteRuntime, routeCreateJobRequest } from "./jobs";
import type { PolicyRouteRuntime } from "./policy";

const fixedNow = new Date("2026-07-16T12:00:00.000Z");
const allowedOrigin = "https://app.example";
const currentSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString(
  "base64url",
);
const previousSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString(
  "base64url",
);
const jobToken = "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA";
const anonymousSessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const clientRequestId = "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe";
const generatedIds = [
  "550e8400-e29b-41d4-a716-446655440000",
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

function createBody() {
  return {
    jobContract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId,
    clientRequestId,
    jobToken,
    input: {
      byteLength: 3,
      mimeHint: "image/png",
      width: 1,
      height: 1,
    },
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
  } as const;
}

function pdfCreateBody() {
  return {
    contract: "tool-job@1",
    toolContract: "pdf.optimize@1",
    anonymousSessionId: "123e4567-e89b-42d3-a456-426614174000",
    clientRequestId,
    jobToken,
    input: { byteLength: 1_000, mime: "application/pdf", pageCount: 3 },
    spec: { version: 1, preset: "balanced" },
  } as const;
}

function createRequest(body: unknown = createBody(), url = "https://api.example/v1/jobs"): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "cf-connecting-ip": "203.0.113.77",
      "content-type": "application/json",
      origin: allowedOrigin,
    },
    body: JSON.stringify(body),
  });
}

function reservationJob(
  input: ReserveAndCreateInput,
  status: ReservationJob["status"] = "created",
): ReservationJob {
  return {
    jobId: input.jobId,
    status,
    contractId: "image.optimize@1",
    specHash: input.specHash,
    declaredBytes: input.request.input.byteLength,
    declaredMime: input.request.input.mimeHint,
    declaredWidth: input.request.input.width,
    declaredHeight: input.request.input.height,
    inputKey: input.inputKey,
    inputEtag: status === "created" || status === "uploading" ? null : "raw-etag",
    uploadVersion: status === "created" ? 0 : 1,
    outputKey: input.outputKey,
    reservedWeightedUnits: input.estimate.reservedWeightedUnits,
    resourceClass: input.estimate.resourceClass,
    attempt: 1,
    queueEpoch: input.queueEpoch,
    queueGeneration: 1,
    cancelRequestedAt: null,
    uploadExpiresAt: input.uploadExpiresAt,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function makeRuntime(overrides: Partial<CreateJobRouteRuntime> = {}): CreateJobRouteRuntime {
  let idIndex = 0;
  const repository = {
    reserveAndCreate: vi.fn(async (input: ReserveAndCreateInput) => ({
      kind: "created" as const,
      mode: "upload-required" as const,
      job: reservationJob(input),
    })),
  };

  return {
    config: {
      appOrigins: [new URL(allowedOrigin)],
      rolloutPercent: 100,
      maintainerSessionHashes: new Set<string>(),
      pdfPublicAdmissionEnabled: false,
      accountDailyWeightedUnitLimit: Number.MAX_SAFE_INTEGER,
      anonymousDailyWeightedUnitLimit: Number.MAX_SAFE_INTEGER,
      networkDailyWeightedUnitLimit: Number.MAX_SAFE_INTEGER,
      accountPendingJobLimit: 10,
      networkPendingJobLimit: 3,
      maximumQueuedAgeSeconds: 600,
    },
    currentSecret,
    previousSecret,
    networkRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    sessionRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    repository,
    readJson: vi.fn(async () => createBody()),
    now: () => fixedNow,
    randomUuid: () => generatedIds[idIndex++] ?? crypto.randomUUID(),
    logCreated: vi.fn(),
    ...overrides,
  };
}

function makePolicyRuntimeForRouter(createRuntime: CreateJobRouteRuntime): PolicyRouteRuntime {
  return {
    config: createRuntime.config,
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
    readJson: createRuntime.readJson,
    now: createRuntime.now,
    timeoutMilliseconds: 100,
  };
}

describe("POST /v1/jobs", () => {
  it("returns only a fixed Worker upload descriptor and canonical reservation", async () => {
    const runtime = makeRuntime();
    const response = await routeCreateJobRequest(createRequest(), runtime);
    const payload = imageOptimizeCreateResponseSchema.parse(await response.json());

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({
      contract: "tool-job@1",
      mode: "upload-required",
      jobId: generatedIds[0],
      upload: {
        kind: "worker-stream-put",
        method: "PUT",
        path: `/v1/jobs/${generatedIds[0]}/input`,
        contentType: "image/png",
        byteLength: 3,
        expiresAt: "2026-07-16T12:10:00.000Z",
      },
      reservedWeightedUnits: expect.any(Number),
    });
    if (payload.mode !== "upload-required") {
      throw new Error("Expected an upload-required response.");
    }
    expect(payload.upload).not.toHaveProperty("origin");
    expect(payload.upload).not.toHaveProperty("headers");

    const reservation = vi.mocked(runtime.repository.reserveAndCreate).mock.calls[0]?.[0];
    expect(reservation).toMatchObject({
      jobId: generatedIds[0],
      clientRequestId,
      inputKey: `inputs/${generatedIds[1]}`,
      outputKey: `outputs/${generatedIds[2]}`,
      queueEpoch: generatedIds[3],
      dayKey: "2026-07-16",
      specJson:
        '{"version":1,"mode":"smart","preset":"balanced","output":"same-format","metadata":"strip","orientation":"apply","colorSpace":"srgb","minimumSavingsPercent":1}',
    });
    const canonicalSpecJson =
      '{"version":1,"mode":"smart","preset":"balanced","output":"same-format","metadata":"strip","orientation":"apply","colorSpace":"srgb","minimumSavingsPercent":1}';
    const expectedSpecHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalSpecJson)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(reservation?.specHash).toBe(expectedSpecHash);
    expect(runtime.logCreated).toHaveBeenCalledWith({
      jobId: generatedIds[0],
      contractId: "image.optimize@1",
      byteCount: 3,
      pixelCount: 1,
      resourceClass: "image-standard-v1",
      reservedWeightedUnits: expect.any(Number),
    });
  });

  it("applies the network limiter before reading JSON or touching D1", async () => {
    const readJson = vi.fn(async () => createBody());
    const repository = { reserveAndCreate: vi.fn() };
    const runtime = makeRuntime({
      readJson,
      repository,
      networkRateLimiter: { limit: vi.fn(async () => ({ success: false })) },
    });

    const response = await routeCreateJobRequest(createRequest(), runtime);

    expect(response.status).toBe(429);
    expect(response.headers.get("x-hereisit-rate-limit-scope")).toBe("network");
    expect(readJson).not.toHaveBeenCalled();
    expect(repository.reserveAndCreate).not.toHaveBeenCalled();
  });

  it("does not turn an accepted reservation into a failed response when safe logging fails", async () => {
    const runtime = makeRuntime({
      logCreated: vi.fn(() => {
        throw new Error("log sink unavailable");
      }),
    });

    const response = await routeCreateJobRequest(createRequest(), runtime);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      contract: "tool-job@1",
      mode: "upload-required",
    });
  });

  it("routes only the exact body-only POST endpoint after the outer Origin gate", async () => {
    const createRuntime = makeRuntime();
    const policyRuntime = makePolicyRuntimeForRouter(createRuntime);
    const exact = await routeRequestWithDependencies(createRequest(), policyRuntime, {
      create: createRuntime,
    });
    const query = await routeRequestWithDependencies(
      createRequest(createBody(), "https://api.example/v1/jobs?debug=true"),
      policyRuntime,
      { create: createRuntime },
    );

    expect(exact.status).toBe(201);
    expect(query.status).toBe(404);
  });

  it("rejects unknown request fields before the session limiter and repository", async () => {
    const unsafeBody = { ...createBody(), filename: "private.png" };
    const runtime = makeRuntime({
      readJson: vi.fn(async () => unsafeBody),
    });
    const response = await routeCreateJobRequest(createRequest(unsafeBody), runtime);

    expect(response.status).toBe(400);
    expect(runtime.sessionRateLimiter.limit).not.toHaveBeenCalled();
    expect(runtime.repository.reserveAndCreate).not.toHaveBeenCalled();
  });

  it("applies the session limiter after strict parsing and before D1", async () => {
    const runtime = makeRuntime({
      sessionRateLimiter: { limit: vi.fn(async () => ({ success: false })) },
    });

    const response = await routeCreateJobRequest(createRequest(), runtime);

    expect(response.status).toBe(429);
    expect(response.headers.get("x-hereisit-rate-limit-scope")).toBe("session");
    expect(runtime.repository.reserveAndCreate).not.toHaveBeenCalled();
  });

  it("recomputes deterministic rollout before reserving a job", async () => {
    const baseline = makeRuntime();
    const runtime = makeRuntime({
      config: { ...baseline.config, rolloutPercent: 0 },
    });

    const response = await routeCreateJobRequest(createRequest(), runtime);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      contract: "tool-job@1",
      error: { code: "LOCAL_FALLBACK_REQUIRED" },
    });
    expect(runtime.repository.reserveAndCreate).not.toHaveBeenCalled();
  });

  it("renders a queued idempotent replay without an upload descriptor", async () => {
    const repository = {
      reserveAndCreate: vi.fn(async (input: ReserveAndCreateInput) => ({
        kind: "replayed" as const,
        mode: "existing-job" as const,
        job: reservationJob(input, "queued"),
      })),
    };
    const runtime = makeRuntime({ repository });

    const response = await routeCreateJobRequest(createRequest(), runtime);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      contract: "tool-job@1",
      mode: "existing-job",
      state: "queued",
    });
    expect(payload).not.toHaveProperty("upload");
  });
});

describe("POST /v1/jobs for PDF", () => {
  it("rejects a job-token-shaped value before PDF reservation", async () => {
    const runtime = makeRuntime({
      readJson: vi.fn(async () => ({
        ...pdfCreateBody(),
        anonymousSessionId: "a".repeat(43),
      })),
    });
    const response = await routeCreateJobRequest(createRequest(), runtime);
    expect(response.status).toBe(400);
    expect(runtime.repository.reserveAndCreate).not.toHaveBeenCalled();
  });

  it("creates one authenticated PDF reservation with the PDF resource class", async () => {
    const repository = {
      reserveAndCreate: vi.fn(async (input: PdfReserveAndCreateInput) => {
        const job: PdfReservationJob = {
          jobId: input.jobId,
          status: "created",
          contractId: "pdf.optimize@1",
          specHash: input.specHash,
          declaredBytes: input.request.input.byteLength,
          declaredMime: "application/pdf",
          declaredWidth: null,
          declaredHeight: null,
          declaredPageCount: input.request.input.pageCount,
          inputKey: input.inputKey,
          inputEtag: null,
          uploadVersion: 0,
          outputKey: input.outputKey,
          reservedWeightedUnits: input.estimate.reservedWeightedUnits,
          resourceClass: "pdf-standard-v1",
          attempt: 1,
          queueEpoch: input.queueEpoch,
          queueGeneration: 1,
          cancelRequestedAt: null,
          uploadExpiresAt: input.uploadExpiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        };
        return { kind: "created" as const, mode: "upload-required" as const, job };
      }),
    };
    const runtime = makeRuntime({
      repository: repository as never,
      readJson: vi.fn(async () => pdfCreateBody()),
      config: {
        ...makeRuntime().config,
        maintainerSessionHashes: new Set([
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode("123e4567-e89b-42d3-a456-426614174000"),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
        ]),
      },
    });

    const response = await routeCreateJobRequest(createRequest(pdfCreateBody()), runtime);
    expect(response.status).toBe(201);
    expect(pdfOptimizeCreateResponseSchema.parse(await response.json())).toMatchObject({
      mode: "upload-required",
      upload: { contentType: "application/pdf", byteLength: 1_000 },
    });
    expect(repository.reserveAndCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ toolContract: "pdf.optimize@1" }),
        estimate: expect.objectContaining({ resourceClass: "pdf-standard-v1" }),
      }),
    );
    expect(runtime.logCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: "pdf.optimize@1",
        byteCount: 1_000,
        pageCount: 3,
        resourceClass: "pdf-standard-v1",
      }),
    );
  });

  it("creates a non-maintainer PDF reservation only when public admission is enabled", async () => {
    const repository = {
      reserveAndCreate: vi.fn(async (input: PdfReserveAndCreateInput) => ({
        kind: "created" as const,
        mode: "upload-required" as const,
        job: {
          jobId: input.jobId,
          status: "created" as const,
          contractId: "pdf.optimize@1" as const,
          specHash: input.specHash,
          declaredBytes: input.request.input.byteLength,
          declaredMime: "application/pdf" as const,
          declaredWidth: null,
          declaredHeight: null,
          declaredPageCount: input.request.input.pageCount,
          inputKey: input.inputKey,
          inputEtag: null,
          uploadVersion: 0,
          outputKey: input.outputKey,
          reservedWeightedUnits: input.estimate.reservedWeightedUnits,
          resourceClass: "pdf-standard-v1" as const,
          attempt: 1,
          queueEpoch: input.queueEpoch,
          queueGeneration: 1,
          cancelRequestedAt: null,
          uploadExpiresAt: input.uploadExpiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        },
      })),
    };
    const runtime = makeRuntime({
      repository: repository as never,
      readJson: vi.fn(async () => pdfCreateBody()),
      config: {
        ...makeRuntime().config,
        rolloutPercent: 100,
        pdfPublicAdmissionEnabled: true,
      },
    });

    const response = await routeCreateJobRequest(createRequest(pdfCreateBody()), runtime);
    expect(response.status).toBe(201);
    expect(repository.reserveAndCreate).toHaveBeenCalledOnce();
  });

  it.each([
    [0, 3],
    [50 * 1024 * 1024 + 1, 3],
    [1_000, 0],
    [1_000, 101],
  ])("rejects PDF byte/page bounds before D1 (%s bytes, %s pages)", async (byteLength, pageCount) => {
    const runtime = makeRuntime({
      readJson: vi.fn(async () => ({
        ...pdfCreateBody(),
        input: { byteLength, mime: "application/pdf", pageCount },
      })),
    });
    const response = await routeCreateJobRequest(createRequest(), runtime);
    expect(response.status).toBe(400);
    expect(runtime.repository.reserveAndCreate).not.toHaveBeenCalled();
  });
});
