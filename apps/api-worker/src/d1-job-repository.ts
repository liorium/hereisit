import { serverJobMessageSchema } from "@hereisit/server-contracts";
import {
  calculateSettledWeightedUnits,
  estimateResources,
  type ToolResourceEstimate,
} from "@hereisit/server-job";
import {
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
  type ImageOptimizeCreateRequestV1,
  imageOptimizeCreateRequestSchema,
  imageOptimizeMimeSchema,
  imageOptimizePhaseSchema,
  imageOptimizeSpecV1Schema,
  imageOptimizeWarningCodeSchema,
} from "@hereisit/tool-contracts/image-optimize";
import {
  PDF_OPTIMIZE_MAX_FILE_BYTES,
  PDF_OPTIMIZE_MAX_PAGES,
  type PdfOptimizeCreateRequestV1,
  pdfOptimizeCreateRequestSchema,
  pdfOptimizeMimeSchema,
  pdfOptimizeSpecV1Schema,
} from "@hereisit/tool-contracts/pdf-optimize";
import { toolJobErrorCodeSchema } from "@hereisit/tool-contracts/tool-job";
import { z } from "zod";
import { hashAnonymousSessionId, hashJobToken } from "./auth";
import { prepareAdmissionCounterAfterCreationMarker } from "./operational-counters";
import type {
  ClaimDownloadResult,
  LifecycleJob,
  LifecycleMutationResult,
  LifecycleRepository,
} from "./routes/results";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEY_PATTERN = new RegExp(`^inputs/${CANONICAL_UUID_PATTERN.source.slice(1, -1)}$`);
const OUTPUT_KEY_PATTERN = new RegExp(`^outputs/${CANONICAL_UUID_PATTERN.source.slice(1, -1)}$`);
const NETWORK_HASH_RETENTION_MS = 48 * 60 * 60_000;
const PROCESSING_DEADLINE_MS = 20 * 60_000;
const TERMINAL_RECORD_RETENTION_MS = 24 * 60 * 60_000;
const MAXIMUM_ALIAS_HASHES = 16;
const PRE_ENGINE_SETTLED_UNITS = calculateSettledWeightedUnits([]);

const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = nonnegativeSafeIntegerSchema.min(1);
const canonicalUuidSchema = z.string().regex(CANONICAL_UUID_PATTERN);
const hashSchema = z.string().regex(HASH_PATTERN);
const dayKeySchema = z.string().regex(DAY_KEY_PATTERN);
const storedObjectEtagSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x20-\x7e]+$/)
  .refine((etag) => !(etag.startsWith('"') && etag.endsWith('"')), {
    message: "HTTP-quoted ETags are not raw object versions.",
  });
const objectEtagSchema = storedObjectEtagSchema.nullable();
const jobStateSchema = z.enum([
  "created",
  "uploading",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

const persistedReservationCommonShape = {
  id: canonicalUuidSchema,
  client_request_id: canonicalUuidSchema,
  token_hash: hashSchema,
  session_hash: hashSchema,
  network_hash: hashSchema,
  day_key: dayKeySchema,
  status: jobStateSchema,
  phase: z.enum([
    "uploading",
    "queued",
    "validating",
    "inspecting",
    "normalizing",
    "optimizing",
    "verifying",
    "preparing-output",
    "completed",
  ]),
  spec_json: z.string().min(1).max(16_384),
  spec_hash: hashSchema,
  input_key: z.string().regex(INPUT_KEY_PATTERN),
  input_etag: objectEtagSchema,
  upload_version: nonnegativeSafeIntegerSchema,
  output_key: z.string().regex(OUTPUT_KEY_PATTERN),
  reserved_units: positiveSafeIntegerSchema,
  settlement_state: z.enum(["reserved", "settled"]),
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  queue_epoch: canonicalUuidSchema,
  queue_generation: nonnegativeSafeIntegerSchema,
  cancel_requested_at: nonnegativeSafeIntegerSchema.nullable(),
  upload_expires_at: nonnegativeSafeIntegerSchema,
  created_at: nonnegativeSafeIntegerSchema,
  updated_at: nonnegativeSafeIntegerSchema,
} as const;

const persistedImageReservationRowSchema = z
  .object({
    ...persistedReservationCommonShape,
    contract_id: z.literal("image.optimize@1"),
    declared_bytes: positiveSafeIntegerSchema.max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
    declared_mime: imageOptimizeMimeSchema,
    declared_width: positiveSafeIntegerSchema,
    declared_height: positiveSafeIntegerSchema,
    declared_page_count: z.null(),
    resource_class: z.enum(["image-standard-v1", "image-large-v1"]),
  })
  .strict();

const persistedPdfReservationRowSchema = z
  .object({
    ...persistedReservationCommonShape,
    contract_id: z.literal("pdf.optimize@1"),
    declared_bytes: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
    declared_mime: pdfOptimizeMimeSchema,
    declared_width: z.null(),
    declared_height: z.null(),
    declared_page_count: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_PAGES),
    resource_class: z.literal("pdf-standard-v1"),
  })
  .strict();

const persistedReservationRowSchema = z.discriminatedUnion("contract_id", [
  persistedImageReservationRowSchema,
  persistedPdfReservationRowSchema,
]);

const admissionAggregateRowSchema = z
  .object({
    circuit_open: z.union([z.literal(0), z.literal(1)]).nullable(),
    account_reserved: nonnegativeSafeIntegerSchema,
    account_settled: nonnegativeSafeIntegerSchema,
    account_pending: nonnegativeSafeIntegerSchema,
    anonymous_reserved: nonnegativeSafeIntegerSchema,
    anonymous_settled: nonnegativeSafeIntegerSchema,
    anonymous_active: nonnegativeSafeIntegerSchema,
    network_reserved: nonnegativeSafeIntegerSchema,
    network_settled: nonnegativeSafeIntegerSchema,
    network_pending: nonnegativeSafeIntegerSchema,
    oldest_queued_at: nonnegativeSafeIntegerSchema.nullable(),
    queued_null_count: nonnegativeSafeIntegerSchema,
    queued_future_count: nonnegativeSafeIntegerSchema,
    proposed_job_id_count: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();

export type PersistedReservationRow = z.infer<typeof persistedReservationRowSchema>;

const tokenHashRowSchema = z.object({ token_hash: hashSchema }).strict();
const uploadRowSchema = z.discriminatedUnion("contract_id", [
  z
    .object({
      id: canonicalUuidSchema,
      status: jobStateSchema,
      contract_id: z.literal("image.optimize@1"),
      declared_bytes: positiveSafeIntegerSchema.max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
      declared_mime: imageOptimizeMimeSchema,
      input_key: z.string().regex(INPUT_KEY_PATTERN),
      input_etag: objectEtagSchema,
      upload_version: nonnegativeSafeIntegerSchema,
      cancel_requested_at: nonnegativeSafeIntegerSchema.nullable(),
      upload_expires_at: nonnegativeSafeIntegerSchema,
    })
    .strict(),
  z
    .object({
      id: canonicalUuidSchema,
      status: jobStateSchema,
      contract_id: z.literal("pdf.optimize@1"),
      declared_bytes: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
      declared_mime: pdfOptimizeMimeSchema,
      input_key: z.string().regex(INPUT_KEY_PATTERN),
      input_etag: objectEtagSchema,
      upload_version: nonnegativeSafeIntegerSchema,
      cancel_requested_at: nonnegativeSafeIntegerSchema.nullable(),
      upload_expires_at: nonnegativeSafeIntegerSchema,
    })
    .strict(),
]);
const commitSnapshotCommonShape = {
  id: canonicalUuidSchema,
  status: jobStateSchema,
  input_key: z.string().regex(INPUT_KEY_PATTERN),
  input_etag: objectEtagSchema,
  upload_version: nonnegativeSafeIntegerSchema,
  cancel_requested_at: nonnegativeSafeIntegerSchema.nullable(),
  upload_expires_at: nonnegativeSafeIntegerSchema,
  spec_hash: hashSchema,
  output_key: z.string().regex(OUTPUT_KEY_PATTERN),
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  queue_epoch: canonicalUuidSchema,
  queue_generation: nonnegativeSafeIntegerSchema,
  outbox_payload: z.string().min(1).max(8_192).nullable(),
} as const;
const commitSnapshotRowSchema = z.discriminatedUnion("contract_id", [
  z
    .object({
      ...commitSnapshotCommonShape,
      contract_id: z.literal("image.optimize@1"),
      declared_bytes: positiveSafeIntegerSchema.max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
      declared_mime: imageOptimizeMimeSchema,
      resource_class: z.enum(["image-standard-v1", "image-large-v1"]),
    })
    .strict(),
  z
    .object({
      ...commitSnapshotCommonShape,
      contract_id: z.literal("pdf.optimize@1"),
      declared_bytes: positiveSafeIntegerSchema.max(PDF_OPTIMIZE_MAX_FILE_BYTES),
      declared_mime: pdfOptimizeMimeSchema,
      resource_class: z.literal("pdf-standard-v1"),
    })
    .strict(),
]);
const settlementSnapshotRowSchema = z
  .object({
    id: canonicalUuidSchema.nullable(),
    input_key: z.string().regex(INPUT_KEY_PATTERN).nullable(),
    input_etag: objectEtagSchema,
    upload_version: nonnegativeSafeIntegerSchema.nullable(),
    status: jobStateSchema.nullable(),
    settlement_state: z.enum(["reserved", "settled"]).nullable(),
    key_owner_count: nonnegativeSafeIntegerSchema,
  })
  .strict();
const circuitRowSchema = z
  .object({
    circuit_open: z.union([z.literal(0), z.literal(1)]),
    reason: z.string().nullable(),
    opened_at: nonnegativeSafeIntegerSchema.nullable(),
  })
  .strict();

export class RepositoryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryIntegrityError";
  }
}

interface ReservationJobCommon {
  jobId: string;
  status:
    | "created"
    | "uploading"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";
  specHash: string;
  declaredBytes: number;
  inputKey: string;
  inputEtag: string | null;
  uploadVersion: number;
  outputKey: string;
  reservedWeightedUnits: number;
  attempt: 1 | 2 | 3;
  queueEpoch: string;
  queueGeneration: number;
  cancelRequestedAt: number | null;
  uploadExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReservationJob extends ReservationJobCommon {
  contractId: "image.optimize@1";
  declaredMime: "image/jpeg" | "image/png" | "image/webp";
  declaredWidth: number;
  declaredHeight: number;
  resourceClass: "image-standard-v1" | "image-large-v1";
}

export interface PdfReservationJob extends ReservationJobCommon {
  contractId: "pdf.optimize@1";
  declaredMime: "application/pdf";
  declaredWidth: null;
  declaredHeight: null;
  declaredPageCount: number;
  resourceClass: "pdf-standard-v1";
}

type StoredReservationJob = ReservationJob | PdfReservationJob;
type ServerCreateRequest = ImageOptimizeCreateRequestV1 | PdfOptimizeCreateRequestV1;

interface ReserveAndCreateCommonInput {
  jobId: string;
  clientRequestId: string;
  tokenHash: string;
  sessionHash: string;
  networkHash: string;
  networkDailyQuotaHashes: readonly string[];
  networkPendingHashes: readonly string[];
  dayKey: string;
  specJson: string;
  specHash: string;
  inputKey: string;
  outputKey: string;
  queueEpoch: string;
  uploadExpiresAt: number;
  now: number;
  accountDailyLimit: number;
  anonymousDailyLimit: number;
  networkDailyLimit: number;
  accountPendingJobLimit: number;
  networkPendingJobLimit: number;
  maximumQueuedAgeSeconds: number;
}

export interface ReserveAndCreateInput extends ReserveAndCreateCommonInput {
  request: ImageOptimizeCreateRequestV1;
  estimate: Extract<ToolResourceEstimate, { resourceClass: "image-standard-v1" }>;
}

export interface PdfReserveAndCreateInput extends ReserveAndCreateCommonInput {
  request: PdfOptimizeCreateRequestV1;
  estimate: Extract<ToolResourceEstimate, { resourceClass: "pdf-standard-v1" }>;
}

export type AnyReserveAndCreateInput = ReserveAndCreateInput | PdfReserveAndCreateInput;

export type ReserveAndCreateResult =
  | {
      kind: "created";
      mode: "upload-required";
      job: ReservationJob;
    }
  | {
      kind: "replayed";
      mode: "upload-required" | "existing-job";
      job: ReservationJob;
    }
  | {
      kind: "idempotency-conflict";
      existingJobId: string;
    }
  | { kind: "job-id-collision" }
  | {
      kind: "quota-exceeded";
      scope: "account" | "anonymous" | "network";
    }
  | { kind: "active-job-exists" }
  | {
      kind: "pending-limit-exceeded";
      scope: "account" | "network";
    }
  | {
      kind: "queue-unavailable";
      reason: "too-old" | "invalid-timestamp";
    }
  | {
      kind: "server-processing-disabled";
      reason: "limit-zero" | "circuit-open";
    };

export type PdfReserveAndCreateResult =
  | {
      kind: "created";
      mode: "upload-required";
      job: PdfReservationJob;
    }
  | {
      kind: "replayed";
      mode: "upload-required" | "existing-job";
      job: PdfReservationJob;
    }
  | Exclude<ReserveAndCreateResult, { kind: "created" | "replayed" }>;

type AnyReserveAndCreateResult = ReserveAndCreateResult | PdfReserveAndCreateResult;

export type PersistedJobState = z.infer<typeof jobStateSchema>;

type DeclaredMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
type BeginUploadResultForMime<Mime extends DeclaredMime> =
  | {
      kind: "ready";
      jobId: string;
      declaredBytes: number;
      declaredMime: Mime;
      inputKey: string;
      uploadVersion: number;
      uploadExpiresAt: number;
    }
  | {
      kind: "already-committed";
      state: Exclude<PersistedJobState, "created" | "uploading">;
      inputEtag: string;
      declaredBytes: number;
      declaredMime: Mime;
    }
  | {
      kind: "rejected";
      reason: "not-found" | "cancelled" | "expired" | "invalid-state";
      deleteAuthorization?: DeleteUnownedInputAuthorization;
    };

export type BeginUploadResult = BeginUploadResultForMime<"image/jpeg" | "image/png" | "image/webp">;
type AnyBeginUploadResult = BeginUploadResultForMime<DeclaredMime>;

export type CommitStoredInputResult =
  | { kind: "queued" }
  | {
      kind: "already-queued-same-etag";
      state: Exclude<PersistedJobState, "created" | "uploading">;
    }
  | {
      kind: "delete-unowned-object";
      reason: "cancelled" | "expired" | "upload-version-changed" | "no-owner";
    }
  | { kind: "conflicting-owned-etag" };

export interface DeleteUnownedInputAuthorization {
  kind: "delete-unowned-object";
  key: string;
}

export type PreEngineFailureInput =
  | {
      jobId: string;
      inputKey: string;
      uploadVersion: number;
      now: number;
      outcome: "failed";
      errorCode: "UPLOAD_MISMATCH" | "STORAGE_FAILURE";
    }
  | {
      jobId: string;
      inputKey: string;
      uploadVersion: number;
      now: number;
      outcome: "cancelled";
      errorCode: "CANCELLED";
    }
  | {
      jobId: string;
      inputKey: string;
      uploadVersion: number;
      now: number;
      outcome: "expired";
      errorCode: "UPLOAD_EXPIRED" | "EXPIRED";
    };

export type SettlePreEngineFailureResult =
  | {
      kind: "settled";
      state: "failed" | "cancelled" | "expired";
      deleteAuthorization?: DeleteUnownedInputAuthorization;
    }
  | {
      kind: "already-settled";
      state: PersistedJobState;
      deleteAuthorization?: DeleteUnownedInputAuthorization;
    }
  | {
      kind: "upload-version-changed";
      deleteAuthorization?: DeleteUnownedInputAuthorization;
    }
  | {
      kind: "no-owner";
      deleteAuthorization?: DeleteUnownedInputAuthorization;
    };

export interface JobRepository {
  reserveAndCreate(input: ReserveAndCreateInput): Promise<ReserveAndCreateResult>;
  loadExpectedTokenHash(jobId: string): Promise<string | null>;
  beginUpload(input: { jobId: string; now: number }): Promise<BeginUploadResult>;
  commitStoredInput(input: {
    jobId: string;
    uploadVersion: number;
    inputEtag: string;
    now: number;
  }): Promise<CommitStoredInputResult>;
  settlePreEngineFailure(input: PreEngineFailureInput): Promise<SettlePreEngineFailureResult>;
  openInvariantCircuit(input: { now: number; reason: "INPUT_ETAG_CONFLICT" }): Promise<void>;
}

export interface PdfJobRepository {
  reserveAndCreate(input: PdfReserveAndCreateInput): Promise<PdfReserveAndCreateResult>;
}

export type AnyJobRepository = JobRepository & PdfJobRepository;

interface ValidatedReservationInput extends ReserveAndCreateCommonInput {
  request: ServerCreateRequest;
  estimate: ToolResourceEstimate;
  networkDailyQuotaHashes: readonly string[];
  networkPendingHashes: readonly string[];
}

const reservationColumns = `
  id,
  client_request_id,
  token_hash,
  session_hash,
  network_hash,
  day_key,
  status,
  phase,
  contract_id,
  spec_json,
  spec_hash,
  declared_bytes,
  declared_mime,
  declared_width,
  declared_height,
  declared_page_count,
  input_key,
  input_etag,
  upload_version,
  output_key,
  reserved_units,
  resource_class,
  settlement_state,
  attempt,
  queue_epoch,
  queue_generation,
  cancel_requested_at,
  upload_expires_at,
  created_at,
  updated_at
`;

function checkedNonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function checkedPositiveSafeInteger(value: number, label: string): number {
  checkedNonnegativeSafeInteger(value, label);
  if (value === 0) {
    throw new RangeError(`${label} must be positive.`);
  }
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new RangeError(`${label} must remain within the maximum safe integer.`);
  }
  return left + right;
}

function checkedMultiply(left: number, right: number, label: string): number {
  if (left !== 0 && right > Number.MAX_SAFE_INTEGER / left) {
    throw new RangeError(`${label} must remain within the maximum safe integer.`);
  }
  return left * right;
}

function isCurrentUtcDay(day: string, timestamp: number): boolean {
  return new Date(timestamp).toISOString().slice(0, 10) === day;
}

function validateCanonicalUuid(value: string, label: string): string {
  if (!CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase canonical UUID.`);
  }
  return value;
}

function validateHash(value: string, label: string): string {
  if (!HASH_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash.`);
  }
  return value;
}

