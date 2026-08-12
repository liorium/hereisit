import type {
  EngineJobStatus,
  ImageJobMessage,
  PdfEngineJobStatus,
  PdfJobMessage,
} from "@hereisit/server-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

import {
  CodecCandidateTimeoutError,
  classifyQueueFailure,
  consumeImageJob,
  consumeImageQueue,
  consumePdfJob,
  consumeProcessingQueue,
  EngineOomError,
  EngineTimeoutError,
  type QueueConsumerDependencies,
  ResourceClassUpgradeError,
  UnsupportedInputError,
} from "./queue-consumer";

const jobId = "550e8400-e29b-41d4-a716-446655440000";
const message: ImageJobMessage = {
  jobId,
  contractId: "image.optimize@1",
  specHash: "a".repeat(64),
  inputKey: "inputs/11111111-1111-4111-8111-111111111111",
  inputEtag: "input-etag",
  outputKey: "outputs/22222222-2222-4222-8222-222222222222",
  resourceClass: "image-standard-v1",
  attempt: 1,
  queueEpoch: "33333333-3333-4333-8333-333333333333",
  queueGeneration: 1,
};

const pdfMessage: PdfJobMessage = {
  jobId,
  contractId: "pdf.optimize@1",
  specHash: "b".repeat(64),
  inputKey: "inputs/11111111-1111-4111-8111-111111111111",
  inputEtag: "pdf-etag",
  outputKey: "outputs/22222222-2222-4222-8222-222222222222",
  resourceClass: "pdf-standard-v1",
  attempt: 1,
  queueEpoch: "33333333-3333-4333-8333-333333333333",
  queueGeneration: 1,
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a configured test dependency.");
  return value;
}

const succeeded: EngineJobStatus = {
  protocol: 1,
  jobId,
  state: "succeeded",
  phase: "preparing-output",
  fraction: 1,
  sequence: 2,
  result: {
    kind: "original-retained",
    testedCandidates: 1,
    engineBuildId: "engine-1",
    codecBuildId: "codec-1",
    warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
  },
  inspection: { verifiedInputMime: "image/png", inputHasAlpha: true, contentClass: "flat-graphic" },
  measurements: {
    processedInputBytes: 3,
    processedPixels: 1,
    cpuMs: 2,
    memoryByteMilliseconds: 3,
    peakMemoryBytes: 4,
    testedCandidates: 1,
    processingMs: 5,
  },
};

const pdfSucceeded: PdfEngineJobStatus = {
  protocol: 1,
  jobId,
  state: "succeeded",
  phase: "preparing-output",
  fraction: 1,
  sequence: 2,
  result: {
    kind: "original-retained",
    sourceByteLength: 3,
    pageCount: 1,
    engineBuildId: "pdf-engine-1",
    warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
  },
  inspection: { verifiedInputMime: "application/pdf", verifiedPageCount: 1, encrypted: false },
  measurements: {
    processedInputBytes: 3,
    cpuMs: 2,
    memoryByteMilliseconds: 3,
    peakMemoryBytes: 4,
    testedCandidates: 1,
    processingMs: 5,
  },
};

