import {
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  type ImageOptimizeMime,
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  type PdfOptimizeMime,
} from "@hereisit/tool-contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEY_PATTERN = new RegExp(`^inputs/${UUID_PATTERN.source.slice(1, -1)}$`);
const OUTPUT_KEY_PATTERN = new RegExp(`^outputs/${UUID_PATTERN.source.slice(1, -1)}$`);
const SAFE_ETAG_PATTERN = /^[\x20-\x7e]{1,256}$/;
const ALLOWED_MIMES = new Set<ImageOptimizeMime>(["image/jpeg", "image/png", "image/webp"]);
const PENDING_CLEANUP_TIMEOUT_MILLISECONDS = 250;

export type ArtifactMime = ImageOptimizeMime | PdfOptimizeMime;

export type ArtifactObjectKey = `inputs/${string}` | `outputs/${string}`;
export type InputArtifactObjectKey = `inputs/${string}`;

export interface ArtifactHead {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag?: string;
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface ArtifactBucket {
  put(
    key: string,
    value: ReadableStream,
    options: {
      onlyIf: Headers;
      httpMetadata: { contentType: ArtifactMime };
      customMetadata: Readonly<Record<string, string>>;
    },
  ): Promise<ArtifactHead | null>;
  get?(key: string): Promise<(ArtifactHead & { readonly body: ReadableStream<Uint8Array> }) | null>;
  head(key: string): Promise<ArtifactHead | null>;
  delete(key: string): Promise<void>;
}

export interface FixedLengthStreamPair {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

export type Sha256DigestStream = WritableStream<ArrayBuffer | ArrayBufferView> & {
  readonly digest: Promise<ArrayBuffer>;
};

function defaultDigestStream(): Sha256DigestStream {
  const DigestStreamConstructor = (
    crypto as unknown as {
      DigestStream?: new (algorithm: string) => Sha256DigestStream;
    }
  ).DigestStream;
  if (typeof DigestStreamConstructor !== "function") {
    throw new ArtifactUploadError("STORAGE_FAILURE");
  }
  return new DigestStreamConstructor("SHA-256");
}

export interface VerifiedInputArtifact {
  readonly key: InputArtifactObjectKey;
  readonly byteLength: number;
  readonly mime: ArtifactMime;
  readonly etag: string;
  readonly uploadVersion: number;
}

export type StoreExactInputArtifactResult =
  | { readonly kind: "stored"; readonly artifact: VerifiedInputArtifact }
  | {
      /**
       * A create-only put lost or its response was lost. Images match the immutable
       * key/size/MIME/upload-version boundary; PDFs additionally require a server-verified digest.
       */
      readonly kind: "existing-authoritative";
      readonly artifact: VerifiedInputArtifact;
    };

export type ArtifactUploadErrorCode =
  | "INVALID_ARTIFACT_REQUEST"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_MISMATCH"
  | "STORAGE_FAILURE";

export class ArtifactUploadError extends Error {
  readonly code: ArtifactUploadErrorCode;

