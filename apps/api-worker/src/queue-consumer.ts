import {
  type EngineCreateJobRequest,
  type EngineCreatePdfJobRequest,
  type EngineInspectionSummary,
  type EngineJobStatus,
  type EngineMeasurements,
  engineJobStatusSchema,
  type ImageJobMessage,
  type ImageResourceClass,
  imageJobMessageSchema,
  type PdfEngineInspectionSummary,
  type PdfEngineJobStatus,
  type PdfEngineMeasurements,
  type PdfJobMessage,
  pdfEngineJobStatusSchema,
  pdfJobMessageSchema,
  type ServerJobMessage,
} from "@hereisit/server-contracts";
import {
  calculateAttemptChargedUnits,
  calculateSettledWeightedUnits,
  estimateAttemptReservation,
  validateEngineAttempt,
} from "@hereisit/server-job";
import {
  type ImageOptimizeMime,
  type ImageOptimizeSpecV1,
  imageOptimizeSpecV1Schema,
  type ToolJobErrorCode,
} from "@hereisit/tool-contracts";
import {
  type PdfOptimizeSpecV1,
  pdfOptimizeSpecV1Schema,
} from "@hereisit/tool-contracts/pdf-optimize";
import { recordContainerActivity } from "./container-activity";
import {
  createContainerEngineClient,
  createContainerPdfEngineClient,
  type EngineClient,
  EngineCrashError,
  EngineHttpError,
  EngineProtocolError,
  type PdfEngineClient,
} from "./container-client";
import { claimQueuedJobRecord } from "./d1-job-repository";
import type { Env } from "./env";
import { prepareOperationalCounter } from "./operational-counters";
import { emitSafeProcessingEvent, sessionHashPrefix } from "./telemetry";

const LEASE_RENEW_INTERVAL_MS = 5_000;
const LEASE_DURATION_MS = 30_000;
const RESULT_RETENTION_MS = 30 * 60_000;
const TERMINAL_RECORD_RETENTION_MS = 24 * 60 * 60_000;
const NETWORK_HASH_RETENTION_MS = 48 * 60 * 60_000;
const MAX_POLL_COUNT = 4_800;
const POLL_INTERVAL_MS = 250;

export class EngineTimeoutError extends Error {
  constructor() {
    super("ENGINE_TIMEOUT");
    this.name = "EngineTimeoutError";
  }
}

export class CodecCandidateTimeoutError extends Error {
  constructor() {
    super("ENGINE_TIMEOUT");
    this.name = "CodecCandidateTimeoutError";
  }
}

export class EngineOomError extends Error {
  constructor() {
    super("ENGINE_OOM");
    this.name = "EngineOomError";
  }
}

export class ResourceClassUpgradeError extends Error {
  constructor() {
    super("RESOURCE_CLASS_UPGRADE");
    this.name = "ResourceClassUpgradeError";
  }
}

export class UnsupportedInputError extends Error {
  constructor() {
    super("UNSUPPORTED_INPUT");
    this.name = "UnsupportedInputError";
  }
}

class PermanentEngineError extends Error {
  readonly publicCode: ToolJobErrorCode;

  constructor(publicCode: ToolJobErrorCode) {
    super(publicCode);
    this.name = "PermanentEngineError";
    this.publicCode = publicCode;
  }
}

export class StorageFailureError extends Error {
  constructor() {
    super("STORAGE_FAILURE");
    this.name = "StorageFailureError";
  }
}

export class VerificationFailureError extends Error {
  constructor() {
    super("VERIFICATION_FAILED");
    this.name = "VerificationFailureError";
  }
}

export class UploadMismatchError extends Error {
  constructor() {
    super("UPLOAD_MISMATCH");
    this.name = "UploadMismatchError";
  }
}

export class CancelledProcessingError extends Error {
  constructor() {
    super("CANCELLED");
    this.name = "CancelledProcessingError";
  }
}

class StaleLeaseError extends Error {
  constructor() {
    super("STALE_LEASE");
    this.name = "StaleLeaseError";
  }
}

export type QueueFailureClassification =
  | {
      retry: true;
      delaySeconds: 0 | 10 | 30 | 120;
      nextResourceClass: ImageResourceClass | "pdf-standard-v1";
    }
  | {
      retry: false;
      publicCode: ToolJobErrorCode;
      publicGuidance?: "TRY_BALANCED_PRESET";
    };

function retryDelay(attempt: 1 | 2 | 3): 10 | 30 | 120 {
  if (attempt === 1) return 10;
  if (attempt === 2) return 30;
  return 120;
}

export function classifyQueueFailure(
  error: unknown,
  input: {
    attempt: 1 | 2 | 3;
    resourceClass?: ImageResourceClass | "pdf-standard-v1";
  } = { attempt: 1 },
): QueueFailureClassification {
  const currentClass = input.resourceClass ?? "image-standard-v1";
  if (error instanceof CodecCandidateTimeoutError) {
    return {
      retry: false,
      publicCode: "ENGINE_TIMEOUT",
      publicGuidance: "TRY_BALANCED_PRESET",
    };
  }
  if (error instanceof UnsupportedInputError) {
    return { retry: false, publicCode: "UNSUPPORTED_INPUT" };
  }
  if (error instanceof PermanentEngineError) {
    return { retry: false, publicCode: error.publicCode };
  }
  if (error instanceof UploadMismatchError) {
    return { retry: false, publicCode: "UPLOAD_MISMATCH" };
  }
  if (error instanceof VerificationFailureError || error instanceof EngineProtocolError) {
    return { retry: false, publicCode: "VERIFICATION_FAILED" };
  }
  if (error instanceof CancelledProcessingError) {
    return { retry: false, publicCode: "CANCELLED" };
  }
  if (error instanceof ResourceClassUpgradeError) {
    if (input.attempt < 3 && currentClass === "image-standard-v1") {
      return { retry: true, delaySeconds: 0, nextResourceClass: "image-large-v1" };
    }
    return { retry: false, publicCode: "ENGINE_OOM" };
  }
  if (error instanceof EngineOomError) {
    if (input.attempt < 3) {
      return {
        retry: true,
        delaySeconds: retryDelay(input.attempt),
        nextResourceClass:
          currentClass === "pdf-standard-v1" ? "pdf-standard-v1" : "image-large-v1",
      };
    }
    return { retry: false, publicCode: "ENGINE_OOM" };
  }
  if (
    error instanceof EngineTimeoutError ||
    error instanceof EngineCrashError ||
    error instanceof EngineHttpError ||
    error instanceof StorageFailureError
  ) {
    if (input.attempt < 3) {
      return {
        retry: true,
        delaySeconds: retryDelay(input.attempt),
        nextResourceClass: currentClass,
      };
    }
    return {
      retry: false,
      publicCode:
        error instanceof StorageFailureError
          ? "STORAGE_FAILURE"
          : error instanceof EngineTimeoutError
            ? "ENGINE_TIMEOUT"
            : "ENGINE_CRASH",
    };
  }
  return { retry: false, publicCode: "ENGINE_CRASH" };
}

export interface QueueJobContext {
  jobId: string;
  contractId: "image.optimize@1" | "pdf.optimize@1";
  specHash: string;
  inputKey: string;
  inputEtag: string;
  outputKey: string;
  resourceClass: ImageResourceClass | "pdf-standard-v1";
  attempt: 1 | 2 | 3;
  queueEpoch: string;
  queueGeneration: number;
  leaseToken: string;
  leaseExpiresAt: number;
  declaredBytes: number;
  declaredMime: ImageOptimizeMime | "application/pdf";
  declaredPageCount?: number;
  spec: ImageOptimizeSpecV1 | PdfOptimizeSpecV1;
  sessionHash: string;
  networkHash?: string;
  dayKey?: string;
  reservedUnits: number;
  accumulatedActualUnits?: number;
  processedInputBytes?: number;
  processedPixels?: number;
  cpuMs?: number;
  memoryByteMilliseconds?: number;
  peakMemoryBytes?: number;
  queuedAt?: number;
  startedAt?: number;
  createdAt?: number;
  cancelRequestedAt?: number | null;
}