function validateObjectKey(value: string, kind: "input" | "output"): string {
  const pattern = kind === "input" ? INPUT_KEY_PATTERN : OUTPUT_KEY_PATTERN;
  if (!pattern.test(value)) {
    throw new TypeError(`${kind}Key must be a canonical opaque UUID object key.`);
  }
  return value;
}

function normalizeHashes(
  values: readonly string[],
  requiredHash: string,
  label: string,
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array.`);
  }
  const normalized = new Set<string>([requiredHash]);
  for (const value of values) {
    normalized.add(validateHash(value, `${label} entry`));
  }
  if (normalized.size > MAXIMUM_ALIAS_HASHES) {
    throw new RangeError(`${label} may contain at most ${MAXIMUM_ALIAS_HASHES} unique hashes.`);
  }
  return Object.freeze([...normalized]);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateReservationInput(
  input: AnyReserveAndCreateInput,
): Promise<ValidatedReservationInput> {
  const parsedRequest =
    input.request?.toolContract === "pdf.optimize@1"
      ? pdfOptimizeCreateRequestSchema.parse(input.request)
      : imageOptimizeCreateRequestSchema.parse(input.request);
  validateCanonicalUuid(input.jobId, "jobId");
  validateCanonicalUuid(input.clientRequestId, "clientRequestId");
  validateCanonicalUuid(input.queueEpoch, "queueEpoch");
  validateHash(input.tokenHash, "tokenHash");
  validateHash(input.sessionHash, "sessionHash");
  validateHash(input.networkHash, "networkHash");
  validateHash(input.specHash, "specHash");
  validateObjectKey(input.inputKey, "input");
  validateObjectKey(input.outputKey, "output");

  if (parsedRequest.clientRequestId !== input.clientRequestId) {
    throw new TypeError("clientRequestId must match the parsed request.");
  }
  const canonicalSpec =
    parsedRequest.toolContract === "pdf.optimize@1"
      ? pdfOptimizeSpecV1Schema.parse(parsedRequest.spec)
      : imageOptimizeSpecV1Schema.parse(parsedRequest.spec);
  const canonicalSpecJson = JSON.stringify(canonicalSpec);
  if (input.specJson !== canonicalSpecJson) {
    throw new TypeError("specJson must be the canonical spec serialization.");
  }
  const [actualSpecHash, actualSessionHash] = await Promise.all([
    sha256Hex(canonicalSpecJson),
    hashAnonymousSessionId(parsedRequest.anonymousSessionId),
  ]);
  if (input.specHash !== actualSpecHash) {
    throw new TypeError("specHash does not match the canonical spec hash.");
  }
  if (
    parsedRequest.toolContract === "image.optimize@1" &&
    input.tokenHash !== (await hashJobToken(parsedRequest.jobToken))
  ) {
    throw new TypeError("tokenHash does not match the parsed image request token.");
  }
  if (input.sessionHash !== actualSessionHash) {
    throw new TypeError("sessionHash does not match the parsed anonymous session.");
  }

  checkedNonnegativeSafeInteger(input.now, "now");
  checkedNonnegativeSafeInteger(input.uploadExpiresAt, "uploadExpiresAt");
  if (input.uploadExpiresAt <= input.now) {
    throw new RangeError("uploadExpiresAt must be in the future.");
  }
  if (!DAY_KEY_PATTERN.test(input.dayKey) || !isCurrentUtcDay(input.dayKey, input.now)) {
    throw new TypeError("dayKey must equal the current UTC day.");
  }
  checkedNonnegativeSafeInteger(input.accountDailyLimit, "accountDailyLimit");
  checkedNonnegativeSafeInteger(input.anonymousDailyLimit, "anonymousDailyLimit");
  checkedNonnegativeSafeInteger(input.networkDailyLimit, "networkDailyLimit");
  checkedNonnegativeSafeInteger(input.accountPendingJobLimit, "accountPendingJobLimit");
  checkedNonnegativeSafeInteger(input.networkPendingJobLimit, "networkPendingJobLimit");
  checkedNonnegativeSafeInteger(input.maximumQueuedAgeSeconds, "maximumQueuedAgeSeconds");
  checkedMultiply(input.maximumQueuedAgeSeconds, 1_000, "maximum queued age milliseconds");

  checkedPositiveSafeInteger(input.estimate.reservedWeightedUnits, "reservedWeightedUnits");
  const expectedEstimate = estimateResources(parsedRequest);
  const estimateMatches =
    input.estimate.resourceClass === expectedEstimate.resourceClass &&
    input.estimate.reservedWeightedUnits === expectedEstimate.reservedWeightedUnits &&
    input.estimate.inputBytes === expectedEstimate.inputBytes &&
    (expectedEstimate.resourceClass === "pdf-standard-v1"
      ? input.estimate.resourceClass === "pdf-standard-v1" &&
        input.estimate.reservationPageCeiling === expectedEstimate.reservationPageCeiling
      : input.estimate.resourceClass === "image-standard-v1" &&
        input.estimate.reservationPixelCeiling === expectedEstimate.reservationPixelCeiling);
  if (!estimateMatches) {
    throw new TypeError("estimate must match the parsed optimization request.");
  }

  return {
    ...input,
    request: parsedRequest,
    networkDailyQuotaHashes: normalizeHashes(
      input.networkDailyQuotaHashes,
      input.networkHash,
      "networkDailyQuotaHashes",
    ),
    networkPendingHashes: normalizeHashes(
      input.networkPendingHashes,
      input.networkHash,
      "networkPendingHashes",
    ),
  };
}

function declaredMime(request: ServerCreateRequest) {
  return request.toolContract === "pdf.optimize@1" ? request.input.mime : request.input.mimeHint;
}

function declaredWidth(request: ServerCreateRequest): number | null {
  return request.toolContract === "image.optimize@1" ? request.input.width : null;
}

function declaredHeight(request: ServerCreateRequest): number | null {
  return request.toolContract === "image.optimize@1" ? request.input.height : null;
}

function declaredPageCount(request: ServerCreateRequest): number | null {
  return request.toolContract === "pdf.optimize@1" ? request.input.pageCount : null;
}

function candidateValues(input: ValidatedReservationInput): readonly unknown[] {
  return [
    input.jobId,
    input.clientRequestId,
    input.tokenHash,
    input.sessionHash,
    input.networkHash,
    input.dayKey,
    input.request.toolContract,
    input.specJson,
    input.specHash,
    input.request.input.byteLength,
    declaredMime(input.request),
    declaredWidth(input.request),
    declaredHeight(input.request),
    declaredPageCount(input.request),
    input.inputKey,
    input.outputKey,
    input.estimate.reservedWeightedUnits,
    input.estimate.resourceClass,
    input.queueEpoch,
    input.uploadExpiresAt,
    input.now,
    input.now,
  ];
}

const fullCandidatePredicate = `
  id = ?
  AND client_request_id = ?
  AND token_hash = ?
  AND session_hash = ?
  AND network_hash = ?
  AND day_key = ?
  AND status = 'created'
  AND phase = 'uploading'
  AND contract_id = ?
  AND spec_json = ?
  AND spec_hash = ?
  AND declared_bytes = ?
  AND declared_mime = ?
  AND declared_width IS ?
  AND declared_height IS ?
  AND declared_page_count IS ?
  AND input_key = ?
  AND input_etag IS NULL
  AND upload_version = 0
  AND output_key = ?
  AND reserved_units = ?
  AND resource_class = ?
  AND settlement_state = 'reserved'
  AND attempt = 1
  AND queue_epoch = ?
  AND queue_generation = 1
  AND cancel_requested_at IS NULL
  AND upload_expires_at = ?
  AND created_at = ?
  AND updated_at = ?
`;

function candidateMarker(input: ValidatedReservationInput): readonly unknown[] {
  return [...candidateValues(input), input.jobId];
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function prepareAdmissionStateStatement(
  session: D1DatabaseSession,
  input: ValidatedReservationInput,
): D1PreparedStatement {
  const dailyAliases = placeholders(input.networkDailyQuotaHashes.length);
  const pendingAliases = placeholders(input.networkPendingHashes.length);
  return session
    .prepare(
      `SELECT
        (SELECT circuit_open FROM rollout_control WHERE id = 1) AS circuit_open,
        COALESCE((
          SELECT reserved_units FROM account_usage WHERE day_key = ?
        ), 0) AS account_reserved,
        COALESCE((
          SELECT settled_units FROM account_usage WHERE day_key = ?
        ), 0) AS account_settled,
        COALESCE((
          SELECT SUM(pending_jobs) FROM account_usage
        ), 0) AS account_pending,
        COALESCE((
          SELECT reserved_units
          FROM anonymous_usage
          WHERE session_hash = ? AND day_key = ?
        ), 0) AS anonymous_reserved,
        COALESCE((
          SELECT settled_units
          FROM anonymous_usage
          WHERE session_hash = ? AND day_key = ?
        ), 0) AS anonymous_settled,
        COALESCE((
          SELECT SUM(active_jobs)
          FROM anonymous_usage
          WHERE session_hash = ?
        ), 0) AS anonymous_active,
        COALESCE((
          SELECT SUM(reserved_units)
          FROM network_usage
          WHERE day_key = ? AND network_hash IN (${dailyAliases})
        ), 0) AS network_reserved,
        COALESCE((
          SELECT SUM(settled_units)
          FROM network_usage
          WHERE day_key = ? AND network_hash IN (${dailyAliases})
        ), 0) AS network_settled,
        COALESCE((
          SELECT SUM(pending_jobs)
          FROM network_usage
          WHERE network_hash IN (${pendingAliases})
        ), 0) AS network_pending,
        (
          SELECT MIN(queued_at)
          FROM jobs
          WHERE status = 'queued' AND queued_at IS NOT NULL
        ) AS oldest_queued_at,
        (
          SELECT COUNT(*)
          FROM jobs
          WHERE status = 'queued' AND queued_at IS NULL
        ) AS queued_null_count,
        (
          SELECT COUNT(*)
          FROM jobs
          WHERE status = 'queued' AND queued_at > ?
        ) AS queued_future_count,
        (
          SELECT COUNT(*)
          FROM jobs
          WHERE id = ?
        ) AS proposed_job_id_count`,
    )
    .bind(
      input.dayKey,
      input.dayKey,
      input.sessionHash,
      input.dayKey,
      input.sessionHash,
      input.dayKey,
      input.sessionHash,
      input.dayKey,
      ...input.networkDailyQuotaHashes,
      input.dayKey,
      ...input.networkDailyQuotaHashes,
      ...input.networkPendingHashes,
      input.now,
      input.jobId,
    );
}

function prepareReservationBatch(
  session: D1DatabaseSession,
  input: ValidatedReservationInput,
): D1PreparedStatement[] {
  const networkRetentionDeadline = checkedAdd(
    input.now,
    NETWORK_HASH_RETENTION_MS,
    "network hash retention deadline",
  );
  const maximumQueueAgeMilliseconds = checkedMultiply(
    input.maximumQueuedAgeSeconds,
    1_000,
    "maximum queued age milliseconds",
  );
  const oldestAllowedQueuedAt = input.now - maximumQueueAgeMilliseconds;
  const dailyAliases = placeholders(input.networkDailyQuotaHashes.length);
  const pendingAliases = placeholders(input.networkPendingHashes.length);
  const candidate = candidateMarker(input);

  const insertAccount = session
    .prepare(
      `INSERT INTO account_usage
        (day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at)
       VALUES (?, 0, 0, 0, ?, ?)
       ON CONFLICT(day_key) DO NOTHING`,
    )
    .bind(input.dayKey, input.now, input.now);

  const insertAnonymous = session
    .prepare(
      `INSERT INTO anonymous_usage
        (session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)
       ON CONFLICT(session_hash, day_key) DO NOTHING`,
    )
    .bind(input.sessionHash, input.dayKey, input.now, input.now);

  const insertNetwork = session
    .prepare(
      `INSERT INTO network_usage
        (network_hash, day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)
       ON CONFLICT(network_hash, day_key) DO NOTHING`,
    )
    .bind(input.networkHash, input.dayKey, input.now, input.now);

  const insertJob = session
    .prepare(
      `INSERT INTO jobs (
        id,
        client_request_id,
        token_hash,
        session_hash,
        network_hash,
        network_hash_expires_at,
        day_key,
        status,
        phase,
        contract_id,
        spec_json,
        spec_hash,
        declared_bytes,
        declared_mime,
        declared_width,
        declared_height,
        declared_page_count,
        input_key,
        output_key,
        reserved_units,
        resource_class,
        queue_epoch,
        upload_expires_at,
        created_at,
        updated_at
      )
      SELECT
        ?, ?, ?, ?, ?, ?, ?, 'created', 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM rollout_control AS control
      WHERE control.id = 1
        AND control.circuit_open = 0
        AND ? > 0
        AND ? > 0
        AND ? > 0
        AND COALESCE((
          SELECT reserved_units + settled_units
          FROM account_usage
          WHERE day_key = ?
        ), 0) + ? <= ?
        AND COALESCE((
          SELECT reserved_units + settled_units
          FROM anonymous_usage
          WHERE session_hash = ? AND day_key = ?
        ), 0) + ? <= ?
        AND COALESCE((
          SELECT SUM(reserved_units + settled_units)
          FROM network_usage
          WHERE day_key = ? AND network_hash IN (${dailyAliases})
        ), 0) + ? <= ?
        AND COALESCE((
          SELECT SUM(active_jobs)
          FROM anonymous_usage
          WHERE session_hash = ?
        ), 0) = 0
        AND COALESCE((
          SELECT SUM(pending_jobs)
          FROM account_usage
        ), 0) < ?
        AND COALESCE((
          SELECT SUM(pending_jobs)
          FROM network_usage
          WHERE network_hash IN (${pendingAliases})
        ), 0) < ?
        AND NOT EXISTS (
          SELECT 1
          FROM jobs
          WHERE status = 'queued'
            AND (
              queued_at IS NULL
              OR queued_at > ?
              OR queued_at < ?
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jobs
          WHERE session_hash = ? AND client_request_id = ?
        )
      ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      input.jobId,
      input.clientRequestId,
      input.tokenHash,
      input.sessionHash,
      input.networkHash,
      networkRetentionDeadline,
      input.dayKey,
      input.request.toolContract,
      input.specJson,
      input.specHash,
      input.request.input.byteLength,
      declaredMime(input.request),
      declaredWidth(input.request),
      declaredHeight(input.request),
      declaredPageCount(input.request),
      input.inputKey,
      input.outputKey,
      input.estimate.reservedWeightedUnits,
      input.estimate.resourceClass,
      input.queueEpoch,
      input.uploadExpiresAt,
      input.now,
      input.now,
      input.accountDailyLimit,
      input.anonymousDailyLimit,
      input.networkDailyLimit,
      input.dayKey,
      input.estimate.reservedWeightedUnits,
      input.accountDailyLimit,
      input.sessionHash,
      input.dayKey,
      input.estimate.reservedWeightedUnits,
      input.anonymousDailyLimit,
      input.dayKey,
      ...input.networkDailyQuotaHashes,
      input.estimate.reservedWeightedUnits,
      input.networkDailyLimit,
      input.sessionHash,
      input.accountPendingJobLimit,
      ...input.networkPendingHashes,
      input.networkPendingJobLimit,
      input.now,
      oldestAllowedQueuedAt,
      input.sessionHash,
      input.clientRequestId,
    );

  const recordAdmission = prepareAdmissionCounterAfterCreationMarker(session, input.now);
  const recordFirstAdmission = session
    .prepare(
      `UPDATE rollout_control
       SET first_admitted_at = COALESCE(first_admitted_at, ?)
       WHERE id = 1 AND changes() = 1`,
    )
    .bind(input.now);

  const updateAccount = session
    .prepare(
      `UPDATE account_usage
       SET reserved_units = reserved_units + ?,
           pending_jobs = pending_jobs + 1,
           updated_at = ?
       WHERE day_key = ?
         AND EXISTS (
           SELECT 1 FROM jobs WHERE ${fullCandidatePredicate}
         )
         AND NOT EXISTS (
           SELECT 1 FROM usage_ledger WHERE job_id = ?
         )`,
    )
    .bind(input.estimate.reservedWeightedUnits, input.now, input.dayKey, ...candidate);

  const updateAnonymous = session
    .prepare(
      `UPDATE anonymous_usage
       SET reserved_units = reserved_units + ?,
           active_jobs = active_jobs + 1,
           updated_at = ?
       WHERE session_hash = ? AND day_key = ?
         AND EXISTS (
           SELECT 1 FROM jobs WHERE ${fullCandidatePredicate}
         )
         AND NOT EXISTS (
           SELECT 1 FROM usage_ledger WHERE job_id = ?
         )`,
    )
    .bind(
      input.estimate.reservedWeightedUnits,
      input.now,
      input.sessionHash,
      input.dayKey,
      ...candidate,
    );

  const updateNetwork = session
    .prepare(
      `UPDATE network_usage
       SET reserved_units = reserved_units + ?,
           pending_jobs = pending_jobs + 1,
           updated_at = ?
       WHERE network_hash = ? AND day_key = ?
         AND EXISTS (
           SELECT 1 FROM jobs WHERE ${fullCandidatePredicate}
         )
         AND NOT EXISTS (
           SELECT 1 FROM usage_ledger WHERE job_id = ?
         )`,
    )
    .bind(
      input.estimate.reservedWeightedUnits,
      input.now,
      input.networkHash,
      input.dayKey,
      ...candidate,
    );

  const insertLedger = session
    .prepare(
      `INSERT INTO usage_ledger (
        job_id,
        session_hash,
        network_hash,
        day_key,
        reserved_units,
        created_at
      )
      SELECT
        id,
        session_hash,
        network_hash,
        day_key,
        reserved_units,
        ?
      FROM jobs
      WHERE ${fullCandidatePredicate}
        AND NOT EXISTS (
          SELECT 1 FROM usage_ledger WHERE job_id = ?
        )`,
    )
    .bind(input.now, ...candidateValues(input), input.jobId);

  return [
    insertAccount,
    insertAnonymous,
    insertNetwork,
    insertJob,
    recordFirstAdmission,
    recordAdmission,
    updateAccount,
    updateAnonymous,
    updateNetwork,
    insertLedger,
    prepareAdmissionStateStatement(session, input),
  ];
}

