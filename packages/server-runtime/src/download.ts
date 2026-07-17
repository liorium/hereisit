import {
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  type ImageOptimizeResultDescriptor,
} from "@hereisit/tool-contracts/image-optimize";
import { toolJobErrorResponseSchema } from "@hereisit/tool-contracts/tool-job";
import {
  acknowledgeRemoteDownload,
  canonicalApiOrigin,
  deleteRemoteJob,
  RemoteJobError,
} from "./api-client";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RemoteArchivePart {
  readonly byteLength: number;
  readonly stream: ReadableStream<Uint8Array>;
  acknowledge(): Promise<void>;
  cancelStream(): Promise<void>;
}

export interface RemoteDownloadHandle {
  readonly descriptor: Extract<ImageOptimizeResultDescriptor, { kind: "download" }>;
  download(input: {
    readonly filename: string;
    readonly onProgress?: (loaded: number, total: number) => void;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  fetchForArchive(input: {
    readonly remainingByteBudget: number;
    readonly signal?: AbortSignal;
  }): Promise<RemoteArchivePart>;
  dispose(): Promise<void>;
}

export interface CreateRemoteDownloadHandleInput {
  readonly apiOrigin: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly descriptor: Extract<ImageOptimizeResultDescriptor, { kind: "download" }>;
  readonly fetch?: typeof fetch;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly clickAnchor?: (input: { readonly href: string; readonly download: string }) => void;
  readonly confirmDownloadHandoff?: () => Promise<boolean>;
  readonly scheduleRevoke?: (callback: () => void) => void;
}

export interface DownloadRemoteResultInput extends CreateRemoteDownloadHandleInput {
  readonly filename: string;
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly signal?: AbortSignal;
}

interface ClaimedResponse {
  readonly response: Response;
  readonly lease: string;
}

function validateHandleInput(input: CreateRemoteDownloadHandleInput): void {
  canonicalApiOrigin(input.apiOrigin);
  if (!JOB_ID_PATTERN.test(input.jobId) || !TOKEN_PATTERN.test(input.jobToken)) {
    throw new RemoteJobError("INVALID_REQUEST", "다운로드 작업 정보가 올바르지 않습니다.", false);
  }
  if (
    !Number.isSafeInteger(input.descriptor.byteLength) ||
    input.descriptor.byteLength <= 0 ||
    input.descriptor.byteLength > IMAGE_OPTIMIZE_MAX_FILE_BYTES
  ) {
    throw new RemoteJobError(
      "INPUT_LIMIT_EXCEEDED",
      "다운로드 결과 크기가 허용 범위를 벗어났습니다.",
      false,
    );
  }
}

async function responseError(response: Response): Promise<RemoteJobError> {
  try {
    const parsed = toolJobErrorResponseSchema.parse(await response.json());
    const rawRetryAfter = response.headers.get("retry-after");
    const retryAfterSeconds =
      rawRetryAfter !== null && /^\d+$/.test(rawRetryAfter) ? Number(rawRetryAfter) : undefined;
    return new RemoteJobError(parsed.error.code, parsed.error.message, parsed.error.retryable, {
      ...(parsed.error.guidance === undefined ? {} : { guidance: parsed.error.guidance }),
      ...(retryAfterSeconds === undefined || !Number.isSafeInteger(retryAfterSeconds)
        ? {}
        : { retryAfterSeconds }),
    });
  } catch {
    return new RemoteJobError("INVALID_REQUEST", "처리 서버의 응답이 올바르지 않습니다.", false);
  }
}

async function bestEffortDelete(input: CreateRemoteDownloadHandleInput): Promise<void> {
  await deleteRemoteJob({
    apiOrigin: input.apiOrigin,
    jobId: input.jobId,
    jobToken: input.jobToken,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  }).catch(() => undefined);
}

async function claimResult(
  input: CreateRemoteDownloadHandleInput,
  signal?: AbortSignal,
): Promise<ClaimedResponse> {
  if (signal?.aborted) {
    throw new RemoteJobError("CANCELLED", "다운로드가 취소되었습니다.", false);
  }
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(
      `${canonicalApiOrigin(input.apiOrigin)}/v1/jobs/${input.jobId}/result`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${input.jobToken}` },
        cache: "no-store",
        credentials: "omit",
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch {
    if (signal?.aborted) {
      throw new RemoteJobError("CANCELLED", "다운로드가 취소되었습니다.", false);
    }
    throw new RemoteJobError("STORAGE_FAILURE", "결과 파일을 불러오지 못했습니다.", true);
  }
  if (!response.ok) throw await responseError(response);
  const length = response.headers.get("content-length");
  const contentType = response.headers.get("content-type");
  const lease = response.headers.get("x-download-lease");
  if (
    length !== String(input.descriptor.byteLength) ||
    contentType !== input.descriptor.mime ||
    lease === null ||
    !TOKEN_PATTERN.test(lease) ||
    response.body === null
  ) {
    await response.body?.cancel().catch(() => undefined);
    await bestEffortDelete(input);
    throw new RemoteJobError("VERIFICATION_FAILED", "다운로드 결과를 검증하지 못했습니다.", false);
  }
  return { response, lease };
}

async function acknowledge(
  input: CreateRemoteDownloadHandleInput,
  lease: string,
  signal?: AbortSignal,
): Promise<void> {
  await acknowledgeRemoteDownload({
    apiOrigin: input.apiOrigin,
    jobId: input.jobId,
    jobToken: input.jobToken,
    downloadLease: lease,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function defaultClickAnchor(input: { readonly href: string; readonly download: string }): void {
  const anchor = document.createElement("a");
  anchor.hidden = true;
  anchor.href = input.href;
  anchor.download = input.download;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

function validFilename(filename: string): boolean {
  const hasUnsafeCharacter = Array.from(filename).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || character === "/" || character === "\\";
  });
  return (
    filename.length > 0 &&
    filename.length <= 255 &&
    !hasUnsafeCharacter &&
    filename !== "." &&
    filename !== ".."
  );
}

async function readExactBlob(
  response: Response,
  expected: number,
  mime: string,
  onProgress: ((loaded: number, total: number) => void) | undefined,
): Promise<Blob> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new RemoteJobError("VERIFICATION_FAILED", "다운로드 본문이 없습니다.", false);
  }
  const chunks: BlobPart[] = [];
  let loaded = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      loaded += next.value.byteLength;
      if (loaded > expected) {
        throw new RemoteJobError(
          "VERIFICATION_FAILED",
          "다운로드 크기가 일치하지 않습니다.",
          false,
        );
      }
      chunks.push(Uint8Array.from(next.value).buffer);
      try {
        onProgress?.(loaded, expected);
      } catch {
        // Progress observers must not own the result stream.
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (loaded !== expected) {
    throw new RemoteJobError("VERIFICATION_FAILED", "다운로드 크기가 일치하지 않습니다.", false);
  }
  return new Blob(chunks, { type: mime });
}

export function createRemoteDownloadHandle(
  input: CreateRemoteDownloadHandleInput,
): RemoteDownloadHandle {
  validateHandleInput(input);
  return {
    descriptor: input.descriptor,
    async download(downloadInput) {
      if (!validFilename(downloadInput.filename)) {
        throw new RemoteJobError("INVALID_REQUEST", "다운로드 파일명이 올바르지 않습니다.", false);
      }
      const claimed = await claimResult(input, downloadInput.signal);
      let blob: Blob;
      try {
        blob = await readExactBlob(
          claimed.response,
          input.descriptor.byteLength,
          input.descriptor.mime,
          downloadInput.onProgress,
        );
      } catch (error) {
        if (error instanceof RemoteJobError && error.code === "VERIFICATION_FAILED") {
          await bestEffortDelete(input);
        }
        throw error;
      }
      const createObjectURL = input.createObjectURL ?? URL.createObjectURL.bind(URL);
      const revokeObjectURL = input.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
      const href = createObjectURL(blob);
      try {
        (input.clickAnchor ?? defaultClickAnchor)({ href, download: downloadInput.filename });
      } finally {
        (input.scheduleRevoke ?? ((callback) => setTimeout(callback, 0)))(() =>
          revokeObjectURL(href),
        );
      }
      if ((await input.confirmDownloadHandoff?.()) === true) {
        await acknowledge(input, claimed.lease, downloadInput.signal);
      }
    },
    async fetchForArchive(archiveInput) {
      if (
        !Number.isSafeInteger(archiveInput.remainingByteBudget) ||
        archiveInput.remainingByteBudget < input.descriptor.byteLength
      ) {
        throw new RemoteJobError(
          "INPUT_LIMIT_EXCEEDED",
          "기기의 ZIP 생성 가능 용량을 초과했습니다.",
          false,
        );
      }
      const claimed = await claimResult(input, archiveInput.signal);
      const reader = claimed.response.body?.getReader();
      if (reader === undefined) {
        await bestEffortDelete(input);
        throw new RemoteJobError("VERIFICATION_FAILED", "다운로드 본문이 없습니다.", false);
      }
      let loaded = 0;
      let complete = false;
      let acknowledged = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              if (loaded !== input.descriptor.byteLength) {
                await bestEffortDelete(input);
                controller.error(
                  new RemoteJobError(
                    "VERIFICATION_FAILED",
                    "다운로드 크기가 일치하지 않습니다.",
                    false,
                  ),
                );
                return;
              }
              complete = true;
              controller.close();
              return;
            }
            loaded += next.value.byteLength;
            if (loaded > input.descriptor.byteLength) {
              await reader.cancel();
              await bestEffortDelete(input);
              controller.error(
                new RemoteJobError(
                  "VERIFICATION_FAILED",
                  "다운로드 크기가 일치하지 않습니다.",
                  false,
                ),
              );
              return;
            }
            controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await reader.cancel().catch(() => undefined);
        },
      });
      return {
        byteLength: input.descriptor.byteLength,
        stream,
        async acknowledge() {
          if (!complete) {
            throw new RemoteJobError(
              "INVALID_REQUEST",
              "ZIP 입력 스트림을 모두 읽은 뒤 확인할 수 있습니다.",
              false,
            );
          }
          if (acknowledged) return;
          await acknowledge(input, claimed.lease, archiveInput.signal);
          acknowledged = true;
        },
        async cancelStream() {
          await reader.cancel().catch(() => undefined);
        },
      };
    },
    async dispose() {
      await deleteRemoteJob({
        apiOrigin: input.apiOrigin,
        jobId: input.jobId,
        jobToken: input.jobToken,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
    },
  };
}

export async function downloadRemoteResult(input: DownloadRemoteResultInput): Promise<void> {
  const { filename, onProgress, signal, ...handleInput } = input;
  await createRemoteDownloadHandle(handleInput).download({
    filename,
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(signal === undefined ? {} : { signal }),
  });
}