type AnyEngineStatus = EngineJobStatus | PdfEngineJobStatus;
type AnyEngineMeasurements = EngineMeasurements | PdfEngineMeasurements;
type AnyEngineInspection = EngineInspectionSummary | PdfEngineInspectionSummary;
interface ServerEngineClient {
  create(request: EngineCreateJobRequest | EngineCreatePdfJobRequest): Promise<{
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
  status(jobId: string): Promise<AnyEngineStatus>;
  output(jobId: string): Promise<Response>;
  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export interface QueueJobStore {
  claim(message: ServerJobMessage, now: number): Promise<QueueJobContext | null>;
  renew(context: QueueJobContext, now: number): Promise<boolean>;
  isCancellationRequested(context: QueueJobContext): Promise<boolean>;
  markEngineContact(context: QueueJobContext, now: number): Promise<boolean>;
  recordStartup(
    context: QueueJobContext,
    now: number,
    startup: { coldStart: boolean; containerReadyMs: number },
  ): Promise<boolean>;
  mirrorProgress(
    context: QueueJobContext,
    status: Extract<AnyEngineStatus, { state: "running" }>,
    now: number,
  ): Promise<boolean>;
  settleSuccess(
    context: QueueJobContext,
    status: Extract<AnyEngineStatus, { state: "succeeded" }>,
    now: number,
  ): Promise<boolean>;
  settleFailure(
    context: QueueJobContext,
    failure: {
      code: ToolJobErrorCode;
      guidance?: "TRY_BALANCED_PRESET" | undefined;
      measurements?: AnyEngineMeasurements | undefined;
      inspection?: AnyEngineInspection | null | undefined;
    },
    now: number,
  ): Promise<boolean>;
  scheduleRetry(
    context: QueueJobContext,
    input: {
      nextResourceClass: ImageResourceClass | "pdf-standard-v1";
      delaySeconds: 0 | 10 | 30 | 120;
      measurements?: AnyEngineMeasurements | undefined;
      verifiedMime?: ImageOptimizeMime | "application/pdf" | undefined;
    },
    now: number,
  ): Promise<boolean | null>;
  adoptAuthoritativeDelivery(context: QueueJobContext, now: number): Promise<void>;
  releaseStale(context: QueueJobContext, now: number): Promise<void>;
  quarantine(message: ServerJobMessage, now: number, attempts: number): Promise<void>;
}

export interface InputArtifact {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly etag: string;
  readonly httpMetadata?: { readonly contentType?: string } | undefined;
}

export interface OutputArtifactHead {
  readonly size: number;
  readonly mime: string | undefined;
  readonly kind: string | undefined;
  readonly jobId: string | undefined;
  readonly sha256: string | undefined;
  readonly engineBuildId: string | undefined;
  readonly recoveryStatus?: Extract<AnyEngineStatus, { state: "succeeded" }> | null;
}

export interface QueueArtifactStore {
  getInput(key: string, etag: string): Promise<InputArtifact | null>;
  headOutput(key: string): Promise<OutputArtifactHead | null>;
  storeOutput(input: {
    key: string;
    body: ReadableStream<Uint8Array>;
    byteLength: number;
    mime: ImageOptimizeMime | "application/pdf";
    digestHeader: string;
    jobId: string;
    engineBuildId: string;
    recoveryStatus: Extract<AnyEngineStatus, { state: "succeeded" }>;
  }): Promise<void>;
  deleteInput(key: string): Promise<void>;
  deleteOutput(key: string): Promise<void>;
}

export interface QueueConsumerDependencies {
  engine?: EngineClient;
  pdfEngine?: PdfEngineClient;
  store?: QueueJobStore;
  artifacts?: QueueArtifactStore;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseHeartbeat?: boolean;
  recordEngineActivity?: (contactedAt: number) => Promise<void>;
}

function d1Changed(result: D1Result<unknown> | undefined): number {
  if (result === undefined) throw new StorageFailureError();
  if (!result.success) throw new StorageFailureError();
  return result.meta.changes ?? result.meta.rows_written ?? 0;
}

function strictLimit(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${label} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} is invalid.`);
  return parsed;
}

function sampleFromMeasurements(
  context: QueueJobContext,
  measurements: AnyEngineMeasurements,
  outputBytes: number | null,
  mime: ImageOptimizeMime | "application/pdf" = context.declaredMime,
) {
  return {
    inputBytes: measurements.processedInputBytes,
    outputBytes,
    pixels: "processedPixels" in measurements ? measurements.processedPixels : 0,
    cpuMs: measurements.cpuMs,
    memoryByteMilliseconds: measurements.memoryByteMilliseconds,
    testedCandidates: measurements.testedCandidates,
    mime,
  } as const;
}

class D1QueueJobStore implements QueueJobStore {
  constructor(private readonly env: Env) {}

  async claim(message: ServerJobMessage, now: number): Promise<QueueJobContext | null> {
    const row = await claimQueuedJobRecord(this.env.DB, message.jobId, now);
    if (row === null) return null;
    if (row.contractId !== message.contractId) {
      throw new VerificationFailureError();
    }
    const spec =
      row.contractId === "pdf.optimize@1"
        ? pdfOptimizeSpecV1Schema.parse(JSON.parse(row.specJson))
        : imageOptimizeSpecV1Schema.parse(JSON.parse(row.specJson));
    return {
      jobId: row.jobId,
      contractId: row.contractId,
      specHash: row.specHash,
      inputKey: row.inputKey,
      inputEtag: row.inputEtag,
      outputKey: row.outputKey,
      resourceClass: row.resourceClass,
      attempt: row.attempt,
      queueEpoch: row.queueEpoch,
      queueGeneration: row.queueGeneration,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
      declaredBytes: row.declaredBytes,
      declaredMime: row.declaredMime,
      ...(row.contractId === "pdf.optimize@1" ? { declaredPageCount: row.declaredPageCount } : {}),
      spec,
      sessionHash: row.sessionHash,
      networkHash: row.networkHash,
      dayKey: row.dayKey,
      reservedUnits: row.reservedUnits,
      accumulatedActualUnits: row.accumulatedActualUnits,
      processedInputBytes: row.processedInputBytes,
      processedPixels: row.processedPixels,
      cpuMs: row.cpuMs,
      memoryByteMilliseconds: row.memoryByteMilliseconds,
      peakMemoryBytes: row.peakMemoryBytes,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt,
      createdAt: row.createdAt,
      cancelRequestedAt: row.cancelRequestedAt,
    };
  }

  async renew(context: QueueJobContext, now: number): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE jobs
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_token = ? AND cancel_requested_at IS NULL`,
    )
      .bind(now + LEASE_DURATION_MS, now, context.jobId, context.leaseToken)
      .run();
    return d1Changed(result) === 1;
  }

  async isCancellationRequested(context: QueueJobContext): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT cancel_requested_at
       FROM jobs
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_token = ?`,
    )
      .bind(context.jobId, context.leaseToken)
      .first<{ cancel_requested_at: number | null }>();
    return row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined;
  }

  async markEngineContact(context: QueueJobContext, now: number): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE jobs
       SET engine_contact_started_at = COALESCE(engine_contact_started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_token = ? AND cancel_requested_at IS NULL`,
    )
      .bind(now, now, context.jobId, context.leaseToken)
      .run();
    return d1Changed(result) === 1;
  }

  async recordStartup(
    context: QueueJobContext,
    now: number,
    startup: { coldStart: boolean; containerReadyMs: number },
  ): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE jobs
       SET cold_start = CASE WHEN cold_start = 1 OR ? = 1 THEN 1 ELSE 0 END,
           container_ready_ms = ?,
           updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_token = ? AND cancel_requested_at IS NULL`,
    )
      .bind(
        startup.coldStart ? 1 : 0,
        startup.containerReadyMs,
        now,
        context.jobId,
        context.leaseToken,
      )
      .run();
    return d1Changed(result) === 1;
  }

  async mirrorProgress(
    context: QueueJobContext,
    status: Extract<AnyEngineStatus, { state: "running" }>,
    now: number,
  ): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE jobs
       SET phase = ?, phase_fraction = ?, phase_sequence = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
         AND lease_token = ? AND cancel_requested_at IS NULL AND phase_sequence < ?`,
    )
      .bind(
        status.phase,
        status.fraction,
        status.sequence,
        now,
        context.jobId,
        context.leaseToken,
        status.sequence,
      )
      .run();
    const changed = d1Changed(result);
    if (changed === 1) return true;
    return this.renew(context, now);
  }

  async settleSuccess(
    context: QueueJobContext,
    status: Extract<AnyEngineStatus, { state: "succeeded" }>,
    now: number,
  ): Promise<boolean> {
    const outputBytes = status.result.kind === "download" ? status.result.byteLength : null;
    const actualUnits =
      (context.accumulatedActualUnits ?? 0) +
      calculateSettledWeightedUnits([
        sampleFromMeasurements(
          context,
          status.measurements,
          outputBytes,
          status.inspection.verifiedInputMime,
        ),
      ]);
    if (
      (context.contractId === "pdf.optimize@1") !==
      (status.inspection.verifiedInputMime === "application/pdf")
    ) {
      throw new VerificationFailureError();
    }
    const isPdf = context.contractId === "pdf.optimize@1";
    const pdfResult = isPdf && "pageCount" in status.result ? status.result : null;
    return this.settleTerminal(context, {
      now,
      state: "succeeded",
      actualUnits,
      measurements: status.measurements,
      verifiedMime: status.inspection.verifiedInputMime,
      inputHasAlpha: "inputHasAlpha" in status.inspection ? status.inspection.inputHasAlpha : null,
      contentClass: "contentClass" in status.inspection ? status.inspection.contentClass : null,
      resultKind: status.result.kind,
      outputBytes,
      outputMime: status.result.kind === "download" ? status.result.mime : null,
      outputWidth:
        status.result.kind === "download" && "width" in status.result ? status.result.width : null,
      outputHeight:
        status.result.kind === "download" && "height" in status.result
          ? status.result.height
          : null,
      outputPageCount: pdfResult?.pageCount ?? null,
      pdfProfile: pdfResult?.kind === "download" ? pdfResult.profile : null,
      engineBuildId: status.result.engineBuildId,
      codecBuildId: "codecBuildId" in status.result ? status.result.codecBuildId : null,
      warningsJson: JSON.stringify(status.result.warnings),
      testedCandidates:
        "testedCandidates" in status.result
          ? status.result.testedCandidates
          : status.measurements.testedCandidates,
      errorCode: null,
      errorGuidance: null,
    });
  }

  async settleFailure(
    context: QueueJobContext,
    failure: {
      code: ToolJobErrorCode;
      guidance?: "TRY_BALANCED_PRESET";
      measurements?: AnyEngineMeasurements | undefined;
      inspection?: AnyEngineInspection | null | undefined;
    },
    now: number,
  ): Promise<boolean> {
    const measuredUnits = failure.measurements
      ? calculateSettledWeightedUnits([
          sampleFromMeasurements(
            context,
            failure.measurements,
            null,
            failure.inspection?.verifiedInputMime,
          ),
        ])
      : calculateSettledWeightedUnits([]);
    return this.settleTerminal(context, {
      now,
      state: failure.code === "CANCELLED" ? "cancelled" : "failed",
      actualUnits: (context.accumulatedActualUnits ?? 0) + measuredUnits,
      measurements: failure.measurements,
      verifiedMime: failure.inspection?.verifiedInputMime ?? null,
      inputHasAlpha:
        failure.inspection !== null &&
        failure.inspection !== undefined &&
        "inputHasAlpha" in failure.inspection
          ? failure.inspection.inputHasAlpha
          : null,
      contentClass:
        failure.inspection !== null &&
        failure.inspection !== undefined &&
        "contentClass" in failure.inspection
          ? failure.inspection.contentClass
          : null,
      resultKind: null,
      outputBytes: null,
      outputMime: null,
      outputWidth: null,
      outputHeight: null,
      outputPageCount: null,
      pdfProfile: null,
      engineBuildId: null,
      codecBuildId: null,
      warningsJson: null,
      testedCandidates: failure.measurements?.testedCandidates ?? null,
      errorCode: failure.code,
      errorGuidance: failure.guidance ?? null,
    });
  }

  private async settleTerminal(
    context: QueueJobContext,
    terminal: {
      now: number;
      state: "succeeded" | "failed" | "cancelled";
      actualUnits: number;
      measurements?: AnyEngineMeasurements | undefined;
      verifiedMime: string | null;
      inputHasAlpha: boolean | null;
      contentClass: string | null;
      resultKind: string | null;
      outputBytes: number | null;
      outputMime: string | null;
      outputWidth: number | null;
      outputHeight: number | null;
      outputPageCount: number | null;
      pdfProfile: "structural" | "image-optimized" | null;
      engineBuildId: string | null;
      codecBuildId: string | null;
      warningsJson: string | null;
      testedCandidates: number | null;
      errorCode: string | null;
      errorGuidance: string | null;
    },
  ): Promise<boolean> {
    const terminalExpiry = terminal.now + TERMINAL_RECORD_RETENTION_MS;
    const resultExpiry =
      terminal.state === "succeeded" && terminal.resultKind === "download"
        ? terminal.now + RESULT_RETENTION_MS
        : null;
    const networkExpiry = Math.min(
      terminalExpiry,
      (context.createdAt ?? terminal.now) + NETWORK_HASH_RETENTION_MS,
    );
    const terminalMarker = `EXISTS (
      SELECT 1 FROM jobs
      JOIN usage_ledger ON usage_ledger.job_id = jobs.id
      WHERE jobs.id = ? AND jobs.status = ? AND jobs.settlement_state = 'settled'
        AND jobs.actual_units = ? AND jobs.finished_at = ? AND usage_ledger.settled_at IS NULL
    )`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE jobs
           SET status = ?, phase = 'completed', phase_fraction = 1,
               phase_sequence = phase_sequence + 1,
               verified_input_mime = COALESCE(?, verified_input_mime),
               input_has_alpha = COALESCE(?, input_has_alpha),
               content_class = COALESCE(?, content_class),
               output_bytes = ?, output_mime = ?, output_width = ?, output_height = ?,
               output_page_count = ?, pdf_profile = ?,
               result_kind = ?, actual_units = ?,
               cpu_ms = COALESCE(cpu_ms, 0) + ?,
               memory_byte_milliseconds = COALESCE(memory_byte_milliseconds, 0) + ?,
               peak_memory_bytes = MAX(COALESCE(peak_memory_bytes, 0), ?),
               processed_input_bytes = processed_input_bytes + ?,
               processed_pixels = processed_pixels + ?,
               engine_build_id = ?, codec_build_id = ?, warnings_json = ?,
               tested_candidates = ?, error_code = ?, error_guidance = ?,
               settlement_state = 'settled', lease_token = NULL, lease_expires_at = NULL,
               result_expires_at = ?, terminal_record_expires_at = ?,
               network_hash_expires_at = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
             AND lease_token = ?
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
      ).bind(
        terminal.state,
        terminal.verifiedMime,
        terminal.inputHasAlpha === null ? null : terminal.inputHasAlpha ? 1 : 0,
        terminal.contentClass,
        terminal.outputBytes,
        terminal.outputMime,
        terminal.outputWidth,
        terminal.outputHeight,
        terminal.outputPageCount,
        terminal.pdfProfile,
        terminal.resultKind,
        terminal.actualUnits,
        terminal.measurements?.cpuMs ?? 0,
        terminal.measurements?.memoryByteMilliseconds ?? 0,
        terminal.measurements?.peakMemoryBytes ?? 0,
        terminal.measurements?.processedInputBytes ?? 0,
        terminal.measurements !== undefined && "processedPixels" in terminal.measurements
          ? terminal.measurements.processedPixels
          : 0,
        terminal.engineBuildId,
        terminal.codecBuildId,
        terminal.warningsJson,
        terminal.testedCandidates,
        terminal.errorCode,
        terminal.errorGuidance,
        resultExpiry,
        terminalExpiry,
        networkExpiry,
        terminal.now,
        terminal.now,
        context.jobId,
        context.leaseToken,
      ),
      this.env.DB.prepare(
        `UPDATE account_usage
           SET reserved_units = reserved_units - ?, settled_units = settled_units + ?,
               pending_jobs = pending_jobs - 1, updated_at = ?
           WHERE day_key = ? AND reserved_units >= ? AND pending_jobs > 0
             AND ${terminalMarker}`,
      ).bind(
        context.reservedUnits,
        terminal.actualUnits,
        terminal.now,
        context.dayKey,
        context.reservedUnits,
        context.jobId,
        terminal.state,
        terminal.actualUnits,
        terminal.now,
      ),
      this.env.DB.prepare(
        `UPDATE anonymous_usage
           SET reserved_units = reserved_units - ?, settled_units = settled_units + ?,
               active_jobs = active_jobs - 1, updated_at = ?
           WHERE session_hash = ? AND day_key = ? AND reserved_units >= ? AND active_jobs > 0
             AND ${terminalMarker}`,
      ).bind(
        context.reservedUnits,
        terminal.actualUnits,
        terminal.now,
        context.sessionHash,
        context.dayKey,
        context.reservedUnits,
        context.jobId,
        terminal.state,
        terminal.actualUnits,
        terminal.now,
      ),
      this.env.DB.prepare(
        `UPDATE network_usage
           SET reserved_units = reserved_units - ?, settled_units = settled_units + ?,
               pending_jobs = pending_jobs - 1, updated_at = ?
           WHERE network_hash = ? AND day_key = ? AND reserved_units >= ? AND pending_jobs > 0
             AND ${terminalMarker}`,
      ).bind(
        context.reservedUnits,
        terminal.actualUnits,
        terminal.now,
        context.networkHash,
        context.dayKey,
        context.reservedUnits,
        context.jobId,
        terminal.state,
        terminal.actualUnits,
        terminal.now,
      ),
      this.env.DB.prepare(
        `UPDATE usage_ledger
           SET actual_units = ?, outcome = ?, settled_at = ?
           WHERE job_id = ? AND settled_at IS NULL
             AND EXISTS (
               SELECT 1 FROM jobs
               WHERE jobs.id = usage_ledger.job_id AND jobs.status = ?
                 AND jobs.settlement_state = 'settled' AND jobs.actual_units = ?
                 AND jobs.finished_at = ?
             )`,
      ).bind(
        terminal.actualUnits,
        terminal.state,
        terminal.now,
        context.jobId,
        terminal.state,
        terminal.actualUnits,
        terminal.now,
      ),
    ]);
    const jobChanged = d1Changed(results[0]);
    if (jobChanged === 0) return false;
    if (jobChanged !== 1 || results.slice(1, 5).some((result) => d1Changed(result) !== 1)) {
      throw new StorageFailureError();
    }
    return true;
  }

  async scheduleRetry(
    context: QueueJobContext,
    input: {
      nextResourceClass: ImageResourceClass | "pdf-standard-v1";
      delaySeconds: 0 | 10 | 30 | 120;
      measurements?: AnyEngineMeasurements | undefined;
      verifiedMime?: ImageOptimizeMime | "application/pdf" | undefined;
    },
    now: number,
  ): Promise<boolean | null> {
    if (context.attempt >= 3) return null;
    const nextAttempt = (context.attempt + 1) as 2 | 3;
    const nextGeneration = context.queueGeneration + 1;
    const extraReservation = estimateAttemptReservation({
      inputBytes: context.declaredBytes,
      resourceClass:
        input.nextResourceClass === "pdf-standard-v1"
          ? "image-standard-v1"
          : input.nextResourceClass,
    });
    const chargedAttempt = input.measurements
      ? calculateAttemptChargedUnits(
          sampleFromMeasurements(context, input.measurements, null, input.verifiedMime),
        )
      : calculateAttemptChargedUnits({
          inputBytes: 0,
          outputBytes: null,
          pixels: 0,
          cpuMs: 0,
          memoryByteMilliseconds: 0,
          testedCandidates: 0,
          mime: context.declaredMime,
        });
    const messageCommon = {
      jobId: context.jobId,
      specHash: context.specHash,
      inputKey: context.inputKey,
      inputEtag: context.inputEtag,
      outputKey: context.outputKey,
      attempt: nextAttempt,
      queueEpoch: context.queueEpoch,
      queueGeneration: nextGeneration,
    };
    const nextMessage: ServerJobMessage =
      context.contractId === "pdf.optimize@1"
        ? { ...messageCommon, contractId: context.contractId, resourceClass: "pdf-standard-v1" }
        : {
            ...messageCommon,
            contractId: context.contractId,
            resourceClass:
              input.nextResourceClass === "pdf-standard-v1"
                ? context.resourceClass === "pdf-standard-v1"
                  ? "image-standard-v1"
                  : context.resourceClass
                : input.nextResourceClass,
          };
    const accountLimit = strictLimit(
      this.env.ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT,
      "ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT",
    );
    const anonymousLimit = strictLimit(
      this.env.ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT,
      "ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT",
    );
    const networkLimit = strictLimit(
      this.env.NETWORK_DAILY_WEIGHTED_UNIT_LIMIT,
      "NETWORK_DAILY_WEIGHTED_UNIT_LIMIT",
    );
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE jobs
           SET status = 'queued', phase = 'queued', phase_fraction = NULL,
               resource_class = ?, attempt = ?, queue_generation = ?,
               reserved_units = reserved_units + ?,
               actual_units = COALESCE(actual_units, 0) + ?,
               cpu_ms = COALESCE(cpu_ms, 0) + ?,
               memory_byte_milliseconds = COALESCE(memory_byte_milliseconds, 0) + ?,
               peak_memory_bytes = MAX(COALESCE(peak_memory_bytes, 0), ?),
               processed_input_bytes = processed_input_bytes + ?,
               processed_pixels = processed_pixels + ?,
               lease_token = NULL, lease_expires_at = NULL, queued_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND settlement_state = 'reserved'
             AND lease_token = ? AND cancel_requested_at IS NULL
             AND (SELECT reserved_units + settled_units FROM account_usage WHERE day_key = ?) + ? <= ?
             AND (SELECT reserved_units + settled_units FROM anonymous_usage
                  WHERE session_hash = ? AND day_key = ?) + ? <= ?
             AND (SELECT reserved_units + settled_units FROM network_usage
                  WHERE network_hash = ? AND day_key = ?) + ? <= ?`,
      ).bind(
        input.nextResourceClass,
        nextAttempt,
        nextGeneration,
        extraReservation,
        chargedAttempt,
        input.measurements?.cpuMs ?? 0,
        input.measurements?.memoryByteMilliseconds ?? 0,
        input.measurements?.peakMemoryBytes ?? 0,
        input.measurements?.processedInputBytes ?? 0,
        input.measurements !== undefined && "processedPixels" in input.measurements
          ? input.measurements.processedPixels
          : 0,
        now,
        now,
        context.jobId,
        context.leaseToken,
        context.dayKey,
        extraReservation,
        accountLimit,
        context.sessionHash,
        context.dayKey,
        extraReservation,
        anonymousLimit,
        context.networkHash,
        context.dayKey,
        extraReservation,
        networkLimit,
      ),
      this.env.DB.prepare(
        `UPDATE account_usage SET reserved_units = reserved_units + ?, updated_at = ?
           WHERE day_key = ? AND EXISTS (
             SELECT 1 FROM jobs WHERE id = ? AND status = 'queued'
               AND queue_generation = ? AND lease_token IS NULL
           )`,
      ).bind(extraReservation, now, context.dayKey, context.jobId, nextGeneration),
      this.env.DB.prepare(
        `UPDATE anonymous_usage SET reserved_units = reserved_units + ?, updated_at = ?
           WHERE session_hash = ? AND day_key = ? AND EXISTS (
             SELECT 1 FROM jobs WHERE id = ? AND status = 'queued'
               AND queue_generation = ? AND lease_token IS NULL
           )`,
      ).bind(
        extraReservation,
        now,
        context.sessionHash,
        context.dayKey,
        context.jobId,
        nextGeneration,
      ),
      this.env.DB.prepare(
        `UPDATE network_usage SET reserved_units = reserved_units + ?, updated_at = ?
           WHERE network_hash = ? AND day_key = ? AND EXISTS (
             SELECT 1 FROM jobs WHERE id = ? AND status = 'queued'
               AND queue_generation = ? AND lease_token IS NULL
           )`,
      ).bind(
        extraReservation,
        now,
        context.networkHash,
        context.dayKey,
        context.jobId,
        nextGeneration,
      ),
      this.env.DB.prepare(
        `INSERT INTO job_outbox (
             job_id, payload, attempts, next_attempt_at, sent_at, reconciled_at
           )
           SELECT ?, ?, 0, ?, NULL, NULL
           WHERE EXISTS (
             SELECT 1 FROM jobs WHERE id = ? AND status = 'queued'
               AND queue_generation = ? AND lease_token IS NULL
           )
           ON CONFLICT(job_id) DO UPDATE SET
             payload = excluded.payload, attempts = 0,
             next_attempt_at = excluded.next_attempt_at, sent_at = NULL,
             reconciled_at = NULL`,
      ).bind(
        context.jobId,
        JSON.stringify(nextMessage),
        now + input.delaySeconds * 1_000,
        context.jobId,
        nextGeneration,
      ),
    ]);
    if (d1Changed(results[0]) !== 1) return null;
    if (results.slice(1, 5).some((result) => d1Changed(result) !== 1)) {
      throw new StorageFailureError();
    }
    try {
      await (context.contractId === "pdf.optimize@1"
        ? this.env.PDF_JOBS
        : this.env.IMAGE_JOBS
      ).send(nextMessage, {
        contentType: "json",
        delaySeconds: input.delaySeconds,
      });
    } catch {
      return false;
    }
    const marked = await this.env.DB.prepare(
      `UPDATE job_outbox SET sent_at = ?
       WHERE job_id = ? AND payload = ? AND sent_at IS NULL`,
    )
      .bind(now, context.jobId, JSON.stringify(nextMessage))
      .run();
    if (d1Changed(marked) !== 1) throw new StorageFailureError();
    return true;
  }

  async adoptAuthoritativeDelivery(context: QueueJobContext, now: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE job_outbox SET sent_at = COALESCE(sent_at, ?)
       WHERE job_id = ? AND EXISTS (
         SELECT 1 FROM jobs
         WHERE id = ? AND status = 'running' AND lease_token = ?
           AND queue_generation = ? AND attempt = ? AND resource_class = ?
       )`,
    )
      .bind(
        now,
        context.jobId,
        context.jobId,
        context.leaseToken,
        context.queueGeneration,
        context.attempt,
        context.resourceClass,
      )
      .run();
  }

  async releaseStale(context: QueueJobContext, now: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE jobs SET status = 'queued', phase = 'queued', phase_fraction = NULL,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND settlement_state = 'reserved' AND lease_token = ?`,
    )
      .bind(now, context.jobId, context.leaseToken)
      .run();
  }

  async quarantine(message: ServerJobMessage, now: number, attempts: number): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO job_quarantine (job_id, queue_name, attempt, error_code, quarantined_at)
       SELECT ?, ?, ?, 'QUEUE_RETRIES_EXHAUSTED', ?
       WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?)
       ON CONFLICT(job_id) DO UPDATE SET
         queue_name = excluded.queue_name,
         attempt = excluded.attempt,
         error_code = excluded.error_code,
         quarantined_at = excluded.quarantined_at`,
    )
      .bind(
        message.jobId,
        message.contractId === "pdf.optimize@1"
          ? this.env.PDF_JOBS_DLQ_NAME
          : this.env.IMAGE_JOBS_DLQ_NAME,
        Math.max(1, attempts),
        now,
        message.jobId,
      )
      .run();
  }
}