  constructor(code: ArtifactUploadErrorCode) {
    super(code);
    this.name = "ArtifactUploadError";
    this.code = code;
  }
}

export interface ArtifactDeletionAuthorization {
  readonly kind: "delete-unowned-object";
  readonly key: ArtifactObjectKey;
}

function isArtifactMime(value: string): value is ArtifactMime {
  return value === "application/pdf" || ALLOWED_MIMES.has(value as ImageOptimizeMime);
}

function maximumBytes(mime: ArtifactMime): number {
  return mime === "application/pdf" ? PDF_OPTIMIZE_MAX_FILE_BYTES : IMAGE_OPTIMIZE_MAX_FILE_BYTES;
}

function isCanonicalInputKey(value: string): value is InputArtifactObjectKey {
  return INPUT_KEY_PATTERN.test(value);
}

function isCanonicalArtifactKey(value: string): value is ArtifactObjectKey {
  return isCanonicalInputKey(value) || OUTPUT_KEY_PATTERN.test(value);
}

function pendingInputKey(inputKey: InputArtifactObjectKey, attemptId: string): string {
  if (!UUID_PATTERN.test(attemptId)) {
    throw new ArtifactUploadError("INVALID_ARTIFACT_REQUEST");
  }
  return `pending-${inputKey}/${attemptId}`;
}

function defaultFixedLengthStream(expectedLength: number): FixedLengthStreamPair {
  return new FixedLengthStream(expectedLength);
}

async function pipeToFixedLengthStream(
  source: ReadableStream<Uint8Array>,
  destination: WritableStream<ArrayBuffer | ArrayBufferView>,
  signal: AbortSignal,
  digestDestination?: WritableStream<ArrayBuffer | ArrayBufferView>,
): Promise<void> {
  const reader = source.getReader();
  const writer = destination.getWriter();
  const digestWriter = digestDestination?.getWriter();
  let abortSettlement: Promise<void> | null = null;
  const abort = () => {
    const reason = signal.reason ?? new ArtifactUploadError("UPLOAD_MISMATCH");
    abortSettlement = Promise.allSettled([
      reader.cancel(reason),
      writer.abort(reason),
      ...(digestWriter === undefined ? [] : [digestWriter.abort(reason)]),
    ]).then(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    if (signal.aborted) {
      abort();
      await abortSettlement;
      throw signal.reason;
    }
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      await writer.write(next.value);
      await digestWriter?.write(next.value);
    }
    await writer.close();
    await digestWriter?.close();
  } catch (error) {
    if (abortSettlement === null) {
      await Promise.allSettled([
        reader.cancel(error),
        writer.abort(error),
        ...(digestWriter === undefined ? [] : [digestWriter.abort(error)]),
      ]);
    } else {
      await abortSettlement;
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
    writer.releaseLock();
    digestWriter?.releaseLock();
  }
}

export function createOpaqueObjectKey(
  kind: "inputs" | "outputs",
  randomId: string,
): ArtifactObjectKey {
  if (!UUID_PATTERN.test(randomId)) {
    throw new TypeError("Object IDs must be canonical lowercase UUIDs.");
  }
  return `${kind}/${randomId}`;
}

export function verifyInputArtifactHead(
  head: ArtifactHead | null,
  expected: {
    readonly key: string;
    readonly byteLength: number;
    readonly mime: string;
    readonly uploadVersion: number;
    readonly expectedSha256?: string;
  },
): VerifiedInputArtifact {
  if (
    head === null ||
    !isCanonicalInputKey(expected.key) ||
    !Number.isSafeInteger(expected.byteLength) ||
    expected.byteLength < 1 ||
    !isArtifactMime(expected.mime) ||
    expected.byteLength > maximumBytes(expected.mime) ||
    !Number.isSafeInteger(expected.uploadVersion) ||
    expected.uploadVersion < 1
  ) {
    throw new ArtifactUploadError("UPLOAD_MISMATCH");
  }

  const metadata = head.customMetadata;
  if (
    head.key !== expected.key ||
    head.size !== expected.byteLength ||
    head.httpMetadata?.contentType !== expected.mime ||
    metadata === undefined ||
    Object.keys(metadata).length !== (expected.expectedSha256 === undefined ? 2 : 3) ||
    metadata.kind !== "input" ||
    metadata.uploadVersion !== String(expected.uploadVersion) ||
    (expected.expectedSha256 !== undefined &&
      metadata.verifiedSha256 !== expected.expectedSha256) ||
    !SAFE_ETAG_PATTERN.test(head.etag)
  ) {
    throw new ArtifactUploadError("UPLOAD_MISMATCH");
  }

  return {
    key: expected.key,
    byteLength: expected.byteLength,
    mime: expected.mime,
    etag: head.etag,
    uploadVersion: expected.uploadVersion,
  };
}

async function readArtifactBody(
  bucket: ArtifactBucket,
  key: string,
): Promise<(ArtifactHead & { readonly body: ReadableStream<Uint8Array> }) | null> {
  if (bucket.get === undefined) throw new ArtifactUploadError("STORAGE_FAILURE");
  try {
    return await bucket.get(key);
  } catch {
    throw new ArtifactUploadError("STORAGE_FAILURE");
  }
}

function encodeDigest(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return `sha-256=${btoa(binary)}`;
}

async function boundedCleanupOperation<T>(operation: Promise<T>): Promise<T | undefined> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), PENDING_CLEANUP_TIMEOUT_MILLISECONDS);
    void operation.then(
      (value) => finish(value),
      () => finish(undefined),
    );
  });
}