function toReservationJob(row: PersistedReservationRow): StoredReservationJob {
  const common = {
    jobId: row.id,
    status: row.status,
    specHash: row.spec_hash,
    declaredBytes: row.declared_bytes,
    inputKey: row.input_key,
    inputEtag: row.input_etag,
    uploadVersion: row.upload_version,
    outputKey: row.output_key,
    reservedWeightedUnits: row.reserved_units,
    attempt: row.attempt,
    queueEpoch: row.queue_epoch,
    queueGeneration: row.queue_generation,
    cancelRequestedAt: row.cancel_requested_at,
    uploadExpiresAt: row.upload_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return row.contract_id === "pdf.optimize@1"
    ? {
        ...common,
        contractId: row.contract_id,
        declaredMime: row.declared_mime,
        declaredWidth: row.declared_width,
        declaredHeight: row.declared_height,
        declaredPageCount: row.declared_page_count,
        resourceClass: row.resource_class,
      }
    : {
        ...common,
        contractId: row.contract_id,
        declaredMime: row.declared_mime,
        declaredWidth: row.declared_width,
        declaredHeight: row.declared_height,
        resourceClass: row.resource_class,
      };
}

export function parseStoredJob(row: unknown): PersistedReservationRow {
  try {
    const parsed = persistedReservationRowSchema.parse(row);
    if (
      parsed.contract_id === "image.optimize@1" &&
      parsed.declared_width > Math.floor(IMAGE_OPTIMIZE_MAX_PIXELS / parsed.declared_height)
    ) {
      throw new RepositoryIntegrityError("Stored job dimensions exceed the image pixel limit.");
    }
    return parsed;
  } catch {
    throw new RepositoryIntegrityError("Stored job row does not match the repository contract.");
  }
}

async function parsePersistedReservationRow(row: unknown): Promise<PersistedReservationRow> {
  const parsed = parseStoredJob(row);

  let spec: unknown;
  try {
    spec = JSON.parse(parsed.spec_json);
  } catch {
    throw new RepositoryIntegrityError("Stored job spec is not valid JSON.");
  }
  const parsedSpec =
    parsed.contract_id === "pdf.optimize@1"
      ? pdfOptimizeSpecV1Schema.safeParse(spec)
      : imageOptimizeSpecV1Schema.safeParse(spec);
  if (!parsedSpec.success || JSON.stringify(parsedSpec.data) !== parsed.spec_json) {
    throw new RepositoryIntegrityError("Stored job spec is not canonical.");
  }
  if ((await sha256Hex(parsed.spec_json)) !== parsed.spec_hash) {
    throw new RepositoryIntegrityError("Stored job spec hash is inconsistent.");
  }
  return parsed;
}

async function readReservationByReplayKey(
  session: D1DatabaseSession,
  sessionHash: string,
  clientRequestId: string,
): Promise<PersistedReservationRow | null> {
  const row = await session
    .prepare(
      `SELECT ${reservationColumns}
       FROM jobs
       WHERE session_hash = ? AND client_request_id = ?`,
    )
    .bind(sessionHash, clientRequestId)
    .first();
  return row === null ? null : parsePersistedReservationRow(row);
}

function replayTupleMatches(
  row: PersistedReservationRow,
  input: ValidatedReservationInput,
): boolean {
  return (
    row.contract_id === input.request.toolContract &&
    row.spec_json === input.specJson &&
    row.spec_hash === input.specHash &&
    row.declared_mime === declaredMime(input.request) &&
    row.declared_bytes === input.request.input.byteLength &&
    row.declared_width === declaredWidth(input.request) &&
    row.declared_height === declaredHeight(input.request) &&
    row.declared_page_count === declaredPageCount(input.request) &&
    row.token_hash === input.tokenHash
  );
}

function parseAdmissionStateResult(
  result: D1Result<unknown> | undefined,
): z.infer<typeof admissionAggregateRowSchema> {
  const row = result?.results[0];
  if (row === undefined) {
    throw new RepositoryIntegrityError("Admission state query returned no row.");
  }
  try {
    return admissionAggregateRowSchema.parse(row);
  } catch {
    throw new RepositoryIntegrityError("Admission state does not match the repository contract.");
  }
}

function usageWithRequest(reserved: number, settled: number, requested: number): number {
  return checkedAdd(
    checkedAdd(reserved, settled, "usage total"),
    requested,
    "requested usage total",
  );
}

function classifyAdmissionDenial(
  state: z.infer<typeof admissionAggregateRowSchema>,
  input: ValidatedReservationInput,
): Exclude<AnyReserveAndCreateResult, { kind: "created" | "replayed" }> {
  if (
    input.accountDailyLimit === 0 ||
    input.anonymousDailyLimit === 0 ||
    input.networkDailyLimit === 0
  ) {
    return { kind: "server-processing-disabled", reason: "limit-zero" };
  }
  if (state.circuit_open !== 0) {
    return { kind: "server-processing-disabled", reason: "circuit-open" };
  }
  if (
    state.queued_null_count > 0 ||
    state.queued_future_count > 0 ||
    (state.oldest_queued_at !== null && state.oldest_queued_at > input.now)
  ) {
    return { kind: "queue-unavailable", reason: "invalid-timestamp" };
  }
  const maximumQueueAgeMilliseconds = checkedMultiply(
    input.maximumQueuedAgeSeconds,
    1_000,
    "maximum queued age milliseconds",
  );
  if (
    state.oldest_queued_at !== null &&
    state.oldest_queued_at < input.now - maximumQueueAgeMilliseconds
  ) {
    return { kind: "queue-unavailable", reason: "too-old" };
  }
  if (state.anonymous_active >= 1) {
    return { kind: "active-job-exists" };
  }
  if (state.account_pending >= input.accountPendingJobLimit) {
    return { kind: "pending-limit-exceeded", scope: "account" };
  }
  if (state.network_pending >= input.networkPendingJobLimit) {
    return { kind: "pending-limit-exceeded", scope: "network" };
  }
  const requested = input.estimate.reservedWeightedUnits;
  if (
    usageWithRequest(state.account_reserved, state.account_settled, requested) >
    input.accountDailyLimit
  ) {
    return { kind: "quota-exceeded", scope: "account" };
  }
  if (
    usageWithRequest(state.anonymous_reserved, state.anonymous_settled, requested) >
    input.anonymousDailyLimit
  ) {
    return { kind: "quota-exceeded", scope: "anonymous" };
  }
  if (
    usageWithRequest(state.network_reserved, state.network_settled, requested) >
    input.networkDailyLimit
  ) {
    return { kind: "quota-exceeded", scope: "network" };
  }
  throw new RepositoryIntegrityError(
    "Reservation was rejected without a recognized admission cause.",
  );
}

function batchChanged(result: D1Result<unknown> | undefined, label: string): number {
  if (result === undefined || result.success !== true) {
    throw new RepositoryIntegrityError(`${label} did not return a successful D1 result.`);
  }
  const changes = result.meta.changes;
  if (!Number.isSafeInteger(changes) || changes < 0) {
    throw new RepositoryIntegrityError(`${label} returned invalid change metadata.`);
  }
  return changes;
}

function parseBatchRow<T>(
  result: D1Result<unknown> | undefined,
  schema: z.ZodType<T>,
  label: string,
): T | null {
  if (result === undefined || result.success !== true) {
    throw new RepositoryIntegrityError(`${label} did not return a successful D1 result.`);
  }
  const row = result.results[0];
  if (row === undefined) {
    return null;
  }
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new RepositoryIntegrityError(`${label} does not match the repository contract.`);
  }
  return parsed.data;
}