function base64Standard(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseDigestHeader(value: string): string {
  const match = /^sha-256=([A-Za-z0-9+/]{43}=)$/.exec(value);
  if (match?.[1] === undefined) throw new VerificationFailureError();
  return match[1];
}

class R2QueueArtifactStore implements QueueArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async getInput(key: string, etag: string): Promise<InputArtifact | null> {
    let object: R2ObjectBody | R2Object | null;
    try {
      object = await this.bucket.get(key, { onlyIf: { etagMatches: etag } });
    } catch {
      throw new StorageFailureError();
    }
    if (object === null || !("body" in object) || object.body === null) return null;
    return {
      body: object.body,
      size: object.size,
      etag: object.etag,
      httpMetadata: object.httpMetadata,
    };
  }

  async headOutput(key: string): Promise<OutputArtifactHead | null> {
    let head: R2Object | null;
    try {
      head = await this.bucket.head(key);
    } catch {
      throw new StorageFailureError();
    }
    if (head === null) return null;
    const encodedRecovery = head.customMetadata?.recoveryV1;
    let recoveryStatus: Extract<AnyEngineStatus, { state: "succeeded" }> | null | undefined;
    if (encodedRecovery !== undefined) {
      try {
        const value: unknown = JSON.parse(encodedRecovery);
        const image = engineJobStatusSchema.safeParse(value);
        const pdf = pdfEngineJobStatusSchema.safeParse(value);
        recoveryStatus =
          image.success && image.data.state === "succeeded"
            ? image.data
            : pdf.success && pdf.data.state === "succeeded"
              ? pdf.data
              : null;
      } catch {
        recoveryStatus = null;
      }
    }
    return {
      size: head.size,
      mime: head.httpMetadata?.contentType,
      kind: head.customMetadata?.kind,
      jobId: head.customMetadata?.jobId,
      sha256: head.customMetadata?.sha256,
      engineBuildId: head.customMetadata?.engineBuildId,
      ...(recoveryStatus !== undefined ? { recoveryStatus } : {}),
    };
  }

  async storeOutput(input: {
    key: string;
    body: ReadableStream<Uint8Array>;
    byteLength: number;
    mime: ImageOptimizeMime | "application/pdf";
    digestHeader: string;
    jobId: string;
    engineBuildId: string;
    recoveryStatus: Extract<AnyEngineStatus, { state: "succeeded" }>;
  }): Promise<void> {
    const expectedDigest = parseDigestHeader(input.digestHeader);
    const recoveryV1 = JSON.stringify(input.recoveryStatus);
    if (recoveryV1.length > 1_400) throw new VerificationFailureError();
    const fixed = new FixedLengthStream(input.byteLength);
    const DigestStreamConstructor = (
      crypto as unknown as {
        DigestStream: new (
          algorithm: string,
        ) => WritableStream<ArrayBuffer | ArrayBufferView> & {
          readonly digest: Promise<ArrayBuffer>;
        };
      }
    ).DigestStream;
    const digest = new DigestStreamConstructor("SHA-256");
    const conditional = new Headers({ "if-none-match": "*" });
    const put = this.bucket
      .put(input.key, fixed.readable, {
        onlyIf: conditional,
        httpMetadata: { contentType: input.mime },
        customMetadata: {
          kind: "output",
          jobId: input.jobId,
          sha256: expectedDigest,
          engineBuildId: input.engineBuildId,
          recoveryV1,
        },
      })
      .then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );
    const reader = input.body.getReader();
    const fixedWriter = fixed.writable.getWriter();
    const digestWriter = digest.getWriter();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await Promise.all([fixedWriter.write(next.value), digestWriter.write(next.value)]);
      }
      await Promise.all([fixedWriter.close(), digestWriter.close()]);
      const [putResult, actualDigest] = await Promise.all([put, digest.digest]);
      if (!putResult.ok) throw new StorageFailureError();
      const stored = putResult.value;
      if (base64Standard(actualDigest) !== expectedDigest) {
        if (stored !== null) await this.bucket.delete(input.key);
        throw new VerificationFailureError();
      }
      const head = stored ?? (await this.bucket.head(input.key));
      if (
        head === null ||
        head.size !== input.byteLength ||
        head.httpMetadata?.contentType !== input.mime ||
        head.customMetadata?.kind !== "output" ||
        head.customMetadata?.jobId !== input.jobId ||
        head.customMetadata?.sha256 !== expectedDigest ||
        head.customMetadata?.engineBuildId !== input.engineBuildId ||
        head.customMetadata?.recoveryV1 !== recoveryV1
      ) {
        if (stored !== null) await this.bucket.delete(input.key);
        throw new VerificationFailureError();
      }
    } catch (error) {
      await Promise.allSettled([
        reader.cancel(error),
        fixedWriter.abort(error),
        digestWriter.abort(error),
      ]);
      await put;
      if (error instanceof VerificationFailureError) throw error;
      throw new StorageFailureError();
    } finally {
      reader.releaseLock();
      fixedWriter.releaseLock();
      digestWriter.releaseLock();
    }
  }

  async deleteInput(key: string): Promise<void> {
    try {
      await this.bucket.delete(key);
    } catch {
      throw new StorageFailureError();
    }
  }

  async deleteOutput(key: string): Promise<void> {
    return this.deleteInput(key);
  }
}