async function deletePendingIfOwned(input: {
  readonly bucket: ArtifactBucket;
  readonly key: string;
  readonly uploadVersion: number;
  readonly ownershipMarker: string;
}): Promise<void> {
  const head = await boundedCleanupOperation(input.bucket.head(input.key));
  const metadata = head?.customMetadata;
  if (
    head === null ||
    head === undefined ||
    metadata === undefined ||
    Object.keys(metadata).length !== 3 ||
    metadata.kind !== "pending-input" ||
    metadata.uploadVersion !== String(input.uploadVersion) ||
    metadata.ownershipMarker !== input.ownershipMarker
  ) {
    return;
  }
  await boundedCleanupOperation(input.bucket.delete(input.key));
}

async function storeVerifiedPdfArtifact(input: {
  readonly bucket: ArtifactBucket;
  readonly source: ReadableStream<Uint8Array>;
  readonly key: InputArtifactObjectKey;
  readonly byteLength: number;
  readonly uploadVersion: number;
  readonly deadlineAt: number;
  readonly expectedSha256: string;
  readonly now: () => number;
  readonly createFixedLengthStream?: (expectedLength: number) => FixedLengthStreamPair;
  readonly createDigestStream?: () => Sha256DigestStream;
  readonly randomUuid: () => string;
}): Promise<StoreExactInputArtifactResult> {
  const remainingMilliseconds = input.deadlineAt - input.now();
  if (remainingMilliseconds <= 0) throw new ArtifactUploadError("UPLOAD_EXPIRED");
  const pendingKey = pendingInputKey(input.key, input.randomUuid());
  const ownershipMarker = input.randomUuid();
  if (!UUID_PATTERN.test(ownershipMarker)) {
    throw new ArtifactUploadError("INVALID_ARTIFACT_REQUEST");
  }
  const fixedLengthStream = (input.createFixedLengthStream ?? defaultFixedLengthStream)(
    input.byteLength,
  );
  const digestStream = (input.createDigestStream ?? defaultDigestStream)();
  const digestObserved = digestStream.digest.then(
    (value) => ({ status: "fulfilled" as const, value }),
    () => ({ status: "rejected" as const }),
  );
  const abortController = new AbortController();
  let deadlineExpired = false;
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    abortController.abort(new ArtifactUploadError("UPLOAD_EXPIRED"));
  }, remainingMilliseconds);
  const producer = pipeToFixedLengthStream(
    input.source,
    fixedLengthStream.writable,
    abortController.signal,
    digestStream,
  );
  const pendingPut = Promise.resolve().then(() =>
    input.bucket.put(pendingKey, fixedLengthStream.readable, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        kind: "pending-input",
        uploadVersion: String(input.uploadVersion),
        ownershipMarker,
      },
    }),
  );
  try {
    const [produced, storedPending] = await Promise.allSettled([producer, pendingPut]);
    clearTimeout(timeout);
    if (produced.status === "rejected" || storedPending.status === "rejected") {
      throw new ArtifactUploadError(deadlineExpired ? "UPLOAD_EXPIRED" : "STORAGE_FAILURE");
    }
    if (storedPending.value === null) throw new ArtifactUploadError("UPLOAD_MISMATCH");
    const digest = await digestObserved;
    if (digest.status === "rejected") {
      throw new ArtifactUploadError("UPLOAD_MISMATCH");
    }
    const actualSha256 = encodeDigest(digest.value);
    if (actualSha256 !== input.expectedSha256) {
      throw new ArtifactUploadError("UPLOAD_MISMATCH");
    }
    const pending = await readArtifactBody(input.bucket, pendingKey);
    if (
      pending === null ||
      pending.size !== input.byteLength ||
      pending.httpMetadata?.contentType !== "application/pdf" ||
      pending.customMetadata?.kind !== "pending-input" ||
      pending.customMetadata.uploadVersion !== String(input.uploadVersion) ||
      pending.customMetadata.ownershipMarker !== ownershipMarker
    ) {
      throw new ArtifactUploadError("UPLOAD_MISMATCH");
    }
    let canonicalPut: ArtifactHead | null;
    let responseLost = false;
    try {
      canonicalPut = await input.bucket.put(input.key, pending.body, {
        onlyIf: new Headers({ "if-none-match": "*" }),
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: {
          kind: "input",
          uploadVersion: String(input.uploadVersion),
          verifiedSha256: actualSha256,
        },
      });
    } catch {
      canonicalPut = null;
      responseLost = true;
    }
    const head = await readArtifactHead(input.bucket, input.key);
    const artifact = verifyInputArtifactHead(head, {
      key: input.key,
      byteLength: input.byteLength,
      mime: "application/pdf",
      uploadVersion: input.uploadVersion,
      expectedSha256: input.expectedSha256,
    });
    return {
      kind: canonicalPut === null || responseLost ? "existing-authoritative" : "stored",
      artifact,
    };
  } finally {
    clearTimeout(timeout);
    abortController.abort(new ArtifactUploadError("UPLOAD_MISMATCH"));
    await Promise.allSettled([producer, pendingPut]);
    await deletePendingIfOwned({
      bucket: input.bucket,
      key: pendingKey,
      uploadVersion: input.uploadVersion,
      ownershipMarker,
    });
  }
}