function committedState(
  state: PersistedJobState,
): state is Exclude<PersistedJobState, "created" | "uploading"> {
  return state !== "created" && state !== "uploading";
}

function validateJobIdAndTime(jobId: string, now: number): void {
  validateCanonicalUuid(jobId, "jobId");
  checkedNonnegativeSafeInteger(now, "now");
}

function validateUploadVersion(uploadVersion: number): void {
  checkedPositiveSafeInteger(uploadVersion, "uploadVersion");
}

function validatePreEngineUploadVersion(input: PreEngineFailureInput): void {
  if (input.outcome === "failed") {
    validateUploadVersion(input.uploadVersion);
    return;
  }
  checkedNonnegativeSafeInteger(input.uploadVersion, "uploadVersion");
}

function validateInputEtag(inputEtag: string): void {
  if (!storedObjectEtagSchema.safeParse(inputEtag).success) {
    throw new TypeError("inputEtag must be a bounded printable raw ETag.");
  }
}

function parseCommitSnapshot(
  result: D1Result<unknown> | undefined,
): z.infer<typeof commitSnapshotRowSchema> | null {
  return parseBatchRow(result, commitSnapshotRowSchema, "Stored-input commit snapshot");
}

function validateStoredOutbox(row: z.infer<typeof commitSnapshotRowSchema>): void {
  if (row.outbox_payload === null) {
    throw new RepositoryIntegrityError("Queued input is missing its transactional outbox row.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.outbox_payload);
  } catch {
    throw new RepositoryIntegrityError("Stored outbox payload is not valid JSON.");
  }
  const parsed = serverJobMessageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RepositoryIntegrityError("Stored outbox payload does not match the queue contract.");
  }
  const message = parsed.data;
  if (
    message.jobId !== row.id ||
    message.contractId !== row.contract_id ||
    message.specHash !== row.spec_hash ||
    message.inputKey !== row.input_key ||
    message.inputEtag !== row.input_etag ||
    message.outputKey !== row.output_key ||
    message.resourceClass !== row.resource_class ||
    message.attempt !== row.attempt ||
    message.queueEpoch !== row.queue_epoch ||
    message.queueGeneration !== row.queue_generation
  ) {
    throw new RepositoryIntegrityError("Stored outbox payload is inconsistent with its job row.");
  }
}

function preEngineTargetState(input: PreEngineFailureInput): "failed" | "cancelled" | "expired" {
  if (input.outcome === "failed") {
    if (input.errorCode !== "UPLOAD_MISMATCH" && input.errorCode !== "STORAGE_FAILURE") {
      throw new TypeError("Failed pre-engine settlement requires a storage or upload error.");
    }
    return "failed";
  }
  if (input.outcome === "cancelled") {
    if (input.errorCode !== "CANCELLED") {
      throw new TypeError("Cancelled pre-engine settlement requires CANCELLED.");
    }
    return "cancelled";
  }
  if (input.errorCode !== "UPLOAD_EXPIRED" && input.errorCode !== "EXPIRED") {
    throw new TypeError("Expired pre-engine settlement requires an expiry error.");
  }
  return "expired";
}

function preEngineSettleableState(state: PersistedJobState): boolean {
  return (
    state === "created" ||
    state === "uploading" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "expired"
  );
}