function dependencies(): QueueConsumerDependencies {
  const context = {
    ...message,
    leaseToken: "44444444-4444-4444-8444-444444444444",
    leaseExpiresAt: 31_000,
    declaredBytes: 3,
    declaredMime: "image/png" as const,
    spec: {
      version: 1 as const,
      mode: "smart" as const,
      preset: "balanced" as const,
      output: "same-format" as const,
      metadata: "strip" as const,
      orientation: "apply" as const,
      colorSpace: "srgb" as const,
      minimumSavingsPercent: 1,
    },
    sessionHash: "b".repeat(64),
    reservedUnits: 20_000_000,
  };
  return {
    now: () => 1_000,
    sleep: vi.fn(async () => undefined),
    leaseHeartbeat: false,
    recordEngineActivity: vi.fn(async () => undefined),
    store: {
      claim: vi.fn().mockResolvedValueOnce(context).mockResolvedValue(null),
      renew: vi.fn(async () => true),
      isCancellationRequested: vi.fn(async () => false),
      markEngineContact: vi.fn(async () => true),
      recordStartup: vi.fn(async () => true),
      mirrorProgress: vi.fn(async () => true),
      settleSuccess: vi.fn(async () => true),
      settleFailure: vi.fn(async () => true),
      scheduleRetry: vi.fn(async () => null),
      adoptAuthoritativeDelivery: vi.fn(async () => undefined),
      releaseStale: vi.fn(async () => undefined),
      quarantine: vi.fn(async () => undefined),
    },
    artifacts: {
      getInput: vi.fn(async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        size: 3,
        etag: "input-etag",
        httpMetadata: { contentType: "image/png" },
      })),
      headOutput: vi.fn(async () => null),
      storeOutput: vi.fn(),
      deleteInput: vi.fn(async () => undefined),
      deleteOutput: vi.fn(async () => undefined),
    },
    engine: {
      create: vi.fn(async () => ({ coldStart: false, containerReadyMs: 1 })),
      upload: vi.fn(async (_jobId, body) => {
        const reader = body.getReader();
        while (!(await reader.read()).done) {}
      }),
      run: vi.fn(async () => undefined),
      status: vi.fn(async () => succeeded),
      output: vi.fn(async () => new Response(null, { status: 409 })),
      cancel: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

function pdfDependencies(): QueueConsumerDependencies {
  const deps = dependencies();
  const context = {
    ...pdfMessage,
    leaseToken: "44444444-4444-4444-8444-444444444444",
    leaseExpiresAt: 31_000,
    declaredBytes: 3,
    declaredMime: "application/pdf" as const,
    declaredPageCount: 1,
    spec: {
      version: 1 as const,
      preset: "balanced" as const,
    },
    sessionHash: "b".repeat(64),
    reservedUnits: 20_000_000,
  };
  if (deps.store === undefined || deps.artifacts === undefined) {
    throw new Error("Expected configured PDF dependencies.");
  }
  vi.mocked(deps.store.claim).mockReset().mockResolvedValueOnce(context).mockResolvedValue(null);
  vi.mocked(deps.artifacts.getInput).mockResolvedValue({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0x25, 0x50, 0x44));
        controller.close();
      },
    }),
    size: 3,
    etag: "pdf-etag",
    httpMetadata: { contentType: "application/pdf" },
  });
  return {
    ...deps,
    pdfEngine: {
      create: vi.fn(async () => ({ coldStart: false, containerReadyMs: 1 })),
      upload: vi.fn(async (_jobId, body) => {
        const reader = body.getReader();
        while (!(await reader.read()).done) {}
      }),
      run: vi.fn(async () => undefined),
      status: vi.fn(async () => pdfSucceeded),
      output: vi.fn(async () => new Response(null, { status: 409 })),
      cancel: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

describe("queue failure classification", () => {
  it("separates infrastructure retries, resource upgrades, and permanent codec failures", () => {
    expect(classifyQueueFailure(new EngineTimeoutError(), { attempt: 1 })).toEqual({
      retry: true,
      delaySeconds: 10,
      nextResourceClass: "image-standard-v1",
    });
    expect(classifyQueueFailure(new CodecCandidateTimeoutError(), { attempt: 1 })).toEqual({
      retry: false,
      publicCode: "ENGINE_TIMEOUT",
      publicGuidance: "TRY_BALANCED_PRESET",
    });
    expect(classifyQueueFailure(new EngineOomError(), { attempt: 1 })).toEqual({
      retry: true,
      delaySeconds: 10,
      nextResourceClass: "image-large-v1",
    });
    expect(classifyQueueFailure(new ResourceClassUpgradeError(), { attempt: 1 })).toEqual({
      retry: true,
      delaySeconds: 0,
      nextResourceClass: "image-large-v1",
    });
    expect(classifyQueueFailure(new UnsupportedInputError(), { attempt: 1 })).toEqual({
      retry: false,
      publicCode: "UNSUPPORTED_INPUT",
    });
  });
});

describe("image queue consumer", () => {
  it("runs a claimed job once, streams input, settles, and deletes the source", async () => {
    const deps = dependencies();
    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("completed");
    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("duplicate");
    expect(deps.engine?.run).toHaveBeenCalledTimes(1);
    expect(deps.recordEngineActivity).toHaveBeenCalledTimes(5);
    expect(deps.artifacts?.deleteInput).toHaveBeenCalledWith(message.inputKey);
  });

  it("drops a restored stale epoch/generation message before engine contact", async () => {
    const deps = dependencies();
    const store = required(deps.store);
    const claimed = await store.claim(message, 1_000);
    if (claimed === null) throw new Error("Expected a claimed test job.");
    vi.mocked(store.claim).mockResolvedValueOnce({
      ...claimed,
      queueEpoch: "55555555-5555-4555-8555-555555555555",
      queueGeneration: 1,
    });

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("duplicate");
    expect(deps.engine?.create).not.toHaveBeenCalled();
    expect(deps.store?.releaseStale).toHaveBeenCalled();
  });

  it("uses D1's current attempt when an older same-epoch delivery is retried", async () => {
    const deps = dependencies();
    const store = required(deps.store);
    const claimed = await store.claim(message, 1_000);
    if (claimed === null) throw new Error("Expected a claimed test job.");
    vi.mocked(store.claim).mockResolvedValueOnce({
      ...claimed,
      attempt: 2,
      resourceClass: "image-large-v1",
      queueGeneration: 2,
    });

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("completed");
    expect(store.adoptAuthoritativeDelivery).toHaveBeenCalledOnce();
    expect(deps.engine?.create).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, resourceClass: "image-large-v1" }),
    );
  });

  it("streams a verified smaller download to artifact storage without buffering", async () => {
    const deps = dependencies();
    const engine = required(deps.engine);
    const artifacts = required(deps.artifacts);
    const outputBytes = new Uint8Array([7, 8]);
    const outputBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(outputBytes);
        controller.close();
      },
    });
    Object.defineProperty(outputBody, "arrayBuffer", {
      value: () => {
        throw new Error("must not buffer");
      },
    });
    vi.mocked(engine.status).mockResolvedValueOnce({
      ...succeeded,
      result: {
        kind: "download",
        mime: "image/png",
        byteLength: 2,
        width: 1,
        height: 1,
        testedCandidates: 1,
        engineBuildId: "engine-1",
        codecBuildId: "codec-1",
        warnings: [],
      },
    });
    vi.mocked(engine.output).mockResolvedValueOnce(
      new Response(outputBody, {
        headers: {
          "content-length": "2",
          "content-type": "image/png",
          digest: `sha-256=${"A".repeat(43)}=`,
        },
      }),
    );
    vi.mocked(artifacts.storeOutput).mockImplementationOnce(async ({ body }) => {
      const reader = body.getReader();
      const first = await reader.read();
      expect(first.value).toEqual(outputBytes);
      expect((await reader.read()).done).toBe(true);
    });

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("completed");
    expect(deps.artifacts?.storeOutput).toHaveBeenCalledWith(
      expect.objectContaining({ key: message.outputKey, byteLength: 2, mime: "image/png" }),
    );
    expect(deps.artifacts?.deleteOutput).not.toHaveBeenCalled();
  });

  it("settles an already verified first-writer output without re-encoding", async () => {
    const deps = dependencies();
    const engine = required(deps.engine);
    const artifacts = required(deps.artifacts);
    const recovered = {
      ...succeeded,
      result: {
        kind: "download" as const,
        mime: "image/png" as const,
        byteLength: 2,
        width: 1,
        height: 1,
        testedCandidates: 1,
        engineBuildId: "engine-1",
        codecBuildId: "codec-1",
        warnings: [] as const,
      },
    };
    vi.mocked(artifacts.headOutput).mockResolvedValueOnce({
      size: 2,
      mime: "image/png",
      kind: "output",
      jobId,
      sha256: `${"A".repeat(43)}=`,
      engineBuildId: "engine-1",
    });
    vi.mocked(engine.status).mockResolvedValueOnce(recovered);

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("completed");
    expect(engine.create).not.toHaveBeenCalled();
    expect(engine.run).not.toHaveBeenCalled();
    expect(engine.output).not.toHaveBeenCalled();
    expect(artifacts.storeOutput).not.toHaveBeenCalled();
    expect(deps.store?.settleSuccess).toHaveBeenCalledWith(expect.anything(), recovered, 1_000);
  });

  it("recovers a verified output after the engine workspace has disappeared", async () => {
    const deps = dependencies();
    const engine = required(deps.engine);
    const artifacts = required(deps.artifacts);
    const recovered = {
      ...succeeded,
      result: {
        kind: "download" as const,
        mime: "image/png" as const,
        byteLength: 2,
        width: 1,
        height: 1,
        testedCandidates: 1,
        engineBuildId: "engine-1",
        codecBuildId: "codec-1",
        warnings: [] as const,
      },
    };
    vi.mocked(artifacts.headOutput).mockResolvedValueOnce({
      size: 2,
      mime: "image/png",
      kind: "output",
      jobId,
      sha256: `${"A".repeat(43)}=`,
      engineBuildId: "engine-1",
      recoveryStatus: recovered,
    });

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("completed");
    expect(engine.status).not.toHaveBeenCalled();
    expect(engine.create).not.toHaveBeenCalled();
    expect(engine.run).not.toHaveBeenCalled();
    expect(engine.output).not.toHaveBeenCalled();
    expect(artifacts.storeOutput).not.toHaveBeenCalled();
    expect(deps.store?.settleSuccess).toHaveBeenCalledWith(expect.anything(), recovered, 1_000);
  });

  it("reserves and schedules an OOM retry without deleting the input", async () => {
    const deps = dependencies();
    const engine = required(deps.engine);
    const store = required(deps.store);
    vi.mocked(engine.status).mockResolvedValueOnce({
      protocol: 1,
      jobId,
      state: "failed",
      phase: "optimizing",
      fraction: 0.5,
      sequence: 2,
      measurements: succeeded.measurements,
      inspection: succeeded.inspection,
      error: { code: "ENGINE_OOM", retryable: true },
    });
    vi.mocked(store.scheduleRetry).mockResolvedValueOnce(true);

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("retry-scheduled");
    expect(deps.store?.scheduleRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nextResourceClass: "image-large-v1", delaySeconds: 10 }),
      1_000,
    );
    expect(deps.artifacts?.deleteInput).not.toHaveBeenCalled();
  });

  it("aborts before R2 or engine contact when the fenced lease is stale", async () => {
    const deps = dependencies();
    vi.mocked(required(deps.store).renew).mockResolvedValueOnce(false);

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("duplicate");
    expect(deps.artifacts?.getInput).not.toHaveBeenCalled();
    expect(deps.engine?.create).not.toHaveBeenCalled();
    expect(deps.engine?.cancel).not.toHaveBeenCalled();
    expect(deps.engine?.remove).not.toHaveBeenCalled();
  });

  it("settles a cancellation that wins before engine contact", async () => {
    const deps = dependencies();
    const store = required(deps.store);
    vi.mocked(store.renew).mockResolvedValueOnce(false);
    vi.mocked(store.isCancellationRequested).mockResolvedValueOnce(true);

    await expect(consumeImageJob(message, {} as never, deps)).resolves.toBe("completed");
    expect(store.settleFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "CANCELLED" }),
      1_000,
    );
    expect(deps.engine?.create).not.toHaveBeenCalled();
    expect(deps.artifacts?.deleteInput).toHaveBeenCalledWith(message.inputKey);
  });
});

