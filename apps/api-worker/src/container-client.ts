import { Container, getContainer, type StopParams } from "@cloudflare/containers";
import {
  type EngineCreateJobRequest,
  type EngineJobStatus,
  engineCreateJobRequestSchema,
  engineJobStatusSchema,
} from "@hereisit/server-contracts";
import type { Env } from "./env";

const ENGINE_ORIGIN = "http://image-engine";
const MAX_STATUS_BYTES = 64 * 1024;

export interface EngineClient {
  create(request: EngineCreateJobRequest): Promise<{
    coldStart: boolean;
    containerReadyMs: number;
  }>;
  upload(
    jobId: string,
    body: ReadableStream<Uint8Array>,
    byteLength: number,
    contentType: string,
  ): Promise<void>;
  run(jobId: string): Promise<void>;
  status(jobId: string): Promise<EngineJobStatus>;
  output(jobId: string): Promise<Response>;
  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export interface EngineContainerStub {
  getState(): Promise<{ readonly status: string; readonly lastChange: number }>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class EngineCrashError extends Error {
  constructor() {
    super("ENGINE_CRASH");
    this.name = "EngineCrashError";
  }
}

export class EngineProtocolError extends Error {
  constructor() {
    super("ENGINE_PROTOCOL_ERROR");
    this.name = "EngineProtocolError";
  }
}

export class EngineHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("ENGINE_HTTP_ERROR");
    this.name = "EngineHttpError";
    this.status = status;
  }
}

export class ImageEngineContainer extends Container {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override pingEndpoint = "/healthz";
  override sleepAfter = "60s";
  override enableInternet = false;

  override onError(_error: unknown): void {
    // Platform Error objects and container stderr are deliberately not serialized.
  }

  override onStop(params: StopParams): void {
    console.info({
      event: "container-stop",
      exitCode: Number.isSafeInteger(params.exitCode) ? params.exitCode : null,
    });
  }
}

type Assert<T extends true> = T;
export type ImageEngineBindingTypeAssertion = Assert<
  Env["IMAGE_ENGINE"] extends DurableObjectNamespace<ImageEngineContainer> ? true : false
>;

function canonicalJobId(jobId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(jobId)) {
    throw new TypeError("Engine job ID must be a lowercase canonical UUID.");
  }
  return jobId;
}

async function expectOk(response: Response): Promise<void> {
  if (!response.ok) {
    throw new EngineHttpError(response.status);
  }
  await response.body?.cancel();
}

async function readStrictStatus(response: Response): Promise<EngineJobStatus> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new EngineHttpError(response.status);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_STATUS_BYTES) {
    await response.body?.cancel();
    throw new EngineProtocolError();
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || response.body === null) {
    await response.body?.cancel();
    throw new EngineProtocolError();
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_STATUS_BYTES);
  let byteLength = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (byteLength + next.value.byteLength > MAX_STATUS_BYTES) {
        await reader.cancel();
        throw new EngineProtocolError();
      }
      buffer.set(next.value, byteLength);
      byteLength += next.value.byteLength;
    }
    if (declaredLength !== null && Number(declaredLength) !== byteLength) {
      throw new EngineProtocolError();
    }
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, byteLength),
    );
    const value: unknown = JSON.parse(serialized);
    const parsed = engineJobStatusSchema.safeParse(value);
    if (!parsed.success) throw new EngineProtocolError();
    return parsed.data as EngineJobStatus;
  } catch {
    throw new EngineProtocolError();
  } finally {
    buffer.fill(0);
    reader.releaseLock();
  }
}

function normalizePlatformFailure(error: unknown): never {
  if (
    error instanceof EngineHttpError ||
    error instanceof EngineProtocolError ||
    error instanceof TypeError
  ) {
    throw error;
  }
  throw new EngineCrashError();
}

export function createEngineClientFromStub(
  stub: EngineContainerStub,
  now: () => number = () => performance.now(),
): EngineClient {
  return {
    async create(rawRequest) {
      const request = engineCreateJobRequestSchema.parse(rawRequest);
      try {
        const before = await stub.getState();
        const startedAt = now();
        await expectOk(
          await stub.fetch(`${ENGINE_ORIGIN}/v1/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          }),
        );
        return {
          coldStart: before.status !== "running" && before.status !== "healthy",
          containerReadyMs: Math.max(0, Math.ceil(now() - startedAt)),
        };
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async upload(rawJobId, body, byteLength, contentType) {
      const jobId = canonicalJobId(rawJobId);
      if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
        throw new TypeError("Engine upload length must be a positive safe integer.");
      }
      try {
        await expectOk(
          await stub.fetch(`${ENGINE_ORIGIN}/v1/jobs/${jobId}/input`, {
            method: "PUT",
            headers: {
              "content-length": String(byteLength),
              "content-type": contentType,
            },
            body,
          }),
        );
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async run(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        await expectOk(
          await stub.fetch(`${ENGINE_ORIGIN}/v1/jobs/${jobId}/run`, { method: "POST" }),
        );
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async status(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        return await readStrictStatus(await stub.fetch(`${ENGINE_ORIGIN}/v1/jobs/${jobId}`));
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async output(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        return await stub.fetch(`${ENGINE_ORIGIN}/v1/jobs/${jobId}/output`);
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async cancel(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        await expectOk(await stub.fetch(`${ENGINE_ORIGIN}/v1/jobs/${jobId}`, { method: "DELETE" }));
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async remove(rawJobId) {
      return this.cancel(rawJobId);
    },
  };
}

export function createContainerEngineClient(env: Env): EngineClient {
  return createEngineClientFromStub(
    getContainer(env.IMAGE_ENGINE, env.ENGINE_INSTANCE_NAME) as EngineContainerStub,
  );
}