function deletionAuthorization(
  snapshot: z.infer<typeof settlementSnapshotRowSchema>,
  requestedKey: string,
): DeleteUnownedInputAuthorization | undefined {
  const sameOrAbsentJob = snapshot.id === null || snapshot.input_key === requestedKey;
  if (sameOrAbsentJob && snapshot.input_etag === null && snapshot.key_owner_count === 0) {
    return {
      kind: "delete-unowned-object",
      key: requestedKey,
    };
  }
  return undefined;
}

function withOptionalDeletion<T extends object>(
  result: T,
  authorization: DeleteUnownedInputAuthorization | undefined,
): T & { deleteAuthorization?: DeleteUnownedInputAuthorization } {
  return authorization === undefined
    ? result
    : {
        ...result,
        deleteAuthorization: authorization,
      };
}

class D1JobRepository implements JobRepository, PdfJobRepository {
  constructor(private readonly database: D1Database) {}

  private async settleRejectedUpload(
    row: Pick<z.infer<typeof uploadRowSchema>, "id" | "input_key" | "upload_version">,
    now: number,
    outcome: "cancelled" | "expired",
  ): Promise<BeginUploadResult> {
    const settlementInput: PreEngineFailureInput =
      outcome === "cancelled"
        ? {
            jobId: row.id,
            inputKey: row.input_key,
            uploadVersion: row.upload_version,
            now,
            outcome: "cancelled",
            errorCode: "CANCELLED",
          }
        : {
            jobId: row.id,
            inputKey: row.input_key,
            uploadVersion: row.upload_version,
            now,
            outcome: "expired",
            errorCode: "UPLOAD_EXPIRED",
          };
    const settlement = await this.settlePreEngineFailure(settlementInput);
    if (
      (settlement.kind !== "settled" && settlement.kind !== "already-settled") ||
      (settlement.state !== "cancelled" && settlement.state !== "expired")
    ) {
      throw new RepositoryIntegrityError(
        `${outcome === "cancelled" ? "Cancelled" : "Expired"} upload reservation was not settled before rejection.`,
      );
    }
    return withOptionalDeletion(
      {
        kind: "rejected" as const,
        reason: settlement.state,
      },
      settlement.deleteAuthorization,
    );
  }

  async loadExpectedTokenHash(jobId: string): Promise<string | null> {
    validateCanonicalUuid(jobId, "jobId");
    const session = this.database.withSession("first-primary");
    const row = await session
      .prepare("SELECT token_hash FROM jobs WHERE id = ?")
      .bind(jobId)
      .first();
    if (row === null) {
      return null;
    }
    const parsed = tokenHashRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new RepositoryIntegrityError(
        "Stored token hash does not match the repository contract.",
      );
    }
    return parsed.data.token_hash;
  }

  async beginUpload(input: { jobId: string; now: number }): Promise<BeginUploadResult>;
  async beginUpload(input: { jobId: string; now: number }): Promise<AnyBeginUploadResult> {
    validateJobIdAndTime(input.jobId, input.now);
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE jobs
           SET status = 'uploading',
               phase = 'uploading',
               upload_version = upload_version + 1,
               phase_sequence = phase_sequence + 1,
               updated_at = ?
           WHERE id = ?
             AND status = 'created'
             AND input_etag IS NULL
             AND cancel_requested_at IS NULL
             AND upload_expires_at > ?`,
        )
        .bind(input.now, input.jobId, input.now),
      session
        .prepare(
          `SELECT
             id,
             status,
             contract_id,
             declared_bytes,
             declared_mime,
             input_key,
             input_etag,
             upload_version,
             cancel_requested_at,
             upload_expires_at
           FROM jobs
           WHERE id = ?`,
        )
        .bind(input.jobId),
    ]);
    const transitioned = batchChanged(results[0], "Begin-upload transition");
    if (transitioned > 1) {
      throw new RepositoryIntegrityError("Begin-upload transition changed more than one job.");
    }
    const row = parseBatchRow(results[1], uploadRowSchema, "Begin-upload snapshot");
    if (row === null) {
      return { kind: "rejected", reason: "not-found" };
    }

    if (row.input_etag !== null) {
      if (!committedState(row.status)) {
        throw new RepositoryIntegrityError("An incomplete job unexpectedly owns an input ETag.");
      }
      return {
        kind: "already-committed",
        state: row.status,
        inputEtag: row.input_etag,
        declaredBytes: row.declared_bytes,
        declaredMime: row.declared_mime,
      };
    }
    if (
      row.status === "cancelled" ||
      ((row.status === "created" || row.status === "uploading") && row.cancel_requested_at !== null)
    ) {
      return this.settleRejectedUpload(row, input.now, "cancelled");
    }
    if (
      row.status === "expired" ||
      ((row.status === "created" || row.status === "uploading") &&
        row.upload_expires_at <= input.now)
    ) {
      return this.settleRejectedUpload(row, input.now, "expired");
    }
    if (row.status === "uploading") {
      if (row.upload_version < 1) {
        throw new RepositoryIntegrityError("Uploading job has no accepted upload version.");
      }
      return {
        kind: "ready",
        jobId: row.id,
        declaredBytes: row.declared_bytes,
        declaredMime: row.declared_mime,
        inputKey: row.input_key,
        uploadVersion: row.upload_version,
        uploadExpiresAt: row.upload_expires_at,
      };
    }
    if (row.status === "created" && transitioned === 1) {
      throw new RepositoryIntegrityError("Begin-upload transition was not visible in its batch.");
    }
    return { kind: "rejected", reason: "invalid-state" };
  }

  async commitStoredInput(input: {
    jobId: string;
    uploadVersion: number;
    inputEtag: string;
    now: number;
  }): Promise<CommitStoredInputResult> {
    validateJobIdAndTime(input.jobId, input.now);
    validateUploadVersion(input.uploadVersion);
    validateInputEtag(input.inputEtag);
    const processingDeadlineAt = checkedAdd(
      input.now,
      PROCESSING_DEADLINE_MS,
      "processing deadline",
    );
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE jobs
           SET status = 'queued',
               phase = 'queued',
               phase_fraction = NULL,
               phase_sequence = phase_sequence + 1,
               input_etag = ?,
               attempt = 1,
               queued_at = ?,
               processing_deadline_at = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'uploading'
             AND upload_version = ?
             AND input_etag IS NULL
             AND cancel_requested_at IS NULL
             AND upload_expires_at > ?`,
        )
        .bind(
          input.inputEtag,
          input.now,
          processingDeadlineAt,
          input.now,
          input.jobId,
          input.uploadVersion,
          input.now,
        ),
      session
        .prepare(
          `INSERT INTO job_outbox (
             job_id,
             payload,
             attempts,
             next_attempt_at,
             sent_at
           )
           SELECT
             id,
             json_object(
               'jobId', id,
               'contractId', contract_id,
               'specHash', spec_hash,
               'inputKey', input_key,
               'inputEtag', input_etag,
               'outputKey', output_key,
               'resourceClass', resource_class,
               'attempt', attempt,
               'queueEpoch', queue_epoch,
               'queueGeneration', queue_generation
             ),
             0,
             ?,
             NULL
           FROM jobs
           WHERE id = ?
             AND status = 'queued'
             AND upload_version = ?
             AND input_etag = ?
           ON CONFLICT(job_id) DO NOTHING`,
        )
        .bind(input.now, input.jobId, input.uploadVersion, input.inputEtag),
      session
        .prepare(
          `UPDATE rollout_control
           SET circuit_open = 1,
               reason = 'INPUT_ETAG_CONFLICT',
               opened_at = COALESCE(opened_at, ?)
           WHERE id = 1
             AND EXISTS (
               SELECT 1
               FROM jobs
               WHERE id = ?
                 AND input_etag IS NOT NULL
                 AND input_etag <> ?
             )`,
        )
        .bind(input.now, input.jobId, input.inputEtag),
      session
        .prepare(
          `SELECT
             jobs.id,
             jobs.status,
             jobs.contract_id,
             jobs.spec_hash,
             jobs.declared_bytes,
             jobs.declared_mime,
             jobs.input_key,
             jobs.input_etag,
             jobs.upload_version,
             jobs.output_key,
             jobs.resource_class,
             jobs.attempt,
             jobs.queue_epoch,
             jobs.queue_generation,
             jobs.cancel_requested_at,
             jobs.upload_expires_at,
             job_outbox.payload AS outbox_payload
           FROM jobs
           LEFT JOIN job_outbox ON job_outbox.job_id = jobs.id
           WHERE jobs.id = ?`,
        )
        .bind(input.jobId),
    ]);
    const queued = batchChanged(results[0], "Stored-input ownership transition");
    const circuitChanged = batchChanged(results[2], "Stored-input invariant circuit update");
    if (queued > 1) {
      throw new RepositoryIntegrityError("Stored-input transition changed more than one job.");
    }
    if (circuitChanged > 1) {
      throw new RepositoryIntegrityError("Stored-input conflict changed multiple circuit rows.");
    }
    const row = parseCommitSnapshot(results[3]);
    if (row === null) {
      return { kind: "delete-unowned-object", reason: "no-owner" };
    }
    if (row.input_etag !== null && row.input_etag !== input.inputEtag) {
      if (circuitChanged !== 1) {
        throw new RepositoryIntegrityError("Conflicting owned ETag did not open the circuit.");
      }
      return { kind: "conflicting-owned-etag" };
    }
    if (row.input_etag === input.inputEtag) {
      if (!committedState(row.status)) {
        throw new RepositoryIntegrityError("An incomplete job owns a committed input ETag.");
      }
      if (row.status === "queued") {
        validateStoredOutbox(row);
      }
      if (queued === 1) {
        if (row.status !== "queued") {
          throw new RepositoryIntegrityError("Queued transition was not visible in its batch.");
        }
        return { kind: "queued" };
      }
      return {
        kind: "already-queued-same-etag",
        state: row.status,
      };
    }
    if (row.cancel_requested_at !== null || row.status === "cancelled") {
      return { kind: "delete-unowned-object", reason: "cancelled" };
    }
    if (
      row.status === "expired" ||
      ((row.status === "created" || row.status === "uploading") &&
        row.upload_expires_at <= input.now)
    ) {
      return { kind: "delete-unowned-object", reason: "expired" };
    }
    if (row.upload_version !== input.uploadVersion) {
      return { kind: "delete-unowned-object", reason: "upload-version-changed" };
    }
    if (row.status === "uploading") {
      throw new RepositoryIntegrityError(
        "Eligible stored input did not complete its transactional commit.",
      );
    }
    return { kind: "delete-unowned-object", reason: "no-owner" };
  }

  async settlePreEngineFailure(
    input: PreEngineFailureInput,
  ): Promise<SettlePreEngineFailureResult> {
    validateJobIdAndTime(input.jobId, input.now);
    validateObjectKey(input.inputKey, "input");
    validatePreEngineUploadVersion(input);
    const targetState = preEngineTargetState(input);
    const terminalRecordExpiresAt = checkedAdd(
      input.now,
      TERMINAL_RECORD_RETENTION_MS,
      "terminal record deadline",
    );
    const marker = `
      jobs.id = ?
      AND jobs.input_key = ?
      AND jobs.upload_version = ?
      AND jobs.settlement_state = 'reserved'
      AND jobs.input_etag IS NULL
      AND jobs.engine_contact_started_at IS NULL
      AND jobs.status IN ('created', 'uploading', 'failed', 'cancelled', 'expired')
      AND EXISTS (
        SELECT 1
        FROM usage_ledger
        WHERE usage_ledger.job_id = jobs.id
          AND usage_ledger.settled_at IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM account_usage
        WHERE account_usage.day_key = jobs.day_key
      )
      AND EXISTS (
        SELECT 1
        FROM anonymous_usage
        WHERE anonymous_usage.session_hash = jobs.session_hash
          AND anonymous_usage.day_key = jobs.day_key
      )
      AND EXISTS (
        SELECT 1
        FROM network_usage
        WHERE network_usage.network_hash = jobs.network_hash
          AND network_usage.day_key = jobs.day_key
      )
    `;
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE account_usage
           SET reserved_units = reserved_units - (
                 SELECT reserved_units FROM jobs WHERE id = ?
               ),
               settled_units = settled_units + ?,
               pending_jobs = pending_jobs - 1,
               updated_at = ?
           WHERE day_key = (SELECT day_key FROM jobs WHERE id = ?)
             AND EXISTS (
               SELECT 1 FROM jobs WHERE ${marker}
             )`,
        )
        .bind(
          input.jobId,
          PRE_ENGINE_SETTLED_UNITS,
          input.now,
          input.jobId,
          input.jobId,
          input.inputKey,
          input.uploadVersion,
        ),
      session
        .prepare(
          `UPDATE anonymous_usage
           SET reserved_units = reserved_units - (
                 SELECT reserved_units FROM jobs WHERE id = ?
               ),
               settled_units = settled_units + ?,
               active_jobs = active_jobs - 1,
               updated_at = ?
           WHERE session_hash = (SELECT session_hash FROM jobs WHERE id = ?)
             AND day_key = (SELECT day_key FROM jobs WHERE id = ?)
             AND EXISTS (
               SELECT 1 FROM jobs WHERE ${marker}
             )`,
        )
        .bind(
          input.jobId,
          PRE_ENGINE_SETTLED_UNITS,
          input.now,
          input.jobId,
          input.jobId,
          input.jobId,
          input.inputKey,
          input.uploadVersion,
        ),
      session
        .prepare(
          `UPDATE network_usage
           SET reserved_units = reserved_units - (
                 SELECT reserved_units FROM jobs WHERE id = ?
               ),
               settled_units = settled_units + ?,
               pending_jobs = pending_jobs - 1,
               updated_at = ?
           WHERE network_hash = (SELECT network_hash FROM jobs WHERE id = ?)
             AND day_key = (SELECT day_key FROM jobs WHERE id = ?)
             AND EXISTS (
               SELECT 1 FROM jobs WHERE ${marker}
             )`,
        )
        .bind(
          input.jobId,
          PRE_ENGINE_SETTLED_UNITS,
          input.now,
          input.jobId,
          input.jobId,
          input.jobId,
          input.inputKey,
          input.uploadVersion,
        ),
      session
        .prepare(
          `UPDATE jobs
           SET status = ?,
               phase = 'completed',
               phase_fraction = 1,
               phase_sequence = phase_sequence + 1,
               actual_units = ?,
               settlement_state = 'settled',
               error_code = ?,
               error_guidance = NULL,
               result_expires_at = NULL,
               finished_at = ?,
               terminal_record_expires_at = ?,
               network_hash_expires_at = MIN(network_hash_expires_at, ?),
               updated_at = ?
           WHERE ${marker}`,
        )
        .bind(
          targetState,
          PRE_ENGINE_SETTLED_UNITS,
          input.errorCode,
          input.now,
          terminalRecordExpiresAt,
          terminalRecordExpiresAt,
          input.now,
          input.jobId,
          input.inputKey,
          input.uploadVersion,
        ),
      session
        .prepare(
          `UPDATE usage_ledger
           SET actual_units = ?,
               outcome = ?,
               settled_at = ?
           WHERE job_id = ?
             AND settled_at IS NULL
             AND EXISTS (
               SELECT 1
               FROM jobs
               WHERE jobs.id = usage_ledger.job_id
                 AND jobs.status = ?
                 AND jobs.settlement_state = 'settled'
                 AND jobs.actual_units = ?
                 AND jobs.finished_at = ?
             )`,
        )
        .bind(
          PRE_ENGINE_SETTLED_UNITS,
          input.outcome,
          input.now,
          input.jobId,
          targetState,
          PRE_ENGINE_SETTLED_UNITS,
          input.now,
        ),
      session
        .prepare(
          `SELECT
             jobs.id,
             jobs.input_key,
             jobs.input_etag,
             jobs.upload_version,
             jobs.status,
             jobs.settlement_state,
             (
               SELECT COUNT(*)
               FROM jobs AS owner
               WHERE owner.input_key = ?
                 AND (
                   owner.id <> ?
                   OR owner.input_etag IS NOT NULL
                 )
             ) AS key_owner_count
           FROM (SELECT 1) AS singleton
           LEFT JOIN jobs ON jobs.id = ?`,
        )
        .bind(input.inputKey, input.jobId, input.jobId),
    ]);
    const settled = batchChanged(results[3], "Pre-engine job settlement");
    if (settled > 1) {
      throw new RepositoryIntegrityError("Pre-engine settlement changed more than one job.");
    }
    if (settled === 1) {
      for (const [result, label] of [
        [results[0], "account"],
        [results[1], "anonymous"],
        [results[2], "network"],
      ] as const) {
        if (batchChanged(result, `Pre-engine ${label} settlement`) !== 1) {
          throw new RepositoryIntegrityError(
            `Pre-engine settlement did not update the ${label} usage row.`,
          );
        }
      }
      if (batchChanged(results[4], "Pre-engine ledger settlement") !== 1) {
        throw new RepositoryIntegrityError(
          "Pre-engine settlement did not settle its usage ledger.",
        );
      }
    }
    const snapshot = parseBatchRow(
      results[5],
      settlementSnapshotRowSchema,
      "Pre-engine settlement snapshot",
    );
    if (snapshot === null) {
      throw new RepositoryIntegrityError("Pre-engine settlement snapshot returned no row.");
    }
    const authorization = deletionAuthorization(snapshot, input.inputKey);
    if (settled === 1) {
      return withOptionalDeletion(
        {
          kind: "settled" as const,
          state: targetState,
        },
        authorization,
      );
    }
    if (snapshot.id === null) {
      return withOptionalDeletion({ kind: "no-owner" as const }, authorization);
    }
    if (snapshot.settlement_state === "settled" && snapshot.status !== null) {
      return withOptionalDeletion(
        {
          kind: "already-settled" as const,
          state: snapshot.status,
        },
        authorization,
      );
    }
    if (snapshot.upload_version !== input.uploadVersion) {
      return withOptionalDeletion({ kind: "upload-version-changed" as const }, authorization);
    }
    if (
      snapshot.input_key === input.inputKey &&
      snapshot.input_etag === null &&
      snapshot.settlement_state === "reserved" &&
      snapshot.status !== null &&
      preEngineSettleableState(snapshot.status)
    ) {
      throw new RepositoryIntegrityError("Eligible pre-engine settlement was not applied.");
    }
    return withOptionalDeletion({ kind: "no-owner" as const }, authorization);
  }

  async openInvariantCircuit(input: { now: number; reason: "INPUT_ETAG_CONFLICT" }): Promise<void> {
    checkedNonnegativeSafeInteger(input.now, "now");
    if (input.reason !== "INPUT_ETAG_CONFLICT") {
      throw new TypeError("Unsupported invariant circuit reason.");
    }
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE rollout_control
           SET circuit_open = 1,
               reason = 'INPUT_ETAG_CONFLICT',
               opened_at = COALESCE(opened_at, ?)
           WHERE id = 1`,
        )
        .bind(input.now),
      session.prepare(
        `SELECT circuit_open, reason, opened_at
           FROM rollout_control
           WHERE id = 1`,
      ),
    ]);
    if (batchChanged(results[0], "Invariant circuit update") > 1) {
      throw new RepositoryIntegrityError("Invariant circuit update changed multiple rows.");
    }
    const row = parseBatchRow(results[1], circuitRowSchema, "Invariant circuit snapshot");
    if (
      row === null ||
      row.circuit_open !== 1 ||
      row.reason !== "INPUT_ETAG_CONFLICT" ||
      row.opened_at === null
    ) {
      throw new RepositoryIntegrityError("Invariant circuit did not open.");
    }
  }

  async reserveAndCreate(input: ReserveAndCreateInput): Promise<ReserveAndCreateResult>;
  async reserveAndCreate(input: PdfReserveAndCreateInput): Promise<PdfReserveAndCreateResult>;
  async reserveAndCreate(rawInput: AnyReserveAndCreateInput): Promise<AnyReserveAndCreateResult> {
    const input = await validateReservationInput(rawInput);
    const session = this.database.withSession("first-primary");
    const batchResults = await session.batch(prepareReservationBatch(session, input));
    const created = batchResults[3]?.meta.changes === 1;
    const admissionState = parseAdmissionStateResult(batchResults[10]);
    const replayedRow = await readReservationByReplayKey(
      session,
      input.sessionHash,
      input.clientRequestId,
    );

    if (replayedRow !== null) {
      if (!replayTupleMatches(replayedRow, input)) {
        return {
          kind: "idempotency-conflict",
          existingJobId: replayedRow.id,
        };
      }
      const job = toReservationJob(replayedRow);
      const mode =
        replayedRow.status === "created" || replayedRow.status === "uploading"
          ? "upload-required"
          : "existing-job";
      if (created) {
        if (replayedRow.id !== input.jobId) {
          throw new RepositoryIntegrityError(
            "Created reservation identity does not match its row.",
          );
        }
        return job.contractId === "pdf.optimize@1"
          ? { kind: "created", mode: "upload-required", job }
          : { kind: "created", mode: "upload-required", job };
      }
      return job.contractId === "pdf.optimize@1"
        ? { kind: "replayed", mode, job }
        : { kind: "replayed", mode, job };
    }

    if (created) {
      throw new RepositoryIntegrityError("Created reservation could not be read back.");
    }
    if (admissionState.proposed_job_id_count === 1) {
      return { kind: "job-id-collision" };
    }

    return classifyAdmissionDenial(admissionState, input);
  }
}

