import {
  type ImageOptimizeUploadDescriptor,
  imageOptimizeUploadDescriptorSchema,
} from "@hereisit/tool-contracts/image-optimize";
import {
  type PdfOptimizeUploadDescriptor,
  pdfOptimizeUploadDescriptorSchema,
} from "@hereisit/tool-contracts/pdf-optimize";
import { canonicalApiOrigin, RemoteJobError } from "./api-client";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_TIMEOUT_MILLISECONDS = 10_000;

export interface XhrLike {
  status: number;
  timeout: number;
  upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body: XMLHttpRequestBodyInit | null): void;
  abort(): void;
}

export interface UploadImageInput {
  readonly apiOrigin: string;
  readonly jobId: string;
  readonly jobToken: string;
  readonly descriptor: unknown;
  readonly file: File;
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly signal?: AbortSignal;
  readonly xhrFactory?: () => XhrLike;
  readonly now?: () => number;
}

export interface UploadPdfInput extends UploadImageInput {
  readonly digest: string;
}

function validateInput(
  input: UploadImageInput,
  schema: typeof imageOptimizeUploadDescriptorSchema | typeof pdfOptimizeUploadDescriptorSchema,
): {
  readonly descriptor: ImageOptimizeUploadDescriptor | PdfOptimizeUploadDescriptor;
  readonly url: string;
  readonly timeout: number;
} {
  if (!JOB_ID_PATTERN.test(input.jobId) || !TOKEN_PATTERN.test(input.jobToken)) {
    throw new RemoteJobError("INVALID_REQUEST", "작업 업로드 정보가 올바르지 않습니다.", false);
  }
  const parsed = schema.safeParse(input.descriptor);
  if (!parsed.success) {
    throw new RemoteJobError("INVALID_REQUEST", "업로드 지시가 올바르지 않습니다.", false);
  }
  const descriptor = parsed.data;
  if (
    descriptor.path !== `/v1/jobs/${input.jobId}/input` ||
    descriptor.byteLength !== input.file.size ||
    descriptor.contentType !== input.file.type
  ) {
    throw new RemoteJobError(
      "INVALID_REQUEST",
      "업로드 파일이 작업 지시와 일치하지 않습니다.",
      false,
    );
  }
  const origin = canonicalApiOrigin(input.apiOrigin);
  const url = new URL(descriptor.path, origin);
  if (
    url.origin !== origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== descriptor.path ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RemoteJobError("INVALID_REQUEST", "업로드 경로가 올바르지 않습니다.", false);
  }
  const now = (input.now ?? Date.now)();
  const expiresAt = Date.parse(descriptor.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new RemoteJobError("UPLOAD_EXPIRED", "업로드 기한이 만료되었습니다.", false);
  }
  return { descriptor, url: url.href, timeout: Math.max(1, Math.floor(expiresAt - now)) };
}

function uploadInput(
  input: UploadImageInput,
  schema: typeof imageOptimizeUploadDescriptorSchema | typeof pdfOptimizeUploadDescriptorSchema,
  digest?: string,
): Promise<void> {
  if (input.signal?.aborted) {
    return Promise.reject(new RemoteJobError("CANCELLED", "업로드가 취소되었습니다.", false));
  }
  let validated: ReturnType<typeof validateInput>;
  try {
    validated = validateInput(input, schema);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const xhr = (input.xhrFactory ?? (() => new XMLHttpRequest()))();
    let settled = false;
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    let responseTimedOut = false;
    const startResponseTimer = () => {
      if (responseTimer !== undefined) return;
      responseTimer = setTimeout(() => {
        responseTimedOut = true;
        xhr.abort();
      }, RESPONSE_TIMEOUT_MILLISECONDS);
    };
    const finish = (error?: RemoteJobError) => {
      if (settled) return;
      settled = true;
      if (responseTimer !== undefined) clearTimeout(responseTimer);
      input.signal?.removeEventListener("abort", abort);
      xhr.upload.onprogress = null;
      xhr.upload.onload = null;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.onabort = null;
      xhr.ontimeout = null;
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () => xhr.abort();
    xhr.upload.onprogress = (event) => {
      const total =
        event.lengthComputable && event.total === input.file.size ? event.total : input.file.size;
      const loaded = Math.min(Math.max(0, event.loaded), total);
      try {
        input.onProgress?.(loaded, total);
      } catch {
        // Progress observers must not own the upload lifecycle.
      }
      if (loaded === total) startResponseTimer();
    };
    xhr.upload.onload = startResponseTimer;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish();
      else
        finish(new RemoteJobError("STORAGE_FAILURE", "파일 업로드를 완료하지 못했습니다.", true));
    };
    xhr.onerror = () =>
      finish(new RemoteJobError("STORAGE_FAILURE", "파일 업로드 중 연결이 끊겼습니다.", true));
    xhr.ontimeout = () =>
      finish(new RemoteJobError("UPLOAD_EXPIRED", "파일 업로드 시간이 초과되었습니다.", true));
    xhr.onabort = () =>
      finish(
        responseTimedOut
          ? new RemoteJobError("STORAGE_FAILURE", "업로드 응답 시간이 초과되었습니다.", true)
          : new RemoteJobError("CANCELLED", "파일 업로드가 취소되었습니다.", false),
      );
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      xhr.open("PUT", validated.url, true);
      xhr.timeout = validated.timeout;
      xhr.setRequestHeader("Authorization", `Bearer ${input.jobToken}`);
      xhr.setRequestHeader("Content-Type", validated.descriptor.contentType);
      if (digest !== undefined) xhr.setRequestHeader("Digest", digest);
      xhr.send(input.file);
    } catch {
      finish(new RemoteJobError("STORAGE_FAILURE", "파일 업로드를 시작하지 못했습니다.", true));
    }
  });
}

export function uploadImageInput(input: UploadImageInput): Promise<void> {
  return uploadInput(input, imageOptimizeUploadDescriptorSchema);
}

export function uploadPdfInput(input: UploadPdfInput): Promise<void> {
  if (!/^sha-256=[A-Za-z0-9+/]{43}=$/.test(input.digest)) {
    return Promise.reject(
      new RemoteJobError("INVALID_REQUEST", "PDF 업로드 정보가 올바르지 않습니다.", false),
    );
  }
  return uploadInput(input, pdfOptimizeUploadDescriptorSchema, input.digest);
}
