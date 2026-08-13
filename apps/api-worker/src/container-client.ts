import { Container, getContainer, type StopParams } from "@cloudflare/containers";
import {
  type EngineCreateJobRequest,
  type EngineCreatePdfJobRequest,
  type EngineJobStatus,
  engineCreateJobRequestSchema,
  engineCreatePdfJobRequestSchema,
  engineJobStatusSchema,
  type PdfEngineJobStatus,
  pdfEngineJobStatusSchema,
} from "@hereisit/server-contracts";
import type { Env } from "./env";

const ENGINE_ORIGIN = "http://image-engine";
const PDF_ENGINE_ORIGIN = "http://pdf-engine";
const MAX_STATUS_BYTES = 64 * 1024;
const ENGINE_IMAGE_PATTERN =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/hereisit-image-engine@sha256:([0-9a-f]{64})$/;
const PDF_ENGINE_IMAGE_PATTERN =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/hereisit-pdf-engine@sha256:([0-9a-f]{64})$/;

export function createImageEngineEnvironment(engineImage: string): Record<string, string> {
  const digest = ENGINE_IMAGE_PATTERN.exec(engineImage)?.[1];
  if (digest === undefined && engineImage !== "local-dockerfile") {
    throw new TypeError("Engine image identity is invalid.");
  }
  return {
    ENGINE_BUILD_ID: digest === undefined ? engineImage : `sha256:${digest}`,
    JPEG_CODEC_BUILD_ID: "mozjpeg-4.1.1+a2d2907",
    PNG_CODEC_BUILD_ID: "quantizr-1.4.3+oxipng-10.1.1",
    WEBP_CODEC_BUILD_ID: "libwebp-1.6.0+4fa2191",
    TRANSFORM_BUILD_ID: "libvips-8.18.4+e01a479",
  };
}

export function createPdfEngineEnvironment(engineImage: string): Record<string, string> {
  const digest = PDF_ENGINE_IMAGE_PATTERN.exec(engineImage)?.[1];
  if (digest === undefined && engineImage !== "local-dockerfile") {
    throw new TypeError("PDF engine image identity is invalid.");
  }
  return {
    ENGINE_BUILD_ID: digest === undefined ? engineImage : `sha256:${digest}`,
    QPDF_BUILD_ID: "qpdf-12.4.0",
  };
}

interface TypedEngineClient<CreateRequest, Status> {
  create(request: CreateRequest): Promise<{
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
  status(jobId: string): Promise<Status>;
  output(jobId: string): Promise<Response>;
  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export type EngineClient = TypedEngineClient<EngineCreateJobRequest, EngineJobStatus>;
export type PdfEngineClient = TypedEngineClient<EngineCreatePdfJobRequest, PdfEngineJobStatus>;

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

export class ImageEngineContainer extends Container<Env> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override pingEndpoint = "/healthz";
  override sleepAfter = "60s";
  override enableInternet = false;

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = createImageEngineEnvironment(env.ENGINE_IMAGE_DIGEST);
  }

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

export class PdfEngineContainer extends Container<Env> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override pingEndpoint = "/healthz";
  override sleepAfter = "60s";
  override enableInternet = false;

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = createPdfEngineEnvironment(env.PDF_ENGINE_IMAGE_DIGEST);
  }

  override onError(_error: unknown): void {}

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
export type PdfEngineBindingTypeAssertion = Assert<
  Env["PDF_ENGINE"] extends DurableObjectNamespace<PdfEngineContainer> ? true : false
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

async function readStrictStatus<Status>(
  response: Response,
  schema: { safeParse(value: unknown): { success: boolean; data?: Status } },
): Promise<Status> {
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
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new EngineProtocolError();
    return parsed.data as Status;
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

function createTypedEngineClientFromStub<CreateRequest, Status>(
  stub: EngineContainerStub,
  options: {
    origin: string;
    createSchema: { parse(value: unknown): CreateRequest };
    statusSchema: { safeParse(value: unknown): { success: boolean; data?: Status } };
  },
  now: () => number = () => performance.now(),
): TypedEngineClient<CreateRequest, Status> {
  return {
    async create(rawRequest) {
      const request = options.createSchema.parse(rawRequest);
      try {
        const before = await stub.getState();
        const startedAt = now();
        await expectOk(
          await stub.fetch(`${options.origin}/v1/jobs`, {
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
          await stub.fetch(`${options.origin}/v1/jobs/${jobId}/input`, {
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
          await stub.fetch(`${options.origin}/v1/jobs/${jobId}/run`, { method: "POST" }),
        );
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async status(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        return await readStrictStatus(
          await stub.fetch(`${options.origin}/v1/jobs/${jobId}`),
          options.statusSchema,
        );
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async output(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        return await stub.fetch(`${options.origin}/v1/jobs/${jobId}/output`);
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async cancel(rawJobId) {
      const jobId = canonicalJobId(rawJobId);
      try {
        await expectOk(
          await stub.fetch(`${options.origin}/v1/jobs/${jobId}`, { method: "DELETE" }),
        );
      } catch (error) {
        normalizePlatformFailure(error);
      }
    },

    async remove(rawJobId) {
      return this.cancel(rawJobId);
    },
  };
}

export function createEngineClientFromStub(
  stub: EngineContainerStub,
  now?: () => number,
): EngineClient {
  return createTypedEngineClientFromStub(
    stub,
    {
      origin: ENGINE_ORIGIN,
      createSchema: engineCreateJobRequestSchema,
      statusSchema: engineJobStatusSchema,
    },
    now,
  ) as EngineClient;
}

export function createPdfEngineClientFromStub(
  stub: EngineContainerStub,
  now?: () => number,
): PdfEngineClient {
  return createTypedEngineClientFromStub(
    stub,
    {
      origin: PDF_ENGINE_ORIGIN,
      createSchema: engineCreatePdfJobRequestSchema,
      statusSchema: pdfEngineJobStatusSchema,
    },
    now,
  ) as PdfEngineClient;
}

export function createContainerEngineClient(env: Env): EngineClient {
  return createEngineClientFromStub(
    getContainer(env.IMAGE_ENGINE, env.ENGINE_INSTANCE_NAME) as EngineContainerStub,
  );
}

export function createContainerPdfEngineClient(env: Env): PdfEngineClient {
  return createPdfEngineClientFromStub(
    getContainer(env.PDF_ENGINE, env.PDF_ENGINE_INSTANCE_NAME) as EngineContainerStub,
  );
}