export function createD1JobRepository(database: D1Database): AnyJobRepository {
  return new D1JobRepository(database);
}

const lifecycleJobRowSchema = z
  .object({
    id: canonicalUuidSchema,
    status: jobStateSchema,
    phase: imageOptimizePhaseSchema,
    phase_fraction: z.number().finite().min(0).max(1).nullable(),
    phase_sequence: nonnegativeSafeIntegerSchema,
    attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    input_key: z.string().regex(INPUT_KEY_PATTERN),
    output_key: z.string().regex(OUTPUT_KEY_PATTERN),
    output_bytes: positiveSafeIntegerSchema.nullable(),
    output_mime: imageOptimizeMimeSchema.nullable(),
    output_width: positiveSafeIntegerSchema.nullable(),
    output_height: positiveSafeIntegerSchema.nullable(),
    result_kind: z.enum(["download", "original-retained"]).nullable(),
    engine_build_id: z.string().min(1).max(128).nullable(),
    codec_build_id: z.string().min(1).max(128).nullable(),
    warnings_json: z.string().max(4_096).nullable(),
    tested_candidates: nonnegativeSafeIntegerSchema.nullable(),
    error_code: toolJobErrorCodeSchema.nullable(),
    error_guidance: z.literal("TRY_BALANCED_PRESET").nullable(),
    actual_units: nonnegativeSafeIntegerSchema.nullable(),
    queued_at: nonnegativeSafeIntegerSchema.nullable(),
    started_at: nonnegativeSafeIntegerSchema.nullable(),
    engine_contact_started_at: nonnegativeSafeIntegerSchema.nullable(),
    finished_at: nonnegativeSafeIntegerSchema.nullable(),
    result_expires_at: nonnegativeSafeIntegerSchema.nullable(),
    download_acknowledged_at: nonnegativeSafeIntegerSchema.nullable(),
    download_lease_expires_at: nonnegativeSafeIntegerSchema.nullable(),
    created_at: nonnegativeSafeIntegerSchema,
    updated_at: nonnegativeSafeIntegerSchema,
  })
  .strict();