export function createR2QueueArtifactStore(bucket: R2Bucket): QueueArtifactStore {
  return new R2QueueArtifactStore(bucket);
}

function messageMatchesContext(message: ServerJobMessage, context: QueueJobContext): boolean {
  return (
    message.jobId === context.jobId &&
    message.contractId === context.contractId &&
    message.specHash === context.specHash &&
    message.inputKey === context.inputKey &&
    message.inputEtag === context.inputEtag &&
    message.outputKey === context.outputKey &&
    message.resourceClass === context.resourceClass &&
    message.attempt === context.attempt &&
    message.queueEpoch === context.queueEpoch &&
    message.queueGeneration === context.queueGeneration
  );
}

function outputHeadMatchesTerminal(
  head: OutputArtifactHead,
  context: QueueJobContext,
  terminal: Extract<AnyEngineStatus, { state: "succeeded" }>,
): boolean {
  return (
    terminal.result.kind === "download" &&
    head.size === terminal.result.byteLength &&
    head.mime === terminal.result.mime &&
    head.kind === "output" &&
    head.jobId === context.jobId &&
    head.engineBuildId === terminal.result.engineBuildId &&
    typeof head.sha256 === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(head.sha256)
  );
}

function olderMessageCanDriveAuthoritativeContext(
  message: ServerJobMessage,
  context: QueueJobContext,
): boolean {
  return (
    message.jobId === context.jobId &&
    message.contractId === context.contractId &&
    message.queueEpoch === context.queueEpoch &&
    message.queueGeneration < context.queueGeneration
  );
}