async function readArtifactHead(
  bucket: Pick<ArtifactBucket, "head">,
  key: string,
): Promise<ArtifactHead | null> {
  try {
    return await bucket.head(key);
  } catch {
    throw new ArtifactUploadError("STORAGE_FAILURE");
  }
}

function errorCodeForPipelineFailure(input: {
  deadlineExpired: boolean;
  putRejectedFirst: boolean;
}): ArtifactUploadErrorCode {
  if (input.deadlineExpired) return "UPLOAD_EXPIRED";
  if (input.putRejectedFirst) return "STORAGE_FAILURE";
  return "UPLOAD_MISMATCH";
}

/**
 * Streams a body only for a repository-authorized, uncommitted upload attempt.
 *
 * A route handling a repository replay with an already committed input ETag must return its
 * idempotent acknowledgement without calling this function or consuming the repeated request body.
 * R2 is create-only and first-writer-wins. PDFs are promoted from a unique pending object only
 * after the received stream digest is authoritative; image uploads retain the original direct path.
 */
export async function storeExactInputArtifact(input: {
  readonly bucket: ArtifactBucket;
  readonly source: ReadableStream<Uint8Array>;
  readonly key: string;
  readonly byteLength: number;
  readonly mime: string;
  readonly uploadVersion: number;
  readonly deadlineAt: number;
  readonly now?: () => number;
  readonly createFixedLengthStream?: (expectedLength: number) => FixedLengthStreamPair;
  readonly expectedSha256?: string;
  readonly createDigestStream?: () => Sha256DigestStream;
  readonly randomUuid?: () => string;
}): Promise<StoreExactInputArtifactResult> {
  const now = input.now ?? Date.now;
  if (
    !isCanonicalInputKey(input.key) ||
    !isArtifactMime(input.mime) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > maximumBytes(input.mime) ||
    !Number.isSafeInteger(input.deadlineAt) ||
    !Number.isSafeInteger(input.uploadVersion) ||
    input.uploadVersion < 1 ||
    (input.expectedSha256 !== undefined &&
      !/^sha-256=[A-Za-z0-9+/]{43}=$/.test(input.expectedSha256))
  ) {
    throw new ArtifactUploadError("INVALID_ARTIFACT_REQUEST");
  }

  const remainingMilliseconds = input.deadlineAt - now();
  if (remainingMilliseconds <= 0) {
    throw new ArtifactUploadError("UPLOAD_EXPIRED");
  }

  if (input.mime === "application/pdf") {
    if (input.expectedSha256 === undefined) {
      throw new ArtifactUploadError("INVALID_ARTIFACT_REQUEST");
    }
    return await storeVerifiedPdfArtifact({
      bucket: input.bucket,
      source: input.source,
      key: input.key,
      byteLength: input.byteLength,
      uploadVersion: input.uploadVersion,
      deadlineAt: input.deadlineAt,
      expectedSha256: input.expectedSha256,
      now,
      ...(input.createFixedLengthStream === undefined
        ? {}
        : { createFixedLengthStream: input.createFixedLengthStream }),
      ...(input.createDigestStream === undefined
        ? {}
        : { createDigestStream: input.createDigestStream }),
      randomUuid: input.randomUuid ?? crypto.randomUUID,
    });
  }

  const fixedLengthStream = (input.createFixedLengthStream ?? defaultFixedLengthStream)(
    input.byteLength,
  );
  const mime = input.mime;
  const abortController = new AbortController();
  let deadlineExpired = false;
  let putRejectedFirst = false;
  let conditionalPutLost = false;

  const timeout = setTimeout(() => {
    deadlineExpired = true;
    abortController.abort(new ArtifactUploadError("UPLOAD_EXPIRED"));
  }, remainingMilliseconds);

  const producerPromise = pipeToFixedLengthStream(
    input.source,
    fixedLengthStream.writable,
    abortController.signal,
  );
  const putPromise = Promise.resolve().then(() =>
    input.bucket.put(input.key, fixedLengthStream.readable, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: mime },
      customMetadata: {
        kind: "input",
        uploadVersion: String(input.uploadVersion),
      },
    }),
  );

  const producerObserved = producerPromise.then(
    () => ({ side: "producer" as const, status: "fulfilled" as const }),
    (reason: unknown) => ({ side: "producer" as const, status: "rejected" as const, reason }),
  );
  const putObserved = putPromise.then(
    (value) => ({ side: "put" as const, status: "fulfilled" as const, value }),
    (reason: unknown) => ({ side: "put" as const, status: "rejected" as const, reason }),
  );

  const first = await Promise.race([producerObserved, putObserved]);
  let readableCancellation: Promise<void> | null = null;
  if (first.status === "rejected") {
    putRejectedFirst = first.side === "put";
    const failure = new ArtifactUploadError(
      putRejectedFirst ? "STORAGE_FAILURE" : "UPLOAD_MISMATCH",
    );
    abortController.abort(failure);
    if (first.side === "put") {
      readableCancellation = fixedLengthStream.readable.cancel(failure).catch(() => undefined);
    }
  } else if (first.side === "put" && first.value === null) {
    conditionalPutLost = true;
    const failure = new ArtifactUploadError("UPLOAD_MISMATCH");
    abortController.abort(failure);
    readableCancellation = fixedLengthStream.readable.cancel(failure).catch(() => undefined);
  }

  const [producer, put] = await Promise.allSettled([producerPromise, putPromise]);
  if (readableCancellation !== null) {
    await readableCancellation;
  }
  clearTimeout(timeout);

  if (conditionalPutLost || (put.status === "fulfilled" && put.value === null)) {
    const head = await readArtifactHead(input.bucket, input.key);
    return {
      kind: "existing-authoritative",
      artifact: verifyInputArtifactHead(head, input),
    };
  }

  if (producer.status === "rejected") {
    throw new ArtifactUploadError(
      errorCodeForPipelineFailure({ deadlineExpired, putRejectedFirst }),
    );
  }

  if (put.status === "rejected") {
    const head = await readArtifactHead(input.bucket, input.key);
    try {
      return {
        kind: "existing-authoritative",
        artifact: verifyInputArtifactHead(head, input),
      };
    } catch {
      throw new ArtifactUploadError(
        errorCodeForPipelineFailure({ deadlineExpired, putRejectedFirst: true }),
      );
    }
  }

  const head = await readArtifactHead(input.bucket, input.key);
  return {
    kind: "stored",
    artifact: verifyInputArtifactHead(head, input),
  };
}

export async function deleteAuthorizedArtifact(
  bucket: Pick<ArtifactBucket, "delete">,
  authorization: ArtifactDeletionAuthorization,
): Promise<void> {
  if (
    authorization.kind !== "delete-unowned-object" ||
    !isCanonicalArtifactKey(authorization.key)
  ) {
    throw new TypeError("Artifact deletion requires repository authorization.");
  }
  try {
    await bucket.delete(authorization.key);
  } catch {
    throw new ArtifactUploadError("STORAGE_FAILURE");
  }
}