const lifecycleColumns = `
  id,
  status,
  phase,
  phase_fraction,
  phase_sequence,
  attempt,
  input_key,
  output_key,
  output_bytes,
  output_mime,
  output_width,
  output_height,
  result_kind,
  engine_build_id,
  codec_build_id,
  warnings_json,
  tested_candidates,
  error_code,
  error_guidance,
  actual_units,
  queued_at,
  started_at,
  engine_contact_started_at,
  finished_at,
  result_expires_at,
  download_acknowledged_at,
  download_lease_expires_at,
  created_at,
  updated_at
`;

function parseWarnings(value: string | null): LifecycleJob["warnings"] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RepositoryIntegrityError("Stored warning metadata is not valid JSON.");
  }
  const warnings = z.array(imageOptimizeWarningCodeSchema).max(16).safeParse(parsed);
  if (!warnings.success) {
    throw new RepositoryIntegrityError("Stored warning metadata is invalid.");
  }
  return warnings.data;
}

function toLifecycleJob(row: z.infer<typeof lifecycleJobRowSchema>): LifecycleJob {
  return {
    jobId: row.id,
    state: row.status,
    phase: row.phase,
    phaseFraction: row.phase_fraction,
    sequence: row.phase_sequence,
    attempt: row.attempt,
    inputKey: row.input_key,
    outputKey: row.output_key,
    outputBytes: row.output_bytes,
    outputMime: row.output_mime,
    outputWidth: row.output_width,
    outputHeight: row.output_height,
    resultKind: row.result_kind,
    engineBuildId: row.engine_build_id,
    codecBuildId: row.codec_build_id,
    warnings: parseWarnings(row.warnings_json),
    testedCandidates: row.tested_candidates,
    errorCode: row.error_code,
    errorGuidance: row.error_guidance,
    actualWeightedUnits: row.actual_units,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    engineContactStartedAt: row.engine_contact_started_at,
    finishedAt: row.finished_at,
    resultExpiresAt: row.result_expires_at,
    downloadAcknowledgedAt: row.download_acknowledged_at,
    downloadLeaseExpiresAt: row.download_lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseLifecycleRow(raw: unknown, label: string): LifecycleJob | null {
  if (raw === null || raw === undefined) return null;
  const parsed = lifecycleJobRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepositoryIntegrityError(`${label} does not match the lifecycle contract.`);
  }
  return toLifecycleJob(parsed.data);
}

const cancellationSnapshotSchema = z
  .object({
    id: canonicalUuidSchema,
    status: jobStateSchema,
    input_key: z.string().regex(INPUT_KEY_PATTERN),
    output_key: z.string().regex(OUTPUT_KEY_PATTERN),
    upload_version: nonnegativeSafeIntegerSchema,
  })
  .strict();

const leaseHashRowSchema = z.object({ download_lease_hash: hashSchema.nullable() }).strict();

class D1LifecycleRepository implements LifecycleRepository {
  private readonly jobs: D1JobRepository;

  constructor(private readonly database: D1Database) {
    this.jobs = new D1JobRepository(database);
  }

  loadExpectedTokenHash(jobId: string): Promise<string | null> {
    return this.jobs.loadExpectedTokenHash(jobId);
  }

  async readJob(jobId: string): Promise<LifecycleJob | null> {
    validateCanonicalUuid(jobId, "jobId");
    const session = this.database.withSession("first-primary");
    const row = await session
      .prepare(`SELECT ${lifecycleColumns} FROM jobs WHERE id = ?`)
      .bind(jobId)
      .first();
    return parseLifecycleRow(row, "Lifecycle job row");
  }

  private async settleQueuedCancellation(jobId: string, now: number): Promise<boolean> {
    const terminalExpiry = checkedAdd(
      now,
      TERMINAL_RECORD_RETENTION_MS,
      "terminal record deadline",
    );
    const marker = `EXISTS (
      SELECT 1 FROM jobs
      JOIN usage_ledger ON usage_ledger.job_id = jobs.id
      WHERE jobs.id = ? AND jobs.status = 'cancelled'
        AND jobs.settlement_state = 'settled' AND jobs.finished_at = ?
        AND usage_ledger.settled_at IS NULL
    )`;
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE jobs
           SET status = 'cancelled', phase = 'completed', phase_fraction = 1,
               phase_sequence = phase_sequence + 1,
               actual_units = COALESCE(actual_units, 0) + ?,
               settlement_state = 'settled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
               lease_token = NULL, lease_expires_at = NULL,
               error_code = 'CANCELLED', error_guidance = NULL,
               result_expires_at = NULL, finished_at = ?, terminal_record_expires_at = ?,
               network_hash_expires_at = MIN(network_hash_expires_at, ?), updated_at = ?
           WHERE id = ? AND status = 'queued' AND settlement_state = 'reserved'
             AND input_etag IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM account_usage
               WHERE day_key = jobs.day_key AND reserved_units >= jobs.reserved_units
                 AND pending_jobs > 0
             )
             AND EXISTS (
               SELECT 1 FROM anonymous_usage
               WHERE session_hash = jobs.session_hash AND day_key = jobs.day_key
                 AND reserved_units >= jobs.reserved_units AND active_jobs > 0
             )
             AND EXISTS (
               SELECT 1 FROM network_usage
               WHERE network_hash = jobs.network_hash AND day_key = jobs.day_key
                 AND reserved_units >= jobs.reserved_units AND pending_jobs > 0
             )
             AND EXISTS (
               SELECT 1 FROM usage_ledger WHERE job_id = jobs.id AND settled_at IS NULL
             )`,
        )
        .bind(PRE_ENGINE_SETTLED_UNITS, now, now, terminalExpiry, terminalExpiry, now, jobId),
      session
        .prepare(
          `UPDATE account_usage
           SET reserved_units = reserved_units - (SELECT reserved_units FROM jobs WHERE id = ?),
               settled_units = settled_units + (SELECT actual_units FROM jobs WHERE id = ?),
               pending_jobs = pending_jobs - 1, updated_at = ?
           WHERE day_key = (SELECT day_key FROM jobs WHERE id = ?)
             AND ${marker}`,
        )
        .bind(jobId, jobId, now, jobId, jobId, now),
      session
        .prepare(
          `UPDATE anonymous_usage
           SET reserved_units = reserved_units - (SELECT reserved_units FROM jobs WHERE id = ?),
               settled_units = settled_units + (SELECT actual_units FROM jobs WHERE id = ?),
               active_jobs = active_jobs - 1, updated_at = ?
           WHERE session_hash = (SELECT session_hash FROM jobs WHERE id = ?)
             AND day_key = (SELECT day_key FROM jobs WHERE id = ?)
             AND ${marker}`,
        )
        .bind(jobId, jobId, now, jobId, jobId, jobId, now),
      session
        .prepare(
          `UPDATE network_usage
           SET reserved_units = reserved_units - (SELECT reserved_units FROM jobs WHERE id = ?),
               settled_units = settled_units + (SELECT actual_units FROM jobs WHERE id = ?),
               pending_jobs = pending_jobs - 1, updated_at = ?
           WHERE network_hash = (SELECT network_hash FROM jobs WHERE id = ?)
             AND day_key = (SELECT day_key FROM jobs WHERE id = ?)
             AND ${marker}`,
        )
        .bind(jobId, jobId, now, jobId, jobId, jobId, now),
      session
        .prepare(
          `UPDATE usage_ledger
           SET actual_units = (SELECT actual_units FROM jobs WHERE id = ?),
               outcome = 'cancelled', settled_at = ?
           WHERE job_id = ? AND settled_at IS NULL
             AND EXISTS (
               SELECT 1 FROM jobs WHERE id = ? AND status = 'cancelled'
                 AND settlement_state = 'settled' AND finished_at = ?
             )`,
        )
        .bind(jobId, now, jobId, jobId, now),
      session.prepare("DELETE FROM job_outbox WHERE job_id = ?").bind(jobId),
    ]);
    const changed = batchChanged(results[0], "Queued cancellation settlement");
    if (changed > 1) {
      throw new RepositoryIntegrityError("Queued cancellation changed multiple jobs.");
    }
    if (changed === 1) {
      for (const [index, label] of [
        [1, "account"],
        [2, "anonymous"],
        [3, "network"],
        [4, "ledger"],
      ] as const) {
        if (batchChanged(results[index], `Queued cancellation ${label}`) !== 1) {
          throw new RepositoryIntegrityError(`Queued cancellation did not settle ${label}.`);
        }
      }
    }
    return changed === 1;
  }

  private async requestRunningCancellation(jobId: string, now: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE jobs
         SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
         WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'`,
      )
      .bind(now, now, jobId)
      .run();
    return batchChanged(result, "Running cancellation request") === 1;
  }

  private async cancellationSnapshot(jobId: string) {
    const session = this.database.withSession("first-primary");
    const row = await session
      .prepare("SELECT id, status, input_key, output_key, upload_version FROM jobs WHERE id = ?")
      .bind(jobId)
      .first();
    if (row === null) return null;
    const parsed = cancellationSnapshotSchema.safeParse(row);
    if (!parsed.success) {
      throw new RepositoryIntegrityError("Cancellation snapshot is invalid.");
    }
    return parsed.data;
  }

  private async mutate(
    jobId: string,
    now: number,
    intent: "cancel" | "delete",
  ): Promise<LifecycleMutationResult> {
    validateJobIdAndTime(jobId, now);
    for (let pass = 0; pass < 4; pass += 1) {
      const snapshot = await this.cancellationSnapshot(jobId);
      if (snapshot === null) return { kind: "missing" };
      if (snapshot.status === "created" || snapshot.status === "uploading") {
        const settlement = await this.jobs.settlePreEngineFailure({
          jobId,
          inputKey: snapshot.input_key,
          uploadVersion: snapshot.upload_version,
          now,
          outcome: "cancelled",
          errorCode: "CANCELLED",
        });
        if (settlement.kind === "settled" || settlement.kind === "already-settled") {
          const job = await this.readJob(jobId);
          if (job === null) return { kind: "missing" };
          return {
            kind: "cancelled-and-settled",
            job,
            inputKey: snapshot.input_key,
            outputKey: snapshot.output_key,
          };
        }
        continue;
      }
      if (snapshot.status === "queued") {
        if (!(await this.settleQueuedCancellation(jobId, now))) continue;
        const job = await this.readJob(jobId);
        if (job === null) return { kind: "missing" };
        return {
          kind: "cancelled-and-settled",
          job,
          inputKey: snapshot.input_key,
          outputKey: snapshot.output_key,
        };
      }
      if (snapshot.status === "running") {
        if (!(await this.requestRunningCancellation(jobId, now))) continue;
        const job = await this.readJob(jobId);
        if (job === null) return { kind: "missing" };
        if (job.state !== "running") continue;
        return { kind: "running", job };
      }
      if (intent === "delete" && snapshot.status === "succeeded") {
        await this.database
          .prepare(
            `UPDATE jobs
             SET download_acknowledged_at = COALESCE(download_acknowledged_at, ?), updated_at = ?
             WHERE id = ? AND status = 'succeeded'`,
          )
          .bind(now, now, jobId)
          .run();
      }
      const job = await this.readJob(jobId);
      if (job === null) return { kind: "missing" };
      return { kind: "terminal", job };
    }
    throw new RepositoryIntegrityError("Lifecycle mutation did not converge.");
  }

  cancelJob(jobId: string, now: number): Promise<LifecycleMutationResult> {
    return this.mutate(jobId, now, "cancel");
  }

  deleteJob(jobId: string, now: number): Promise<LifecycleMutationResult> {
    return this.mutate(jobId, now, "delete");
  }

  async claimDownload(input: {
    jobId: string;
    leaseHash: string;
    now: number;
    expiresAt: number;
  }): Promise<ClaimDownloadResult> {
    validateJobIdAndTime(input.jobId, input.now);
    validateHash(input.leaseHash, "leaseHash");
    checkedPositiveSafeInteger(input.expiresAt, "download lease expiry");
    if (input.expiresAt <= input.now || input.expiresAt - input.now > 2 * 60_000) {
      throw new RangeError("Download lease duration is invalid.");
    }
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE jobs
           SET download_lease_hash = ?, download_lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'succeeded' AND result_kind = 'download'
             AND result_expires_at > ? AND download_acknowledged_at IS NULL
             AND (download_lease_expires_at IS NULL OR download_lease_expires_at <= ?)`,
        )
        .bind(input.leaseHash, input.expiresAt, input.now, input.jobId, input.now, input.now),
      session.prepare(`SELECT ${lifecycleColumns} FROM jobs WHERE id = ?`).bind(input.jobId),
    ]);
    const changed = batchChanged(results[0], "Download lease claim");
    if (changed > 1) throw new RepositoryIntegrityError("Download lease changed multiple jobs.");
    const job = parseLifecycleRow(results[1]?.results[0], "Download lease snapshot");
    if (job === null) return { kind: "missing" };
    if (changed === 1) return { kind: "claimed", job };
    if (job.state === "succeeded" && job.resultKind === "original-retained") {
      return { kind: "original-retained", job };
    }
    if (
      job.state === "succeeded" &&
      job.resultKind === "download" &&
      job.downloadAcknowledgedAt === null &&
      job.downloadLeaseExpiresAt !== null &&
      job.downloadLeaseExpiresAt > input.now
    ) {
      return { kind: "busy" };
    }
    if (
      job.state === "succeeded" &&
      job.resultKind === "download" &&
      (job.resultExpiresAt === null || job.resultExpiresAt <= input.now)
    ) {
      return { kind: "expired" };
    }
    return { kind: "not-ready" };
  }

  async loadDownloadLeaseHash(jobId: string): Promise<string | null> {
    validateCanonicalUuid(jobId, "jobId");
    const session = this.database.withSession("first-primary");
    const row = await session
      .prepare("SELECT download_lease_hash FROM jobs WHERE id = ?")
      .bind(jobId)
      .first();
    if (row === null) return null;
    const parsed = leaseHashRowSchema.safeParse(row);
    if (!parsed.success) throw new RepositoryIntegrityError("Stored download lease is invalid.");
    return parsed.data.download_lease_hash;
  }

  async acknowledgeDownload(
    jobId: string,
    leaseHash: string,
    now: number,
  ): Promise<
    | { readonly kind: "acknowledged"; readonly outputKey: string }
    | { readonly kind: "invalid-lease" | "missing" }
  > {
    validateJobIdAndTime(jobId, now);
    validateHash(leaseHash, "leaseHash");
    const session = this.database.withSession("first-primary");
    const results = await session.batch([
      session
        .prepare(
          `UPDATE jobs
           SET download_acknowledged_at = COALESCE(download_acknowledged_at, ?), updated_at = ?
           WHERE id = ? AND status = 'succeeded' AND result_kind = 'download'
             AND download_lease_hash = ? AND download_lease_expires_at > ?`,
        )
        .bind(now, now, jobId, leaseHash, now),
      session.prepare("SELECT output_key FROM jobs WHERE id = ?").bind(jobId),
    ]);
    const changed = batchChanged(results[0], "Download acknowledgement");
    if (changed > 1) throw new RepositoryIntegrityError("Download acknowledgement changed jobs.");
    const raw = results[1]?.results[0];
    if (raw === undefined) return { kind: "missing" };
    const parsed = z
      .object({ output_key: z.string().regex(OUTPUT_KEY_PATTERN) })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw new RepositoryIntegrityError("Download output key is invalid.");
    return changed === 1
      ? { kind: "acknowledged", outputKey: parsed.data.output_key }
      : { kind: "invalid-lease" };
  }

  async completeResultDeletion(jobId: string, now: number): Promise<boolean> {
    validateJobIdAndTime(jobId, now);
    const result = await this.database
      .prepare(
        `UPDATE jobs
         SET download_lease_hash = NULL, download_lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('succeeded', 'expired')
           AND download_acknowledged_at IS NOT NULL`,
      )
      .bind(now, jobId)
      .run();
    const changed = batchChanged(result, "Result deletion completion");
    if (changed > 1) throw new RepositoryIntegrityError("Result deletion changed multiple jobs.");
    if (changed === 1) return true;
    const job = await this.readJob(jobId);
    return (
      job !== null &&
      (job.state === "succeeded" || job.state === "expired") &&
      job.downloadAcknowledgedAt !== null &&
      job.downloadLeaseExpiresAt === null
    );
  }
}

export function createD1LifecycleRepository(database: D1Database): LifecycleRepository {
  return new D1LifecycleRepository(database);
}

export interface JobLease {
  jobId: string;
  leaseToken: string;
  attempt: 1 | 2 | 3;
  leaseExpiresAt: number;
}

export interface ClaimedQueueJob extends JobLease {
  contractId: "image.optimize@1";
  specJson: string;
  specHash: string;
  declaredBytes: number;
  declaredMime: "image/jpeg" | "image/png" | "image/webp";
  inputKey: string;
  inputEtag: string;
  outputKey: string;
  resourceClass: "image-standard-v1" | "image-large-v1";
  queueEpoch: string;
  queueGeneration: number;
  sessionHash: string;
  networkHash: string;
  dayKey: string;
  reservedUnits: number;
  accumulatedActualUnits: number;
  processedInputBytes: number;
  processedPixels: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  peakMemoryBytes: number;
  queuedAt: number;
  startedAt: number;
  createdAt: number;
  cancelRequestedAt: number | null;
}

const claimedQueueJobRowSchema = z
  .object({
    id: canonicalUuidSchema,
    contract_id: z.literal("image.optimize@1"),
    spec_json: z.string().min(1).max(16_384),
    spec_hash: hashSchema,
    declared_bytes: positiveSafeIntegerSchema.max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
    declared_mime: imageOptimizeMimeSchema,
    input_key: z.string().regex(INPUT_KEY_PATTERN),
    input_etag: storedObjectEtagSchema,
    output_key: z.string().regex(OUTPUT_KEY_PATTERN),
    resource_class: z.enum(["image-standard-v1", "image-large-v1"]),
    attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    queue_epoch: canonicalUuidSchema,
    queue_generation: nonnegativeSafeIntegerSchema,
    lease_token: canonicalUuidSchema,
    lease_expires_at: positiveSafeIntegerSchema,
    session_hash: hashSchema,
    network_hash: hashSchema,
    day_key: dayKeySchema,
    reserved_units: positiveSafeIntegerSchema,
    actual_units: nonnegativeSafeIntegerSchema.nullable(),
    processed_input_bytes: nonnegativeSafeIntegerSchema,
    processed_pixels: nonnegativeSafeIntegerSchema,
    cpu_ms: nonnegativeSafeIntegerSchema.nullable(),
    memory_byte_milliseconds: nonnegativeSafeIntegerSchema.nullable(),
    peak_memory_bytes: nonnegativeSafeIntegerSchema.nullable(),
    queued_at: nonnegativeSafeIntegerSchema,
    started_at: nonnegativeSafeIntegerSchema,
    created_at: nonnegativeSafeIntegerSchema,
    cancel_requested_at: nonnegativeSafeIntegerSchema.nullable(),
  })
  .strict();

const claimedQueueJobColumns = `
  id,
  contract_id,
  spec_json,
  spec_hash,
  declared_bytes,
  declared_mime,
  input_key,
  input_etag,
  output_key,
  resource_class,
  attempt,
  queue_epoch,
  queue_generation,
  lease_token,
  lease_expires_at,
  session_hash,
  network_hash,
  day_key,
  reserved_units,
  actual_units,
  processed_input_bytes,
  processed_pixels,
  cpu_ms,
  memory_byte_milliseconds,
  peak_memory_bytes,
  queued_at,
  started_at,
  created_at,
  cancel_requested_at
`;

function toClaimedQueueJob(row: z.infer<typeof claimedQueueJobRowSchema>): ClaimedQueueJob {
  return {
    jobId: row.id,
    contractId: row.contract_id,
    specJson: row.spec_json,
    specHash: row.spec_hash,
    declaredBytes: row.declared_bytes,
    declaredMime: row.declared_mime,
    inputKey: row.input_key,
    inputEtag: row.input_etag,
    outputKey: row.output_key,
    resourceClass: row.resource_class,
    attempt: row.attempt,
    queueEpoch: row.queue_epoch,
    queueGeneration: row.queue_generation,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    sessionHash: row.session_hash,
    networkHash: row.network_hash,
    dayKey: row.day_key,
    reservedUnits: row.reserved_units,
    accumulatedActualUnits: row.actual_units ?? 0,
    processedInputBytes: row.processed_input_bytes,
    processedPixels: row.processed_pixels,
    cpuMs: row.cpu_ms ?? 0,
    memoryByteMilliseconds: row.memory_byte_milliseconds ?? 0,
    peakMemoryBytes: row.peak_memory_bytes ?? 0,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    createdAt: row.created_at,
    cancelRequestedAt: row.cancel_requested_at,
  };
}

function validateClaimInput(jobId: string, now: number): void {
  validateCanonicalUuid(jobId, "jobId");
  checkedNonnegativeSafeInteger(now, "now");
  if (now > Number.MAX_SAFE_INTEGER - PROCESSING_DEADLINE_MS) {
    throw new RangeError("Claim time is too large.");
  }
}

/**
 * Atomically acquires a random fenced lease and reads the winning row through one first-primary
 * session. A concurrent claimant can never receive the winning token.
 */
export async function claimQueuedJobRecord(
  database: D1Database,
  jobId: string,
  now: number,
): Promise<ClaimedQueueJob | null> {
  validateClaimInput(jobId, now);
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = now + 30_000;
  const processingDeadlineAt = now + PROCESSING_DEADLINE_MS;
  const session = database.withSession("first-primary");
  const results = await session.batch([
    session
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             phase = 'validating',
             lease_token = ?,
             lease_expires_at = ?,
             started_at = COALESCE(started_at, ?),
             processing_deadline_at = COALESCE(processing_deadline_at, ?),
             updated_at = ?
         WHERE id = ?
           AND settlement_state = 'reserved'
           AND input_etag IS NOT NULL
           AND cancel_requested_at IS NULL
           AND (
             status = 'queued'
             OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )`,
      )
      .bind(leaseToken, leaseExpiresAt, now, processingDeadlineAt, now, jobId, now),
    session
      .prepare(
        `SELECT ${claimedQueueJobColumns}
         FROM jobs
         WHERE id = ? AND lease_token = ?`,
      )
      .bind(jobId, leaseToken),
  ]);
  const changed = batchChanged(results[0], "Queue job claim");
  if (changed > 1) throw new RepositoryIntegrityError("Queue claim changed multiple jobs.");
  const rawRow = results[1]?.results[0];
  if (changed === 0) {
    if (rawRow !== undefined) {
      throw new RepositoryIntegrityError("Losing queue claim unexpectedly read its lease token.");
    }
    return null;
  }
  const parsed = claimedQueueJobRowSchema.safeParse(rawRow);
  if (!parsed.success) {
    throw new RepositoryIntegrityError("Claimed queue row does not match the repository contract.");
  }
  let spec: unknown;
  try {
    spec = JSON.parse(parsed.data.spec_json);
  } catch {
    throw new RepositoryIntegrityError("Claimed queue spec is not valid JSON.");
  }
  const parsedSpec = imageOptimizeSpecV1Schema.safeParse(spec);
  if (
    !parsedSpec.success ||
    JSON.stringify(parsedSpec.data) !== parsed.data.spec_json ||
    (await sha256Hex(parsed.data.spec_json)) !== parsed.data.spec_hash
  ) {
    throw new RepositoryIntegrityError("Claimed queue spec is invalid.");
  }
  return toClaimedQueueJob(parsed.data);
}

export async function claimQueuedJob(
  database: D1Database,
  jobId: string,
  now: number,
): Promise<JobLease | null> {
  const claimed = await claimQueuedJobRecord(database, jobId, now);
  if (claimed === null) return null;
  return {
    jobId: claimed.jobId,
    leaseToken: claimed.leaseToken,
    attempt: claimed.attempt,
    leaseExpiresAt: claimed.leaseExpiresAt,
  };
}