describe("PDF queue consumer", () => {
  it("uses only the PDF engine and settles an original-retained result", async () => {
    const deps = pdfDependencies();

    await expect(consumePdfJob(pdfMessage, {} as never, deps)).resolves.toBe("completed");

    expect(deps.pdfEngine?.create).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "pdf.optimize", resourceClass: "pdf-standard-v1" }),
    );
    expect(deps.engine?.create).not.toHaveBeenCalled();
    expect(deps.store?.settleSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "pdf.optimize@1" }),
      pdfSucceeded,
      1_000,
    );
    expect(deps.artifacts?.storeOutput).not.toHaveBeenCalled();
    expect(deps.artifacts?.deleteInput).toHaveBeenCalledWith(pdfMessage.inputKey);
  });
});

describe("Queue batch disposition", () => {
  function queueMessage(body: unknown) {
    return {
      id: "message-1",
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
  }

  function batchFor(item: ReturnType<typeof queueMessage>) {
    return {
      queue: "hereisit-image-jobs-local",
      messages: [item],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<ImageJobMessage>;
  }

  it("acks malformed bodies without touching a consumer", async () => {
    const item = queueMessage({ filename: "private.png" });
    const consume = vi.fn();
    const recordQueueOperations = vi.fn(async () => undefined);
    await consumeImageQueue(batchFor(item), { IMAGE_JOBS_DLQ_NAME: "dlq" } as never, {
      consume,
      recordQueueOperations,
    });
    expect(recordQueueOperations).toHaveBeenCalledWith(3);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("explicitly retries an unexpected platform failure with bounded delay", async () => {
    const item = queueMessage(message);
    const recordQueueOperations = vi.fn(async () => undefined);
    await consumeImageQueue(batchFor(item), { IMAGE_JOBS_DLQ_NAME: "dlq" } as never, {
      recordQueueOperations,
      consume: vi.fn(async () => {
        throw new Error("platform unavailable");
      }),
    });
    expect(recordQueueOperations).toHaveBeenCalledWith(3);
    expect(item.ack).not.toHaveBeenCalled();
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
  });
});

describe("contract-isolated processing queue routing", () => {
  function item(body: unknown) {
    return {
      id: "message-1",
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
  }

  function batch(queue: string, queueItem: ReturnType<typeof item>) {
    return {
      queue,
      messages: [queueItem],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<ImageJobMessage | PdfJobMessage>;
  }

  it("routes each strict contract to exactly one matching consumer", async () => {
    const imageItem = item(message);
    const pdfItem = item(pdfMessage);
    const consumeImage = vi.fn(async () => "completed" as const);
    const consumePdf = vi.fn(async () => "completed" as const);
    const env = {
      IMAGE_JOBS_QUEUE_NAME: "image",
      IMAGE_JOBS_DLQ_NAME: "image-dlq",
      PDF_JOBS_QUEUE_NAME: "pdf",
      PDF_JOBS_DLQ_NAME: "pdf-dlq",
    } as never;

    await consumeProcessingQueue(batch("image", imageItem), env, {
      consumeImage,
      consumePdf,
      recordQueueOperations: vi.fn(async () => undefined),
    });
    await consumeProcessingQueue(batch("pdf", pdfItem), env, {
      consumeImage,
      consumePdf,
      recordQueueOperations: vi.fn(async () => undefined),
    });

    expect(consumeImage).toHaveBeenCalledTimes(1);
    expect(consumeImage).toHaveBeenCalledWith(message, env);
    expect(consumePdf).toHaveBeenCalledTimes(1);
    expect(consumePdf).toHaveBeenCalledWith(pdfMessage, env);
    expect(imageItem.ack).toHaveBeenCalledOnce();
    expect(pdfItem.ack).toHaveBeenCalledOnce();
  });

  it("acks cross-tool envelopes without contacting either engine path", async () => {
    const unsafe = item({ ...pdfMessage, resourceClass: "image-standard-v1" });
    const consumeImage = vi.fn();
    const consumePdf = vi.fn();
    await consumeProcessingQueue(
      batch("pdf", unsafe),
      {
        IMAGE_JOBS_QUEUE_NAME: "image",
        IMAGE_JOBS_DLQ_NAME: "image-dlq",
        PDF_JOBS_QUEUE_NAME: "pdf",
        PDF_JOBS_DLQ_NAME: "pdf-dlq",
      } as never,
      {
        consumeImage,
        consumePdf,
        recordQueueOperations: vi.fn(async () => undefined),
      },
    );
    expect(unsafe.ack).toHaveBeenCalledOnce();
    expect(consumeImage).not.toHaveBeenCalled();
    expect(consumePdf).not.toHaveBeenCalled();
  });
});