function errorFromEngineStatus(status: Extract<AnyEngineStatus, { state: "failed" }>): Error {
  if (status.error.guidance === "TRY_BALANCED_PRESET") return new CodecCandidateTimeoutError();
  switch (status.error.code) {
    case "UNSUPPORTED_INPUT":
      return new UnsupportedInputError();
    case "UNSUPPORTED_FEATURE":
      return new PermanentEngineError("UNSUPPORTED_FEATURE");
    case "INPUT_LIMIT_EXCEEDED":
      return new PermanentEngineError("INPUT_LIMIT_EXCEEDED");
    case "PIXEL_LIMIT_EXCEEDED":
      return new PermanentEngineError("PIXEL_LIMIT_EXCEEDED");
    case "RESOURCE_CLASS_UPGRADE":
      return new ResourceClassUpgradeError();
    case "ENGINE_TIMEOUT":
      return new EngineTimeoutError();
    case "ENGINE_OOM":
      return new EngineOomError();
    case "ENGINE_CRASH":
      return new EngineCrashError();
    case "VERIFICATION_FAILED":
      return new VerificationFailureError();
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startLeaseHeartbeat(
  context: QueueJobContext,
  store: QueueJobStore,
  now: () => number,
): { assertCurrent(): void; stop(): Promise<void> } {
  let stale = false;
  let cancelled = false;
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(async () => {
        if (!(await store.renew(context, now()))) {
          cancelled = await store.isCancellationRequested(context);
          stale = !cancelled;
        }
      })
      .catch(() => {
        stale = true;
      });
  }, LEASE_RENEW_INTERVAL_MS);
  return {
    assertCurrent() {
      if (cancelled) throw new CancelledProcessingError();
      if (stale) throw new StaleLeaseError();
    },
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}

async function ensureLease(
  context: QueueJobContext,
  store: QueueJobStore,
  now: () => number,
): Promise<void> {
  if (await store.renew(context, now())) return;
  if (await store.isCancellationRequested(context)) throw new CancelledProcessingError();
  throw new StaleLeaseError();
}

function validPdfAttempt(
  context: QueueJobContext,
  status: Extract<PdfEngineJobStatus, { state: "succeeded" }>,
): boolean {
  const measurements = status.measurements;
  return (
    context.contractId === "pdf.optimize@1" &&
    context.declaredPageCount === status.inspection.verifiedPageCount &&
    measurements.processedInputBytes <= context.declaredBytes &&
    measurements.cpuMs <= 45_000 &&
    measurements.processingMs <= 45_000 &&
    measurements.peakMemoryBytes <= 768 * 1024 * 1024 &&
    measurements.memoryByteMilliseconds <= 768 * 1024 * 1024 * 45_000 &&
    measurements.testedCandidates <= 2 &&
    status.result.sourceByteLength === context.declaredBytes &&
    status.result.pageCount === context.declaredPageCount
  );
}

function validTerminalAttempt(
  context: QueueJobContext,
  status: Extract<AnyEngineStatus, { state: "succeeded" }>,
): boolean {
  if (context.contractId === "pdf.optimize@1") {
    return status.inspection.verifiedInputMime === "application/pdf" && "pageCount" in status.result
      ? validPdfAttempt(context, status as Extract<PdfEngineJobStatus, { state: "succeeded" }>)
      : false;
  }
  if (status.inspection.verifiedInputMime === "application/pdf") return false;
  if (context.resourceClass === "pdf-standard-v1") return false;
  return validateEngineAttempt({
    inputBytes: context.declaredBytes,
    resourceClass: context.resourceClass,
    measurements: status.measurements as EngineMeasurements,
    result: status.result as Extract<EngineJobStatus, { state: "succeeded" }>["result"],
  }).valid;
}

function engineCreateRequest(
  context: QueueJobContext,
): EngineCreateJobRequest | EngineCreatePdfJobRequest {
  if (context.contractId === "pdf.optimize@1") {
    if (context.declaredMime !== "application/pdf" || context.declaredPageCount === undefined) {
      throw new VerificationFailureError();
    }
    return {
      protocol: 1,
      jobId: context.jobId,
      attempt: context.attempt,
      tool: "pdf.optimize",
      toolVersion: 1,
      spec: pdfOptimizeSpecV1Schema.parse(context.spec),
      specHash: context.specHash,
      input: {
        byteLength: context.declaredBytes,
        etag: context.inputEtag,
        mimeHint: context.declaredMime,
        pageCount: context.declaredPageCount,
      },
      resourceClass: "pdf-standard-v1",
    };
  }
  if (context.declaredMime === "application/pdf" || context.resourceClass === "pdf-standard-v1") {
    throw new VerificationFailureError();
  }
  return {
    protocol: 1,
    jobId: context.jobId,
    attempt: context.attempt,
    tool: "image.optimize",
    toolVersion: 1,
    spec: imageOptimizeSpecV1Schema.parse(context.spec),
    specHash: context.specHash,
    input: {
      byteLength: context.declaredBytes,
      etag: context.inputEtag,
      mimeHint: context.declaredMime,
    },
    resourceClass: context.resourceClass,
  };
}

export async function consumeImageJob(
  rawMessage: ImageJobMessage,
  env: Env,
  dependencies: QueueConsumerDependencies = {},
): Promise<"completed" | "retry-scheduled" | "duplicate"> {
  return consumeServerJob(imageJobMessageSchema.parse(rawMessage), env, dependencies);
}

export async function consumePdfJob(
  rawMessage: PdfJobMessage,
  env: Env,
  dependencies: QueueConsumerDependencies = {},
): Promise<"completed" | "retry-scheduled" | "duplicate"> {
  return consumeServerJob(pdfJobMessageSchema.parse(rawMessage), env, dependencies);
}

async function consumeServerJob(
  message: ServerJobMessage,
  env: Env,
  dependencies: QueueConsumerDependencies,
): Promise<"completed" | "retry-scheduled" | "duplicate"> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const engine = (
    message.contractId === "pdf.optimize@1"
      ? (dependencies.pdfEngine ?? createContainerPdfEngineClient(env))
      : (dependencies.engine ?? createContainerEngineClient(env))
  ) as ServerEngineClient;
  const store = dependencies.store ?? new D1QueueJobStore(env);
  const artifacts = dependencies.artifacts ?? new R2QueueArtifactStore(env.JOB_OBJECTS);
  const recordEngineActivity =
    dependencies.recordEngineActivity ??
    ((contactedAt: number) =>
      recordContainerActivity(env.DB, {
        segmentId: crypto.randomUUID(),
        contactedAt,
        engineIdentity: message.contractId === "pdf.optimize@1" ? "pdf:slot-0" : "image:slot-0",
      }));
  const contactEngine = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    await recordEngineActivity(now());
    return operation();
  };
  const context = await store.claim(message, now());
  if (context === null) return "duplicate";
  const exactMessage = messageMatchesContext(message, context);
  if (!exactMessage && !olderMessageCanDriveAuthoritativeContext(message, context)) {
    await store.releaseStale(context, now());
    return "duplicate";
  }
  if (!exactMessage) await store.adoptAuthoritativeDelivery(context, now());

  const heartbeat =
    dependencies.leaseHeartbeat === false
      ? { assertCurrent() {}, stop: async () => undefined }
      : startLeaseHeartbeat(context, store, now);
  let measurements: AnyEngineMeasurements | undefined;
  let inspection: AnyEngineInspection | null | undefined;
  let deleteInput = false;
  let deleteOutput = false;
  let workspaceMayExist = false;
  try {
    await ensureLease(context, store, now);
    const existingOutput = await artifacts.headOutput(context.outputKey);
    if (existingOutput !== null) {
      if (existingOutput.recoveryStatus === null) {
        deleteOutput = true;
        throw new VerificationFailureError();
      }
      if (!(await store.markEngineContact(context, now()))) throw new StaleLeaseError();
      workspaceMayExist = true;
      let recoveredStatus: AnyEngineStatus | null = existingOutput.recoveryStatus ?? null;
      if (recoveredStatus === null) {
        try {
          recoveredStatus = await contactEngine(() => engine.status(context.jobId));
        } catch (error) {
          if (!(error instanceof EngineHttpError && error.status === 404)) throw error;
        }
      }
      if (recoveredStatus?.jobId !== undefined && recoveredStatus.jobId !== context.jobId) {
        throw new VerificationFailureError();
      }
      if (recoveredStatus?.state === "succeeded") {
        if (
          !validTerminalAttempt(context, recoveredStatus) ||
          !outputHeadMatchesTerminal(existingOutput, context, recoveredStatus)
        ) {
          deleteOutput = true;
          throw new VerificationFailureError();
        }
        measurements = recoveredStatus.measurements;
        inspection = recoveredStatus.inspection;
        await ensureLease(context, store, now);
        if (!(await store.settleSuccess(context, recoveredStatus, now()))) return "duplicate";
        deleteInput = true;
        return "completed";
      }
    }
    const input = await artifacts.getInput(context.inputKey, context.inputEtag);
    if (
      input === null ||
      input.size !== context.declaredBytes ||
      input.etag !== context.inputEtag ||
      input.httpMetadata?.contentType !== context.declaredMime
    ) {
      throw new UploadMismatchError();
    }
    heartbeat.assertCurrent();
    if (!(await store.markEngineContact(context, now()))) throw new StaleLeaseError();
    workspaceMayExist = true;
    const startup = await contactEngine(() => engine.create(engineCreateRequest(context)));
    if (!(await store.recordStartup(context, now(), startup))) throw new StaleLeaseError();
    await ensureLease(context, store, now);
    await contactEngine(() =>
      engine.upload(context.jobId, input.body, context.declaredBytes, context.declaredMime),
    );
    await ensureLease(context, store, now);
    await contactEngine(() => engine.run(context.jobId));

    let terminal: Extract<AnyEngineStatus, { state: "succeeded" | "failed" | "cancelled" }> | null =
      null;
    for (let poll = 0; poll < MAX_POLL_COUNT; poll += 1) {
      await ensureLease(context, store, now);
      heartbeat.assertCurrent();
      const status = await contactEngine(() => engine.status(context.jobId));
      if (status.jobId !== context.jobId) throw new VerificationFailureError();
      if (status.state === "running") {
        if (!(await store.mirrorProgress(context, status, now()))) throw new StaleLeaseError();
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (
        status.state === "succeeded" ||
        status.state === "failed" ||
        status.state === "cancelled"
      ) {
        terminal = status;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (terminal === null) throw new EngineTimeoutError();
    measurements = terminal.measurements;
    inspection = terminal.inspection;
    if (terminal.state === "failed") throw errorFromEngineStatus(terminal);
    if (terminal.state === "cancelled") throw new CancelledProcessingError();
    if (!validTerminalAttempt(context, terminal)) throw new VerificationFailureError();

    if (terminal.result.kind === "download") {
      if (
        terminal.result.byteLength >= context.declaredBytes ||
        terminal.result.mime !== terminal.inspection.verifiedInputMime
      ) {
        throw new VerificationFailureError();
      }
      await ensureLease(context, store, now);
      const output = await contactEngine(() => engine.output(context.jobId));
      if (!output.ok || output.body === null) {
        await output.body?.cancel();
        throw new EngineCrashError();
      }
      if (
        output.headers.get("content-length") !== String(terminal.result.byteLength) ||
        output.headers.get("content-type") !== terminal.result.mime
      ) {
        await output.body.cancel();
        throw new VerificationFailureError();
      }
      const digestHeader = output.headers.get("digest");
      if (digestHeader === null) {
        await output.body.cancel();
        throw new VerificationFailureError();
      }
      await artifacts.storeOutput({
        key: context.outputKey,
        body: output.body,
        byteLength: terminal.result.byteLength,
        mime: terminal.result.mime,
        digestHeader,
        jobId: context.jobId,
        engineBuildId: terminal.result.engineBuildId,
        recoveryStatus: terminal,
      });
      deleteOutput = true;
    }
    await ensureLease(context, store, now);
    if (!(await store.settleSuccess(context, terminal, now()))) {
      if (deleteOutput) await artifacts.deleteOutput(context.outputKey);
      return "duplicate";
    }
    deleteOutput = false;
    deleteInput = true;
    try {
      emitSafeProcessingEvent({
        event: "job-terminal",
        jobId: context.jobId,
        sessionHashPrefix: sessionHashPrefix(context.sessionHash),
        contractId: context.contractId,
        engineBuildId: terminal.result.engineBuildId,
        inputBytes: context.declaredBytes,
        outputBytes: terminal.result.kind === "download" ? terminal.result.byteLength : undefined,
        pixels:
          "processedPixels" in terminal.measurements ? terminal.measurements.processedPixels : 0,
        processingMs: terminal.measurements.processingMs,
        peakMemoryBytes: terminal.measurements.peakMemoryBytes,
        reservedUnits: context.reservedUnits,
      });
    } catch {
      // A telemetry sink cannot change an already-settled customer outcome.
    }
    return "completed";
  } catch (error) {
    if (error instanceof StaleLeaseError) {
      if (workspaceMayExist) {
        await contactEngine(() => engine.cancel(context.jobId)).catch(() => undefined);
      }
      return "duplicate";
    }
    const classification = classifyQueueFailure(error, {
      attempt: context.attempt,
      resourceClass: context.resourceClass,
    });
    if (classification.retry) {
      const scheduled = await store.scheduleRetry(
        context,
        {
          nextResourceClass: classification.nextResourceClass,
          delaySeconds: classification.delaySeconds,
          measurements,
          verifiedMime: inspection?.verifiedInputMime,
        },
        now(),
      );
      if (scheduled === true) return "retry-scheduled";
      if (scheduled === false) throw new StorageFailureError();
    }
    const permanent = classification.retry
      ? { retry: false as const, publicCode: "ENGINE_CRASH" as const }
      : classification;
    const settled = await store.settleFailure(
      context,
      {
        code: permanent.publicCode,
        guidance: permanent.publicGuidance,
        measurements,
        inspection,
      },
      now(),
    );
    if (!settled) return "duplicate";
    deleteInput = true;
    deleteOutput = true;
    return "completed";
  } finally {
    await heartbeat.stop();
    if (workspaceMayExist) {
      await contactEngine(() => engine.remove(context.jobId)).catch(() => undefined);
    }
    if (deleteOutput) await artifacts.deleteOutput(context.outputKey).catch(() => undefined);
    if (deleteInput) await artifacts.deleteInput(context.inputKey).catch(() => undefined);
  }
}

async function consumeDlqMessage(
  message: ServerJobMessage,
  env: Env,
  attempts: number,
): Promise<void> {
  const store = new D1QueueJobStore(env);
  const now = Date.now();
  const context = await store.claim(message, now);
  let ownsTerminalCleanup = false;
  if (context !== null) {
    if (messageMatchesContext(message, context)) {
      ownsTerminalCleanup = await store.settleFailure(context, { code: "ENGINE_CRASH" }, now);
    } else {
      await store.releaseStale(context, now);
    }
  }
  await store.quarantine(message, now, attempts);
  if (ownsTerminalCleanup) {
    await Promise.allSettled([
      env.JOB_OBJECTS.delete(message.inputKey),
      env.JOB_OBJECTS.delete(message.outputKey),
      (message.contractId === "pdf.optimize@1"
        ? createContainerPdfEngineClient(env)
        : createContainerEngineClient(env)
      ).remove(message.jobId),
    ]);
  }
}

export async function consumeImageQueue(
  batch: MessageBatch<ImageJobMessage>,
  env: Env,
  dependencies: {
    consume?: typeof consumeImageJob;
    quarantine?: typeof consumeDlqMessage;
    recordQueueOperations?: (operations: number) => Promise<void>;
  } = {},
): Promise<void> {
  const isDlq = batch.queue === env.IMAGE_JOBS_DLQ_NAME;
  const consume = dependencies.consume ?? consumeImageJob;
  const quarantine = dependencies.quarantine ?? consumeDlqMessage;
  const recordQueueOperations =
    dependencies.recordQueueOperations ??
    (async (operations: number) => {
      const recordedAt = Date.now();
      await env.DB.batch([
        prepareOperationalCounter(env.DB, {
          recordedAt,
          queueOperations: operations,
          d1RowsRead: 1,
          d1RowsWritten: 1,
        }),
      ]);
    });
  if (batch.messages.length > 0) await recordQueueOperations(batch.messages.length * 3);
  for (const queueMessage of batch.messages) {
    const parsed = imageJobMessageSchema.safeParse(queueMessage.body);
    if (!parsed.success) {
      queueMessage.ack();
      continue;
    }
    try {
      if (isDlq) {
        await quarantine(parsed.data, env, queueMessage.attempts);
      } else {
        await consume(parsed.data, env);
      }
      queueMessage.ack();
    } catch {
      queueMessage.retry({ delaySeconds: retryDelay(parsed.data.attempt) });
    }
  }
}

export async function consumeProcessingQueue(
  batch: MessageBatch<ServerJobMessage>,
  env: Env,
  dependencies: {
    consumeImage?: typeof consumeImageJob;
    consumePdf?: typeof consumePdfJob;
    quarantine?: typeof consumeDlqMessage;
    recordQueueOperations?: (operations: number) => Promise<void>;
  } = {},
): Promise<void> {
  const isImage =
    batch.queue === env.IMAGE_JOBS_QUEUE_NAME || batch.queue === env.IMAGE_JOBS_DLQ_NAME;
  const isPdf = batch.queue === env.PDF_JOBS_QUEUE_NAME || batch.queue === env.PDF_JOBS_DLQ_NAME;
  const isDlq = batch.queue === env.IMAGE_JOBS_DLQ_NAME || batch.queue === env.PDF_JOBS_DLQ_NAME;
  const schema = isPdf ? pdfJobMessageSchema : isImage ? imageJobMessageSchema : null;
  const recordQueueOperations =
    dependencies.recordQueueOperations ??
    (async (operations: number) => {
      const recordedAt = Date.now();
      await env.DB.batch([
        prepareOperationalCounter(env.DB, {
          recordedAt,
          queueOperations: operations,
          d1RowsRead: 1,
          d1RowsWritten: 1,
        }),
      ]);
    });
  if (batch.messages.length > 0) await recordQueueOperations(batch.messages.length * 3);
  for (const queueMessage of batch.messages) {
    const parsed = schema?.safeParse(queueMessage.body);
    if (parsed === undefined || !parsed.success) {
      queueMessage.ack();
      continue;
    }
    const message = parsed.data as ServerJobMessage;
    try {
      if (isDlq) {
        await (dependencies.quarantine ?? consumeDlqMessage)(message, env, queueMessage.attempts);
      } else if (message.contractId === "pdf.optimize@1") {
        await (dependencies.consumePdf ?? consumePdfJob)(message, env);
      } else {
        await (dependencies.consumeImage ?? consumeImageJob)(message, env);
      }
      queueMessage.ack();
    } catch {
      queueMessage.retry({ delaySeconds: retryDelay(message.attempt) });
    }
  }
}
