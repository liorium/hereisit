import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { calculateSettledWeightedUnits, estimateImageOptimizeUnits } from "@hereisit/server-job";
import type { ImageOptimizeCreateRequestV1 } from "@hereisit/tool-contracts/image-optimize";
import type { PdfOptimizeCreateRequestV1 } from "@hereisit/tool-contracts/pdf-optimize";
import { describe, expect, expectTypeOf, it } from "vitest";
import { hashAnonymousSessionId, hashJobToken } from "./auth";
import {
  type BeginUploadResult,
  claimQueuedJob,
  createD1JobRepository,
  createD1LifecycleRepository,
  type JobRepository,
  type PdfBeginUploadResult,
  type PdfJobRepository,
  type PdfReserveAndCreateInput,
  parseStoredJob,
  RepositoryIntegrityError,
  type ReserveAndCreateInput,
} from "./d1-job-repository";

const baseMigration = [
  "0001_processing_jobs.sql",
  "0002_worker_version_attestations.sql",
  "0003_circuit_breaker.sql",
  "0004_live_cost_accounting.sql",
  "0005_usage_log_ledger.sql",
  "0006_container_provider_egress.sql",
  "0007_operational_counters.sql",
]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const pdfMigration = readFileSync(
  new URL("../migrations/0008_pdf_processing_jobs.sql", import.meta.url),
  "utf8",
);
const migration = `${baseMigration}\n${pdfMigration}`;
const now = Date.parse("2026-07-16T00:10:00.000Z");
const dayKey = "2026-07-16";
const priorDayKey = "2026-07-15";
const jobToken = "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA";
const alternateJobToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const sessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const alternateSessionId = "018f47a2-65d4-7f31-a377-5afbb8f53f28";
const jobId = "550e8400-e29b-41d4-a716-446655440000";
const alternateJobId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const clientRequestId = "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe";
const alternateClientRequestId = "7ba7b810-9dad-41d1-80b4-00c04fd430c8";
const inputKey = "inputs/11111111-1111-4111-8111-111111111111";
const outputKey = "outputs/22222222-2222-4222-8222-222222222222";
const queueEpoch = "33333333-3333-4333-8333-333333333333";
const networkHash = "1".repeat(64);
const previousNetworkHash = "2".repeat(64);
const previousDayNetworkHash = "3".repeat(64);

function sqliteValues(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    throw new TypeError(`Unsupported SQLite bind value: ${typeof value}.`);
  });
}

function d1Result<T>(results: T[], changes = 0, lastRowId = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      changes,
    },
  };
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  constructor(
    readonly database: DatabaseSync,
    readonly query: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.database, this.query, values);
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...sqliteValues(this.values));
    if (row === undefined) {
      return null;
    }
    if (columnName !== undefined) {
      return (row as Record<string, T>)[columnName] ?? null;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSynchronously<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...sqliteValues(this.values)) as T[];
    return d1Result(rows);
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.database.prepare(this.query);
    const rows = statement.all(...sqliteValues(this.values)) as Record<string, unknown>[];
    const columns = statement.columns().map(({ name }) => name);
    const values = rows.map((row) => columns.map((column) => row[column])) as T[];
    if (options?.columnNames === true) {
      return [columns, ...values];
    }
    return values;
  }

  runSynchronously<T = Record<string, unknown>>(): D1Result<T> {
    const result = this.database.prepare(this.query).run(...sqliteValues(this.values));
    return d1Result([], Number(result.changes), Number(result.lastInsertRowid));
  }

  allSynchronously<T = Record<string, unknown>>(): D1Result<T> {
    const rows = this.database.prepare(this.query).all(...sqliteValues(this.values)) as T[];
    return d1Result(rows);
  }

  executeSynchronously<T = Record<string, unknown>>(): D1Result<T> {
    return /^(?:SELECT|WITH)\b/i.test(this.query.trimStart())
      ? this.allSynchronously<T>()
      : this.runSynchronously<T>();
  }
}

class SqliteD1Session implements D1DatabaseSession {
  constructor(
    private readonly owner: SqliteD1Database,
    readonly constraint: D1SessionConstraint | D1SessionBookmark | undefined,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.owner.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.owner.batchCalls += 1;
    this.owner.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteD1PreparedStatement)) {
          throw new TypeError("Unexpected prepared statement implementation.");
        }
        return statement.executeSynchronously<T>();
      });
      this.owner.sqlite.exec("COMMIT");
      this.owner.afterBatch?.();
      return results;
    } catch (error) {
      this.owner.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getBookmark(): D1SessionBookmark | null {
    return null;
  }
}

class SqliteD1Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly sessionConstraints: (D1SessionConstraint | D1SessionBookmark | undefined)[] = [];
  batchCalls = 0;
  afterBatch: (() => void) | null = null;

  constructor() {
    this.sqlite.exec(migration);
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return new SqliteD1Session(this, undefined).batch<T>(statements);
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    this.sessionConstraints.push(constraintOrBookmark);
    return new SqliteD1Session(this, constraintOrBookmark);
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

function request(
  overrides: Partial<ImageOptimizeCreateRequestV1> = {},
): ImageOptimizeCreateRequestV1 {
  return {
    jobContract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId: sessionId,
    clientRequestId,
    jobToken,
    input: {
      byteLength: 1_000_000,
      mimeHint: "image/png",
      width: 1000,
      height: 1000,
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
    ...overrides,
  };
}

function pdfRequest(
  overrides: Partial<PdfOptimizeCreateRequestV1> = {},
): PdfOptimizeCreateRequestV1 {
  return {
    contract: "tool-job@1",
    toolContract: "pdf.optimize@1",
    anonymousSessionId: "123e4567-e89b-42d3-a456-426614174000",
    clientRequestId: alternateClientRequestId,
    jobToken,
    input: {
      byteLength: 1_000_000,
      mime: "application/pdf",
      pageCount: 3,
    },
    spec: { version: 1, preset: "balanced" },
    ...overrides,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reservationInput(
  overrides: Partial<ReserveAndCreateInput> = {},
): Promise<ReserveAndCreateInput> {
  const createRequest = overrides.request ?? request();
  const specJson = overrides.specJson ?? JSON.stringify(createRequest.spec);
  return {
    jobId,
    clientRequestId: createRequest.clientRequestId,
    tokenHash: await hashJobToken(createRequest.jobToken),
    sessionHash: await hashAnonymousSessionId(createRequest.anonymousSessionId),
    networkHash,
    networkDailyQuotaHashes: [networkHash, previousNetworkHash],
    networkPendingHashes: [networkHash, previousNetworkHash, previousDayNetworkHash],
    dayKey,
    request: createRequest,
    specJson,
    specHash: overrides.specHash ?? (await sha256Hex(specJson)),
    inputKey,
    outputKey,
    queueEpoch,
    estimate: estimateImageOptimizeUnits(createRequest),
    uploadExpiresAt: now + 10 * 60_000,
    now,
    accountDailyLimit: Number.MAX_SAFE_INTEGER,
    anonymousDailyLimit: Number.MAX_SAFE_INTEGER,
    networkDailyLimit: Number.MAX_SAFE_INTEGER,
    accountPendingJobLimit: 10,
    networkPendingJobLimit: 3,
    maximumQueuedAgeSeconds: 600,
    ...overrides,
  };
}

async function pdfReservationInput(
  overrides: Partial<PdfReserveAndCreateInput> = {},
): Promise<PdfReserveAndCreateInput> {
  const createRequest = overrides.request ?? pdfRequest();
  const specJson = overrides.specJson ?? JSON.stringify(createRequest.spec);
  return {
    jobId: alternateJobId,
    clientRequestId: createRequest.clientRequestId,
    tokenHash: await hashJobToken(createRequest.jobToken),
    sessionHash: await hashAnonymousSessionId(createRequest.anonymousSessionId),
    networkHash,
    networkDailyQuotaHashes: [networkHash, previousNetworkHash],
    networkPendingHashes: [networkHash, previousNetworkHash, previousDayNetworkHash],
    dayKey,
    request: createRequest,
    specJson,
    specHash: overrides.specHash ?? (await sha256Hex(specJson)),
    inputKey: "inputs/55555555-5555-4555-8555-555555555555",
    outputKey: "outputs/66666666-6666-4666-8666-666666666666",
    queueEpoch: "77777777-7777-4777-8777-777777777777",
    estimate: {
      resourceClass: "pdf-standard-v1",
      reservedWeightedUnits: 2_439_579_999,
      inputBytes: 1_000_000,
      reservationPageCeiling: 100,
    },
    uploadExpiresAt: now + 10 * 60_000,
    now,
    accountDailyLimit: Number.MAX_SAFE_INTEGER,
    anonymousDailyLimit: Number.MAX_SAFE_INTEGER,
    networkDailyLimit: Number.MAX_SAFE_INTEGER,
    accountPendingJobLimit: 10,
    networkPendingJobLimit: 3,
    maximumQueuedAgeSeconds: 600,
    ...overrides,
  };
}

function count(database: SqliteD1Database, table: string): number {
  const row = database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function usageRows(database: SqliteD1Database) {
  return {
    account: database.sqlite.prepare("SELECT * FROM account_usage").all(),
    anonymous: database.sqlite.prepare("SELECT * FROM anonymous_usage").all(),
    network: database.sqlite.prepare("SELECT * FROM network_usage").all(),
    ledger: database.sqlite.prepare("SELECT * FROM usage_ledger").all(),
  };
}

function seedQueuedJob(
  database: SqliteD1Database,
  queuedAt: number | null,
  suffix = "44444444-4444-4444-8444-444444444444",
): void {
  database.sqlite
    .prepare(
      `INSERT INTO anonymous_usage
        (session_hash, day_key, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`seed-session-${suffix}`, dayKey, now, now);
  database.sqlite
    .prepare(
      `INSERT INTO jobs (
        id, client_request_id, token_hash, session_hash, day_key, status, phase,
        contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
        declared_width, declared_height, input_key, output_key, reserved_units,
        resource_class, queue_epoch, upload_expires_at, queued_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 'image.optimize@1', ?, ?, 1,
        'image/png', 1, 1, ?, ?, 1, 'image-standard-v1', ?, ?, ?, ?, ?)`,
    )
    .run(
      suffix,
      suffix,
      "a".repeat(64),
      `seed-session-${suffix}`,
      dayKey,
      JSON.stringify(request().spec),
      "b".repeat(64),
      `inputs/${suffix}`,
      `outputs/${suffix}`,
      suffix,
      now + 10_000,
      queuedAt,
      now,
      now,
    );
}

function applyPdfMigrationInTransaction(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  database.exec("BEGIN");
  try {
    database.exec(pdfMigration);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function databaseWithMigratedImageAndPdfRows(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(baseMigration);
  database
    .prepare(
      `INSERT INTO anonymous_usage
        (session_hash, day_key, created_at, updated_at)
       VALUES ('invariant-session', ?, ?, ?)`,
    )
    .run(dayKey, now, now);
  database
    .prepare(
      `INSERT INTO jobs (
        id, client_request_id, token_hash, session_hash, day_key, status, phase,
        contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
        declared_width, declared_height, input_key, output_key, reserved_units,
        resource_class, queue_epoch, upload_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'invariant-session', ?, 'created', 'uploading',
        'image.optimize@1', ?, ?, 1000, 'image/png', 320, 200, ?, ?, 1,
        'image-standard-v1', ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      clientRequestId,
      "a".repeat(64),
      dayKey,
      JSON.stringify(request().spec),
      "b".repeat(64),
      inputKey,
      outputKey,
      queueEpoch,
      now + 10_000,
      now,
      now,
    );

  applyPdfMigrationInTransaction(database);
  database
    .prepare(
      `INSERT INTO jobs (
        id, client_request_id, token_hash, session_hash, day_key, status, phase,
        contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
        declared_page_count, input_key, output_key, reserved_units, resource_class,
        queue_epoch, upload_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'invariant-session', ?, 'created', 'uploading',
        'pdf.optimize@1', ?, ?, 1000, 'application/pdf', 3, ?, ?, 1,
        'pdf-standard-v1', ?, ?, ?, ?)`,
    )
    .run(
      alternateJobId,
      alternateClientRequestId,
      "c".repeat(64),
      dayKey,
      JSON.stringify(pdfRequest().spec),
      "d".repeat(64),
      "inputs/55555555-5555-4555-8555-555555555555",
      "outputs/66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      now + 10_000,
      now,
      now,
    );
  return database;
}

describe("PDF job migration", () => {
  it("preserves the image row and every child row inside the migration transaction", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(baseMigration);
    database
      .prepare(
        `INSERT INTO anonymous_usage
          (session_hash, day_key, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("migration-session", dayKey, now, now);
    database
      .prepare(
        `INSERT INTO jobs (
          id, client_request_id, token_hash, session_hash, day_key, status, phase,
          contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
          declared_width, declared_height, verified_input_mime, input_has_alpha,
          content_class, input_key, input_etag, output_key, output_bytes, output_mime,
          output_width, output_height, result_kind, reserved_units, actual_units,
          resource_class, queue_epoch, upload_expires_at, result_expires_at,
          engine_build_id, codec_build_id, warnings_json, tested_candidates,
          queued_at, started_at, finished_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'succeeded', 'completed', 'image.optimize@1', ?, ?, ?,
          'image/png', 320, 200, 'image/png', 1, 'flat-graphic', ?, ?, ?, 600,
          'image/png', 320, 200, 'download', 123, 45, 'image-standard-v1', ?, ?, ?,
          'engine-1', 'codec-1', '[]', 2, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        jobId,
        clientRequestId,
        "a".repeat(64),
        "migration-session",
        dayKey,
        JSON.stringify(request().spec),
        "b".repeat(64),
        1_000,
        inputKey,
        "raw-etag",
        outputKey,
        now + 10_000,
        now + 20_000,
        queueEpoch,
        now - 3_000,
        now - 2_000,
        now - 1_000,
        now - 4_000,
        now,
      );
    database
      .prepare(
        `INSERT INTO usage_ledger
          (job_id, session_hash, day_key, reserved_units, actual_units, outcome, settled_at, created_at)
         VALUES (?, ?, ?, 123, 45, 'succeeded', ?, ?)`,
      )
      .run(jobId, "migration-session", dayKey, now - 1_000, now - 4_000);
    database
      .prepare(
        `INSERT INTO job_outbox (job_id, payload, attempts, next_attempt_at, sent_at)
         VALUES (?, '{}', 1, ?, ?)`,
      )
      .run(jobId, now - 3_000, now - 2_500);
    database
      .prepare(
        `INSERT INTO job_quarantine
          (job_id, queue_name, attempt, error_code, quarantined_at)
         VALUES (?, 'image-jobs-dlq', 1, 'ENGINE_CRASH', ?)`,
      )
      .run(jobId, now - 2_000);
    database
      .prepare(
        `INSERT INTO artifact_presence_audit (job_id, input_exists, output_exists, checked_at)
         VALUES (?, 1, 1, ?)`,
      )
      .run(jobId, now);
    const before = database.prepare("SELECT * FROM jobs").get() as Record<string, unknown>;
    const childrenBefore = Object.fromEntries(
      ["usage_ledger", "job_outbox", "job_quarantine", "artifact_presence_audit"].map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table}`).all(),
      ]),
    );
    const childSchemaBefore = database
      .prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE tbl_name IN (
           'usage_ledger', 'job_outbox', 'job_quarantine', 'artifact_presence_audit'
         )
         ORDER BY type, name`,
      )
      .all();
    applyPdfMigrationInTransaction(database);

    const after = database.prepare("SELECT * FROM jobs").get() as Record<string, unknown>;
    expect(Object.fromEntries(Object.keys(before).map((key) => [key, after[key]]))).toEqual(before);
    expect(after).toMatchObject({
      declared_page_count: null,
      output_page_count: null,
      pdf_profile: null,
    });
    expect(
      Object.fromEntries(
        Object.keys(childrenBefore).map((table) => [
          table,
          database.prepare(`SELECT * FROM ${table}`).all(),
        ]),
      ),
    ).toEqual(childrenBefore);
    expect(
      database
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
           WHERE tbl_name IN (
             'usage_ledger', 'job_outbox', 'job_quarantine', 'artifact_presence_audit'
           )
           ORDER BY type, name`,
        )
        .all(),
    ).toEqual(childSchemaBefore);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'jobs'")
        .all()
        .map((row) => (row as { name: string }).name)
        .sort(),
    ).toEqual([
      "jobs_client_request_idx",
      "jobs_expiry_idx",
      "jobs_health_window_idx",
      "jobs_lease_idx",
      "jobs_network_hash_expiry_idx",
      "jobs_network_status_idx",
      "jobs_terminal_record_idx",
      "sqlite_autoindex_jobs_1",
      "sqlite_autoindex_jobs_2",
      "sqlite_autoindex_jobs_3",
    ]);
  });

  it.each([
    ["image width", jobId, "declared_width", null],
    ["image height", jobId, "declared_height", null],
    ["image page count", jobId, "declared_page_count", 1],
    ["image output page count", jobId, "output_page_count", 1],
    ["image PDF profile", jobId, "pdf_profile", "structural"],
    ["PDF page count", alternateJobId, "declared_page_count", null],
    ["PDF width", alternateJobId, "declared_width", 1],
    ["PDF height", alternateJobId, "declared_height", 1],
    ["PDF alpha flag", alternateJobId, "input_has_alpha", 1],
    ["PDF image content class", alternateJobId, "content_class", "photo"],
    ["PDF output width", alternateJobId, "output_width", 1],
    ["PDF output height", alternateJobId, "output_height", 1],
  ] as const)("rejects an invalid %s field combination", (_label, targetId, field, value) => {
    const database = databaseWithMigratedImageAndPdfRows();
    expect(() =>
      database.prepare(`UPDATE jobs SET ${field} = ? WHERE id = ?`).run(value, targetId),
    ).toThrow("CHECK constraint failed");
  });
});

describe("atomic job reservation", () => {
  it("persists a PDF reservation with pages and no image dimensions", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);

    await expect(repository.reserveAndCreate(await pdfReservationInput())).resolves.toMatchObject({
      kind: "created",
      job: {
        contractId: "pdf.optimize@1",
        declaredMime: "application/pdf",
        declaredPageCount: 3,
        resourceClass: "pdf-standard-v1",
      },
    });

    expect(database.sqlite.prepare("SELECT * FROM jobs").get()).toMatchObject({
      contract_id: "pdf.optimize@1",
      declared_mime: "application/pdf",
      declared_width: null,
      declared_height: null,
      declared_page_count: 3,
      resource_class: "pdf-standard-v1",
    });

    const pdfRepository: PdfJobRepository = repository;
    expectTypeOf<ReturnType<JobRepository["beginUpload"]>>().toEqualTypeOf<
      Promise<BeginUploadResult>
    >();
    expectTypeOf<ReturnType<PdfJobRepository["beginUpload"]>>().toEqualTypeOf<
      Promise<PdfBeginUploadResult>
    >();
    await expect(
      pdfRepository.beginUpload({ jobId: alternateJobId, now: now + 1 }),
    ).resolves.toMatchObject({
      kind: "ready",
      declaredMime: "application/pdf",
    });
    await expect(
      repository.commitStoredInput({
        jobId: alternateJobId,
        uploadVersion: 1,
        inputEtag: "pdf-etag",
        now: now + 2,
      }),
    ).resolves.toEqual({ kind: "queued" });
    expect(
      JSON.parse(
        (
          database.sqlite
            .prepare("SELECT payload FROM job_outbox WHERE job_id = ?")
            .get(alternateJobId) as { payload: string }
        ).payload,
      ),
    ).toMatchObject({
      contractId: "pdf.optimize@1",
      resourceClass: "pdf-standard-v1",
      inputEtag: "pdf-etag",
    });
  });

  it("rejects cross-tool fields when reading persisted rows", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const input = await pdfReservationInput();

    await repository.reserveAndCreate(input);
    const row = database.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(alternateJobId);
    expect(() => parseStoredJob({ ...row, declared_width: 1 })).toThrow(RepositoryIntegrityError);
    expect(() =>
      database.sqlite.exec(`UPDATE jobs SET declared_width = 1 WHERE id = '${alternateJobId}'`),
    ).toThrow("CHECK constraint failed");

    const imageDatabase = new SqliteD1Database();
    await createD1JobRepository(imageDatabase).reserveAndCreate(await reservationInput());
    const imageRow = imageDatabase.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    expect(() => parseStoredJob({ ...imageRow, declared_page_count: 1 })).toThrow(
      RepositoryIntegrityError,
    );
    expect(() =>
      imageDatabase.sqlite.exec(`UPDATE jobs SET declared_page_count = 1 WHERE id = '${jobId}'`),
    ).toThrow("CHECK constraint failed");
  });

  it("uses one first-primary batch and persists only canonical hashes and job fields", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const input = await reservationInput();

    await expect(repository.reserveAndCreate(input)).resolves.toMatchObject({
      kind: "created",
      mode: "upload-required",
      job: {
        jobId,
        status: "created",
        inputKey,
        outputKey,
        uploadVersion: 0,
        reservedWeightedUnits: input.estimate.reservedWeightedUnits,
      },
    });

    expect(database.sessionConstraints).toEqual(["first-primary"]);
    expect(database.batchCalls).toBe(1);
    expect(count(database, "jobs")).toBe(1);
    expect(count(database, "usage_ledger")).toBe(1);
    const rows = usageRows(database);
    expect(rows.account).toEqual([
      expect.objectContaining({
        day_key: dayKey,
        reserved_units: input.estimate.reservedWeightedUnits,
        pending_jobs: 1,
      }),
    ]);
    expect(rows.anonymous).toEqual([
      expect.objectContaining({
        session_hash: input.sessionHash,
        reserved_units: input.estimate.reservedWeightedUnits,
        active_jobs: 1,
      }),
    ]);
    expect(rows.network).toEqual([
      expect.objectContaining({
        network_hash: networkHash,
        reserved_units: input.estimate.reservedWeightedUnits,
        pending_jobs: 1,
      }),
    ]);

    const persisted = JSON.stringify({
      jobs: database.sqlite.prepare("SELECT * FROM jobs").all(),
      ...rows,
    });
    expect(persisted).not.toContain(jobToken);
    expect(persisted).not.toContain(sessionId);
    expect(persisted).not.toContain("203.0.113");
    expect(persisted).not.toContain("private.png");
  });

  it("replays the persisted descriptor without reserving counters twice", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const first = await reservationInput();
    const replay = await reservationInput({
      jobId: alternateJobId,
      inputKey: "inputs/55555555-5555-4555-8555-555555555555",
      outputKey: "outputs/66666666-6666-4666-8666-666666666666",
      queueEpoch: "77777777-7777-4777-8777-777777777777",
    });

    await expect(repository.reserveAndCreate(first)).resolves.toMatchObject({ kind: "created" });
    await expect(repository.reserveAndCreate(replay)).resolves.toMatchObject({
      kind: "replayed",
      mode: "upload-required",
      job: {
        jobId,
        inputKey,
        outputKey,
        queueEpoch,
      },
    });

    expect(count(database, "jobs")).toBe(1);
    expect(count(database, "usage_ledger")).toBe(1);
    expect(usageRows(database).account).toEqual([
      expect.objectContaining({
        reserved_units: first.estimate.reservedWeightedUnits,
        pending_jobs: 1,
      }),
    ]);
    expect(
      database.sqlite
        .prepare("SELECT SUM(admitted_jobs) AS admitted_jobs FROM operational_counter_hourly")
        .get(),
    ).toEqual({ admitted_jobs: 1 });
    expect(database.sqlite.prepare("SELECT first_admitted_at FROM rollout_control").get()).toEqual({
      first_admitted_at: now,
    });
  });

  it("uses the full candidate plus an absent ledger as the reservation marker", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const input = await reservationInput();
    await repository.reserveAndCreate(input);
    database.sqlite.exec(
      "UPDATE account_usage SET reserved_units = 0, pending_jobs = 0;" +
        "UPDATE anonymous_usage SET reserved_units = 0, active_jobs = 0;" +
        "UPDATE network_usage SET reserved_units = 0, pending_jobs = 0;" +
        "DELETE FROM usage_ledger;",
    );

    await expect(repository.reserveAndCreate(input)).resolves.toMatchObject({
      kind: "replayed",
      job: { jobId },
    });
    expect(count(database, "usage_ledger")).toBe(1);
    expect(usageRows(database).account).toEqual([
      expect.objectContaining({
        reserved_units: input.estimate.reservedWeightedUnits,
        pending_jobs: 1,
      }),
    ]);
  });

  it("returns existing-job without an upload descriptor after the job has queued", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const input = await reservationInput();
    await repository.reserveAndCreate(input);
    database.sqlite
      .prepare("UPDATE jobs SET status = 'queued', phase = 'queued', queued_at = ? WHERE id = ?")
      .run(now, jobId);

    await expect(
      repository.reserveAndCreate(await reservationInput({ jobId: alternateJobId })),
    ).resolves.toMatchObject({
      kind: "replayed",
      mode: "existing-job",
      job: { jobId, status: "queued" },
    });
  });

  it.each([
    "token",
    "spec",
    "mime",
    "bytes",
    "width",
    "height",
  ] as const)("returns an idempotency conflict when the replay changes the %s tuple", async (changed) => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());

    let changedRequest = request();
    if (changed === "token") {
      changedRequest = request({ jobToken: alternateJobToken });
    } else if (changed === "spec") {
      changedRequest = request({
        spec: { ...request().spec, preset: "smallest" },
      });
    } else if (changed === "mime") {
      changedRequest = request({
        input: { ...request().input, mimeHint: "image/jpeg" },
      });
    } else if (changed === "bytes") {
      changedRequest = request({
        input: { ...request().input, byteLength: 1_000_001 },
      });
    } else if (changed === "width") {
      changedRequest = request({
        input: { ...request().input, width: 1001 },
      });
    } else {
      changedRequest = request({
        input: { ...request().input, height: 1001 },
      });
    }

    await expect(
      repository.reserveAndCreate(
        await reservationInput({
          jobId: alternateJobId,
          request: changedRequest,
          clientRequestId,
        }),
      ),
    ).resolves.toEqual({
      kind: "idempotency-conflict",
      existingJobId: jobId,
    });
    expect(count(database, "jobs")).toBe(1);
  });

  it("reports a generated job-ID collision without incrementing counters", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    database.sqlite.exec(
      "UPDATE account_usage SET reserved_units = 0, pending_jobs = 0;" +
        "UPDATE anonymous_usage SET reserved_units = 0, active_jobs = 0;" +
        "UPDATE network_usage SET reserved_units = 0, pending_jobs = 0;" +
        "DELETE FROM usage_ledger;",
    );

    const otherRequest = request({
      anonymousSessionId: alternateSessionId,
      clientRequestId: alternateClientRequestId,
    });
    const collision = await reservationInput({
      request: otherRequest,
      jobId,
      clientRequestId: alternateClientRequestId,
      inputKey: "inputs/88888888-8888-4888-8888-888888888888",
      outputKey: "outputs/99999999-9999-4999-8999-999999999999",
      queueEpoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    database.afterBatch = () => {
      database.sqlite.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    };

    await expect(repository.reserveAndCreate(collision)).resolves.toEqual({
      kind: "job-id-collision",
    });
    expect(usageRows(database).account).toEqual([
      expect.objectContaining({ reserved_units: 0, pending_jobs: 0 }),
    ]);
    expect(count(database, "usage_ledger")).toBe(0);
  });

  it("rolls back the job and every counter when the last ledger statement fails", async () => {
    const database = new SqliteD1Database();
    database.sqlite.exec(`
      CREATE TRIGGER fail_usage_ledger
      BEFORE INSERT ON usage_ledger
      BEGIN
        SELECT RAISE(ABORT, 'forced ledger failure');
      END;
    `);
    const repository = createD1JobRepository(database);

    await expect(repository.reserveAndCreate(await reservationInput())).rejects.toThrow(
      /forced ledger failure/,
    );
    expect(count(database, "jobs")).toBe(0);
    expect(count(database, "usage_ledger")).toBe(0);
    expect(count(database, "account_usage")).toBe(0);
    expect(count(database, "anonymous_usage")).toBe(0);
    expect(count(database, "network_usage")).toBe(0);
  });

  it("allows only one concurrent reservation for one replay tuple", async () => {
    // TODO(Task 5 routes integration): repeat this proof in Workerd with two independent D1
    // requests. DatabaseSync serializes these Promise callbacks and proves replay/idempotency,
    // not remote primary contention.
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const [first, second] = await Promise.all([
      repository.reserveAndCreate(await reservationInput()),
      repository.reserveAndCreate(
        await reservationInput({
          jobId: alternateJobId,
          inputKey: "inputs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          outputKey: "outputs/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          queueEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        }),
      ),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["created", "replayed"]);
    expect(count(database, "jobs")).toBe(1);
    expect(count(database, "usage_ledger")).toBe(1);
    expect(usageRows(database).account).toEqual([expect.objectContaining({ pending_jobs: 1 })]);
  });
});

describe("authoritative admission predicates", () => {
  it.each([
    { accountDailyLimit: 0 },
    { anonymousDailyLimit: 0 },
    { networkDailyLimit: 0 },
  ])("fails closed when a required daily limit is zero", async (limit) => {
    const database = new SqliteD1Database();

    await expect(
      createD1JobRepository(database).reserveAndCreate(await reservationInput(limit)),
    ).resolves.toEqual({
      kind: "server-processing-disabled",
      reason: "limit-zero",
    });
  });

  it.each([
    ["account", { accountDailyLimit: 1 }],
    ["anonymous", { anonymousDailyLimit: 1 }],
    ["network", { networkDailyLimit: 1 }],
  ] as const)("denies exhausted %s weighted units", async (scope, limits) => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);

    await expect(repository.reserveAndCreate(await reservationInput(limits))).resolves.toEqual({
      kind: "quota-exceeded",
      scope,
    });
    expect(count(database, "jobs")).toBe(0);
  });

  it("denies one active anonymous job across a UTC midnight row boundary", async () => {
    const database = new SqliteD1Database();
    const input = await reservationInput();
    database.sqlite
      .prepare(
        `INSERT INTO anonymous_usage
          (session_hash, day_key, active_jobs, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .run(input.sessionHash, priorDayKey, now - 1, now - 1);

    await expect(createD1JobRepository(database).reserveAndCreate(input)).resolves.toEqual({
      kind: "active-job-exists",
    });
  });

  it("denies account pending jobs across retained UTC-day rows", async () => {
    const database = new SqliteD1Database();
    database.sqlite
      .prepare(
        `INSERT INTO account_usage
          (day_key, pending_jobs, created_at, updated_at)
         VALUES (?, 10, ?, ?)`,
      )
      .run(priorDayKey, now - 1, now - 1);

    await expect(
      createD1JobRepository(database).reserveAndCreate(
        await reservationInput({ accountPendingJobLimit: 10 }),
      ),
    ).resolves.toEqual({
      kind: "pending-limit-exceeded",
      scope: "account",
    });
  });

  it("classifies denial from the authoritative batch snapshot", async () => {
    const database = new SqliteD1Database();
    database.sqlite
      .prepare(
        `INSERT INTO account_usage
          (day_key, pending_jobs, created_at, updated_at)
         VALUES (?, 10, ?, ?)`,
      )
      .run(priorDayKey, now - 1, now - 1);
    database.afterBatch = () => {
      database.sqlite.prepare("UPDATE account_usage SET pending_jobs = 0").run();
    };

    await expect(
      createD1JobRepository(database).reserveAndCreate(
        await reservationInput({ accountPendingJobLimit: 10 }),
      ),
    ).resolves.toEqual({
      kind: "pending-limit-exceeded",
      scope: "account",
    });
  });

  it("deduplicates current/previous-secret and previous-day network pending aliases", async () => {
    const database = new SqliteD1Database();
    database.sqlite
      .prepare(
        `INSERT INTO network_usage
          (network_hash, day_key, pending_jobs, created_at, updated_at)
         VALUES (?, ?, 3, ?, ?)`,
      )
      .run(previousDayNetworkHash, priorDayKey, now - 1, now - 1);

    await expect(
      createD1JobRepository(database).reserveAndCreate(
        await reservationInput({
          networkPendingHashes: [previousDayNetworkHash, previousDayNetworkHash, networkHash],
          networkPendingJobLimit: 3,
        }),
      ),
    ).resolves.toEqual({
      kind: "pending-limit-exceeded",
      scope: "network",
    });
  });

  it("sums current-day weighted units across deduplicated rotating network aliases", async () => {
    const database = new SqliteD1Database();
    const input = await reservationInput();
    database.sqlite
      .prepare(
        `INSERT INTO network_usage
          (network_hash, day_key, reserved_units, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(previousNetworkHash, dayKey, input.estimate.reservedWeightedUnits, now, now);

    await expect(
      createD1JobRepository(database).reserveAndCreate(
        await reservationInput({
          networkDailyQuotaHashes: [previousNetworkHash, previousNetworkHash, networkHash],
          networkDailyLimit: input.estimate.reservedWeightedUnits * 2 - 1,
        }),
      ),
    ).resolves.toEqual({
      kind: "quota-exceeded",
      scope: "network",
    });
  });

  it("fails closed when the circuit is open", async () => {
    const database = new SqliteD1Database();
    database.sqlite.prepare("UPDATE rollout_control SET circuit_open = 1 WHERE id = 1").run();

    await expect(
      createD1JobRepository(database).reserveAndCreate(await reservationInput()),
    ).resolves.toEqual({
      kind: "server-processing-disabled",
      reason: "circuit-open",
    });
    expect(count(database, "jobs")).toBe(0);
  });

  it.each([
    ["exact boundary", now - 600_000, "created"],
    ["one millisecond beyond", now - 600_001, "too-old"],
    ["future timestamp", now + 1, "invalid-timestamp"],
    ["null timestamp", null, "invalid-timestamp"],
  ] as const)("handles queue age at the %s", async (_case, queuedAt, expected) => {
    const database = new SqliteD1Database();
    seedQueuedJob(database, queuedAt);
    const result = await createD1JobRepository(database).reserveAndCreate(await reservationInput());

    if (expected === "created") {
      expect(result).toMatchObject({ kind: "created" });
    } else {
      expect(result).toEqual({ kind: "queue-unavailable", reason: expected });
    }
  });
});

describe("canonical input and persisted-row validation", () => {
  it("rejects an under-reserved caller estimate before touching D1", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const input = await reservationInput();

    await expect(
      repository.reserveAndCreate({
        ...input,
        estimate: {
          ...input.estimate,
          reservedWeightedUnits: 1,
        },
      }),
    ).rejects.toThrow(/estimate/i);
    expect(count(database, "jobs")).toBe(0);
  });

  it("rejects non-canonical spec JSON and a mismatched hash before touching D1", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const canonical = JSON.stringify(request().spec);
    const reordered = `{"preset":"balanced",${canonical
      .slice(1, -1)
      .split(",")
      .filter((entry) => !entry.startsWith('"preset"'))
      .join(",")}}`;

    await expect(
      repository.reserveAndCreate(
        await reservationInput({
          specJson: reordered,
          specHash: await sha256Hex(reordered),
        }),
      ),
    ).rejects.toThrow(/canonical spec/i);
    await expect(
      repository.reserveAndCreate(await reservationInput({ specHash: "f".repeat(64) })),
    ).rejects.toThrow(/spec hash/i);
    expect(count(database, "jobs")).toBe(0);
  });

  it("rejects unknown request fields without persisting filenames or raw addresses", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const unsafeRequest = {
      ...request(),
      filename: "private.png",
      sourceIp: "203.0.113.9",
    };

    await expect(
      repository.reserveAndCreate(
        await reservationInput({
          request: unsafeRequest as ImageOptimizeCreateRequestV1,
        }),
      ),
    ).rejects.toThrow();
    expect(count(database, "jobs")).toBe(0);
  });

  it("fails closed when a replayed D1 row has a non-contract state", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    database.sqlite.prepare("UPDATE jobs SET status = 'mystery' WHERE id = ?").run(jobId);

    await expect(
      repository.reserveAndCreate(await reservationInput({ jobId: alternateJobId })),
    ).rejects.toBeInstanceOf(RepositoryIntegrityError);
  });

  it("fails closed when a replayed D1 row has a non-contract phase", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    database.sqlite.prepare("UPDATE jobs SET phase = 'mystery' WHERE id = ?").run(jobId);

    await expect(
      repository.reserveAndCreate(await reservationInput({ jobId: alternateJobId })),
    ).rejects.toBeInstanceOf(RepositoryIntegrityError);
  });
});

describe("authenticated upload reservation", () => {
  it("loads only the expected token hash for authentication", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const input = await reservationInput();
    await repository.reserveAndCreate(input);

    await expect(repository.loadExpectedTokenHash(jobId)).resolves.toBe(input.tokenHash);
    await expect(repository.loadExpectedTokenHash(alternateJobId)).resolves.toBeNull();
  });

  it("increments the upload version once and reuses it for uploading retries", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());

    await expect(repository.beginUpload({ jobId, now })).resolves.toEqual({
      kind: "ready",
      jobId,
      declaredBytes: 1_000_000,
      declaredMime: "image/png",
      inputKey,
      uploadVersion: 1,
      uploadExpiresAt: now + 10 * 60_000,
    });
    await expect(repository.beginUpload({ jobId, now: now + 1 })).resolves.toMatchObject({
      kind: "ready",
      uploadVersion: 1,
    });
    expect(
      database.sqlite.prepare("SELECT upload_version FROM jobs WHERE id = ?").get(jobId),
    ).toEqual({ upload_version: 1 });
  });

  it("settles an expired never-started upload at the fixed floor", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);

    await expect(
      repository.beginUpload({ jobId, now: reservation.uploadExpiresAt }),
    ).resolves.toEqual({
      kind: "rejected",
      reason: "expired",
      deleteAuthorization: {
        kind: "delete-unowned-object",
        key: inputKey,
      },
    });

    const fixedFloor = calculateSettledWeightedUnits([]);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          active_jobs: 0,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      ledger: [
        expect.objectContaining({
          actual_units: fixedFloor,
          outcome: "expired",
          settled_at: reservation.uploadExpiresAt,
        }),
      ],
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT status, upload_version, settlement_state, actual_units, error_code
           FROM jobs WHERE id = ?`,
        )
        .get(jobId),
    ).toEqual({
      status: "expired",
      upload_version: 0,
      settlement_state: "settled",
      actual_units: fixedFloor,
      error_code: "UPLOAD_EXPIRED",
    });
  });

  it("settles a cancelled in-progress upload before rejecting it", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    await repository.beginUpload({ jobId, now });
    database.sqlite
      .prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?")
      .run(now + 1, jobId);

    await expect(repository.beginUpload({ jobId, now: now + 2 })).resolves.toEqual({
      kind: "rejected",
      reason: "cancelled",
      deleteAuthorization: {
        kind: "delete-unowned-object",
        key: inputKey,
      },
    });

    const fixedFloor = calculateSettledWeightedUnits([]);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          active_jobs: 0,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      ledger: [
        expect.objectContaining({
          actual_units: fixedFloor,
          outcome: "cancelled",
          settled_at: now + 2,
        }),
      ],
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT status, upload_version, settlement_state, actual_units, error_code
           FROM jobs WHERE id = ?`,
        )
        .get(jobId),
    ).toEqual({
      status: "cancelled",
      upload_version: 1,
      settlement_state: "settled",
      actual_units: fixedFloor,
      error_code: "CANCELLED",
    });
  });

  it("settles concurrent expired uploading retries exactly once", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    await repository.beginUpload({ jobId, now });

    const results = await Promise.all([
      repository.beginUpload({ jobId, now: reservation.uploadExpiresAt }),
      repository.beginUpload({ jobId, now: reservation.uploadExpiresAt + 1 }),
      repository.beginUpload({ jobId, now: reservation.uploadExpiresAt + 2 }),
    ]);

    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: "rejected",
        reason: "expired",
        deleteAuthorization: {
          kind: "delete-unowned-object",
          key: inputKey,
        },
      })),
    );
    const fixedFloor = calculateSettledWeightedUnits([]);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          active_jobs: 0,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      ledger: [
        expect.objectContaining({
          actual_units: fixedFloor,
          outcome: "expired",
          settled_at: reservation.uploadExpiresAt,
        }),
      ],
    });
    expect(
      database.sqlite
        .prepare("SELECT status, upload_version, settlement_state FROM jobs WHERE id = ?")
        .get(jobId),
    ).toEqual({
      status: "expired",
      upload_version: 1,
      settlement_state: "settled",
    });
  });

  it("settles concurrent cancelled never-started retries at upload version zero", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    database.sqlite
      .prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?")
      .run(now + 1, jobId);

    const results = await Promise.all([
      repository.beginUpload({ jobId, now: now + 2 }),
      repository.beginUpload({ jobId, now: now + 3 }),
      repository.beginUpload({ jobId, now: now + 4 }),
    ]);

    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: "rejected",
        reason: "cancelled",
        deleteAuthorization: {
          kind: "delete-unowned-object",
          key: inputKey,
        },
      })),
    );
    const fixedFloor = calculateSettledWeightedUnits([]);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          active_jobs: 0,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      ledger: [
        expect.objectContaining({
          actual_units: fixedFloor,
          outcome: "cancelled",
          settled_at: now + 2,
        }),
      ],
    });
    expect(
      database.sqlite
        .prepare("SELECT status, upload_version, settlement_state FROM jobs WHERE id = ?")
        .get(jobId),
    ).toEqual({
      status: "cancelled",
      upload_version: 0,
      settlement_state: "settled",
    });
  });

  it.each([
    ["cancelled", "cancelled", "CANCELLED"],
    ["expired", "expired", "UPLOAD_EXPIRED"],
  ] as const)("finishes a reserved %s status and replays its rejection without double settlement", async (persistedStatus, reason, errorCode) => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    database.sqlite.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(persistedStatus, jobId);

    const expected = {
      kind: "rejected" as const,
      reason,
      deleteAuthorization: {
        kind: "delete-unowned-object" as const,
        key: inputKey,
      },
    };
    await expect(repository.beginUpload({ jobId, now: now + 1 })).resolves.toEqual(expected);
    await expect(repository.beginUpload({ jobId, now: now + 2 })).resolves.toEqual(expected);

    const fixedFloor = calculateSettledWeightedUnits([]);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          active_jobs: 0,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      ledger: [
        expect.objectContaining({
          actual_units: fixedFloor,
          outcome: reason,
          settled_at: now + 1,
        }),
      ],
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT status, upload_version, settlement_state, actual_units, error_code
             FROM jobs WHERE id = ?`,
        )
        .get(jobId),
    ).toEqual({
      status: persistedStatus,
      upload_version: 0,
      settlement_state: "settled",
      actual_units: fixedFloor,
      error_code: errorCode,
    });
  });

  it("fails closed instead of rejecting an expired upload with an unsettled reservation", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    database.sqlite.prepare("DELETE FROM network_usage WHERE network_hash = ?").run(networkHash);

    await expect(
      repository.beginUpload({ jobId, now: reservation.uploadExpiresAt }),
    ).rejects.toBeInstanceOf(RepositoryIntegrityError);

    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          pending_jobs: 1,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          active_jobs: 1,
        }),
      ],
      network: [],
      ledger: [expect.objectContaining({ actual_units: null, settled_at: null })],
    });
    expect(
      database.sqlite
        .prepare("SELECT status, upload_version, settlement_state FROM jobs WHERE id = ?")
        .get(jobId),
    ).toEqual({
      status: "created",
      upload_version: 0,
      settlement_state: "reserved",
    });
  });

  it("never returns deletion authorization for an already committed input", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });
    await repository.commitStoredInput({
      jobId,
      uploadVersion: 1,
      inputEtag: "owned-etag",
      now: now + 1,
    });

    await expect(repository.beginUpload({ jobId, now: now + 2 })).resolves.toEqual({
      kind: "already-committed",
      state: "queued",
      inputEtag: "owned-etag",
      declaredBytes: 1_000_000,
      declaredMime: "image/png",
    });
  });

  it("fails closed when another job acquires the observed input key before settlement", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    const replacementKey = "inputs/88888888-8888-4888-8888-888888888888";
    database.afterBatch = () => {
      database.afterBatch = null;
      database.sqlite
        .prepare("UPDATE jobs SET input_key = ? WHERE id = ?")
        .run(replacementKey, jobId);
      seedQueuedJob(database, now, alternateJobId);
      database.sqlite
        .prepare("UPDATE jobs SET input_key = ? WHERE id = ?")
        .run(inputKey, alternateJobId);
    };

    await expect(
      repository.beginUpload({ jobId, now: reservation.uploadExpiresAt }),
    ).rejects.toBeInstanceOf(RepositoryIntegrityError);

    expect(
      database.sqlite.prepare("SELECT id FROM jobs WHERE input_key = ?").get(inputKey),
    ).toEqual({ id: alternateJobId });
    expect(
      database.sqlite.prepare("SELECT status, settlement_state FROM jobs WHERE id = ?").get(jobId),
    ).toEqual({ status: "created", settlement_state: "reserved" });
    expect(
      database.sqlite
        .prepare("SELECT actual_units, settled_at FROM usage_ledger WHERE job_id = ?")
        .get(jobId),
    ).toEqual({ actual_units: null, settled_at: null });
  });

  it.each([
    ["not-found", alternateJobId, now],
    ["cancelled", jobId, now],
    ["expired", jobId, now + 10 * 60_000],
    ["invalid-state", jobId, now],
  ] as const)("rejects a %s upload reservation", async (reason, targetJobId, at) => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    if (reason !== "not-found") {
      await repository.reserveAndCreate(await reservationInput());
      if (reason === "cancelled") {
        database.sqlite
          .prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?")
          .run(now, jobId);
      }
      if (reason === "invalid-state") {
        database.sqlite.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(jobId);
      }
    }

    await expect(repository.beginUpload({ jobId: targetJobId, now: at })).resolves.toMatchObject({
      kind: "rejected",
      reason,
    });
  });
});

describe("transactional stored-input commit", () => {
  it("queues one raw-ETag version and derives exactly one valid outbox payload", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });

    await expect(
      repository.commitStoredInput({
        jobId,
        uploadVersion: 1,
        inputEtag: "raw-etag",
        now: now + 1,
      }),
    ).resolves.toEqual({ kind: "queued" });

    expect(
      database.sqlite
        .prepare(
          `SELECT status, phase, input_etag, attempt, queued_at, processing_deadline_at
           FROM jobs WHERE id = ?`,
        )
        .get(jobId),
    ).toEqual({
      status: "queued",
      phase: "queued",
      input_etag: "raw-etag",
      attempt: 1,
      queued_at: now + 1,
      processing_deadline_at: now + 1 + 20 * 60_000,
    });
    const outbox = database.sqlite
      .prepare("SELECT * FROM job_outbox WHERE job_id = ?")
      .get(jobId) as {
      payload: string;
      attempts: number;
      next_attempt_at: number;
      sent_at: number | null;
    };
    expect(JSON.parse(outbox.payload)).toEqual({
      jobId,
      contractId: "image.optimize@1",
      specHash: (await reservationInput()).specHash,
      inputKey,
      inputEtag: "raw-etag",
      outputKey,
      resourceClass: "image-standard-v1",
      attempt: 1,
      queueEpoch,
      queueGeneration: 1,
    });
    expect(outbox).toMatchObject({
      attempts: 0,
      next_attempt_at: now + 1,
      sent_at: null,
    });
  });

  it("treats response loss and two same-ETag commits as one queue transition", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });

    const commit = {
      jobId,
      uploadVersion: 1,
      inputEtag: "raw-etag",
      now: now + 1,
    };
    await expect(repository.commitStoredInput(commit)).resolves.toEqual({ kind: "queued" });
    const [firstReplay, secondReplay] = await Promise.all([
      repository.commitStoredInput({ ...commit, now: now + 2 }),
      repository.commitStoredInput({ ...commit, now: now + 3 }),
    ]);
    expect(firstReplay).toEqual({
      kind: "already-queued-same-etag",
      state: "queued",
    });
    expect(secondReplay).toEqual(firstReplay);
    expect(count(database, "job_outbox")).toBe(1);
  });

  it("never authorizes deletion for a conflicting owned ETag and opens the circuit", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });
    await repository.commitStoredInput({
      jobId,
      uploadVersion: 1,
      inputEtag: "first-etag",
      now: now + 1,
    });

    await expect(
      repository.commitStoredInput({
        jobId,
        uploadVersion: 1,
        inputEtag: "different-etag",
        now: now + 2,
      }),
    ).resolves.toEqual({ kind: "conflicting-owned-etag" });
    expect(
      database.sqlite.prepare("SELECT * FROM rollout_control WHERE id = 1").get(),
    ).toMatchObject({
      circuit_open: 1,
      reason: "INPUT_ETAG_CONFLICT",
      opened_at: now + 2,
    });
    expect(database.sqlite.prepare("SELECT input_etag FROM jobs WHERE id = ?").get(jobId)).toEqual({
      input_etag: "first-etag",
    });
  });

  it.each([
    ["cancelled", "cancelled"],
    ["expired", "expired"],
    ["upload-version-changed", "version"],
    ["no-owner", "missing"],
  ] as const)("returns delete-unowned-object for %s", async (reason, setup) => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });
    let commitNow = now + 1;
    if (setup === "cancelled") {
      database.sqlite
        .prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?")
        .run(now, jobId);
    } else if (setup === "expired") {
      commitNow = now + 10 * 60_000;
    } else if (setup === "version") {
      database.sqlite.prepare("UPDATE jobs SET upload_version = 2 WHERE id = ?").run(jobId);
    } else {
      database.sqlite.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    }

    await expect(
      repository.commitStoredInput({
        jobId,
        uploadVersion: 1,
        inputEtag: "raw-etag",
        now: commitNow,
      }),
    ).resolves.toEqual({
      kind: "delete-unowned-object",
      reason,
    });
    expect(count(database, "job_outbox")).toBe(0);
  });

  it("rolls back queued ownership when the outbox insert fails", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });
    database.sqlite.exec(`
      CREATE TRIGGER fail_job_outbox
      BEFORE INSERT ON job_outbox
      BEGIN
        SELECT RAISE(ABORT, 'forced outbox failure');
      END;
    `);

    await expect(
      repository.commitStoredInput({
        jobId,
        uploadVersion: 1,
        inputEtag: "raw-etag",
        now: now + 1,
      }),
    ).rejects.toThrow(/forced outbox failure/);
    expect(
      database.sqlite
        .prepare("SELECT status, input_etag, queued_at FROM jobs WHERE id = ?")
        .get(jobId),
    ).toEqual({
      status: "uploading",
      input_etag: null,
      queued_at: null,
    });
    expect(count(database, "job_outbox")).toBe(0);
  });

  it("rejects a quoted HTTP ETag instead of storing it as the raw object version", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });

    await expect(
      repository.commitStoredInput({
        jobId,
        uploadVersion: 1,
        inputEtag: '"raw-etag"',
        now: now + 1,
      }),
    ).rejects.toThrow(/raw ETag/i);
    expect(
      database.sqlite.prepare("SELECT status, input_etag FROM jobs WHERE id = ?").get(jobId),
    ).toEqual({ status: "uploading", input_etag: null });
  });
});

describe("exactly-once pre-engine settlement", () => {
  it("keeps upload version zero invalid for failed storage settlements", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);

    await expect(
      repository.settlePreEngineFailure({
        jobId,
        inputKey,
        uploadVersion: 0,
        now: now + 1,
        outcome: "failed",
        errorCode: "STORAGE_FAILURE",
      }),
    ).rejects.toThrow(/uploadVersion/);

    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          pending_jobs: 1,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          active_jobs: 1,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          pending_jobs: 1,
        }),
      ],
      ledger: [expect.objectContaining({ actual_units: null, settled_at: null })],
    });
  });

  it("settles the fixed floor once and explicitly authorizes only the unowned input key", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    await repository.beginUpload({ jobId, now });
    const settlement = {
      jobId,
      inputKey,
      uploadVersion: 1,
      now: now + 1,
      outcome: "failed" as const,
      errorCode: "STORAGE_FAILURE" as const,
    };

    await expect(repository.settlePreEngineFailure(settlement)).resolves.toEqual({
      kind: "settled",
      state: "failed",
      deleteAuthorization: {
        kind: "delete-unowned-object",
        key: inputKey,
      },
    });
    const fixedFloor = calculateSettledWeightedUnits([]);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          active_jobs: 0,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: 0,
          settled_units: fixedFloor,
          pending_jobs: 0,
        }),
      ],
      ledger: [
        expect.objectContaining({
          actual_units: fixedFloor,
          outcome: "failed",
          settled_at: now + 1,
        }),
      ],
    });

    await expect(
      repository.settlePreEngineFailure({ ...settlement, now: now + 2 }),
    ).resolves.toEqual({
      kind: "already-settled",
      state: "failed",
      deleteAuthorization: {
        kind: "delete-unowned-object",
        key: inputKey,
      },
    });
    expect(usageRows(database).account).toEqual([
      expect.objectContaining({ reserved_units: 0, settled_units: fixedFloor, pending_jobs: 0 }),
    ]);
  });

  it("returns version/no-owner results with deletion authorization only when D1 has no owner", async () => {
    const versionDatabase = new SqliteD1Database();
    const versionRepository = createD1JobRepository(versionDatabase);
    await versionRepository.reserveAndCreate(await reservationInput());
    await versionRepository.beginUpload({ jobId, now });
    versionDatabase.sqlite.prepare("UPDATE jobs SET upload_version = 2 WHERE id = ?").run(jobId);

    await expect(
      versionRepository.settlePreEngineFailure({
        jobId,
        inputKey,
        uploadVersion: 1,
        now: now + 1,
        outcome: "failed",
        errorCode: "UPLOAD_MISMATCH",
      }),
    ).resolves.toEqual({
      kind: "upload-version-changed",
      deleteAuthorization: { kind: "delete-unowned-object", key: inputKey },
    });

    const missingDatabase = new SqliteD1Database();
    const missingRepository = createD1JobRepository(missingDatabase);
    await expect(
      missingRepository.settlePreEngineFailure({
        jobId,
        inputKey,
        uploadVersion: 1,
        now: now + 1,
        outcome: "failed",
        errorCode: "UPLOAD_MISMATCH",
      }),
    ).resolves.toEqual({
      kind: "no-owner",
      deleteAuthorization: { kind: "delete-unowned-object", key: inputKey },
    });

    const ownedDatabase = new SqliteD1Database();
    const ownedRepository = createD1JobRepository(ownedDatabase);
    await ownedRepository.reserveAndCreate(await reservationInput());
    await ownedRepository.beginUpload({ jobId, now });
    await ownedRepository.commitStoredInput({
      jobId,
      uploadVersion: 1,
      inputEtag: "owned-etag",
      now: now + 1,
    });
    await expect(
      ownedRepository.settlePreEngineFailure({
        jobId,
        inputKey,
        uploadVersion: 1,
        now: now + 2,
        outcome: "failed",
        errorCode: "STORAGE_FAILURE",
      }),
    ).resolves.toEqual({ kind: "no-owner" });
  });

  it("never authorizes deletion of a key held by a different uncommitted job", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());

    await expect(
      repository.settlePreEngineFailure({
        jobId: alternateJobId,
        inputKey,
        uploadVersion: 1,
        now: now + 1,
        outcome: "failed",
        errorCode: "UPLOAD_MISMATCH",
      }),
    ).resolves.toEqual({ kind: "no-owner" });
  });

  it("rolls back every counter and ledger mutation when final job settlement fails", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    await repository.beginUpload({ jobId, now });
    database.sqlite.exec(`
      CREATE TRIGGER fail_job_settlement
      BEFORE UPDATE OF settlement_state ON jobs
      WHEN NEW.settlement_state = 'settled'
      BEGIN
        SELECT RAISE(ABORT, 'forced settlement failure');
      END;
    `);

    await expect(
      repository.settlePreEngineFailure({
        jobId,
        inputKey,
        uploadVersion: 1,
        now: now + 1,
        outcome: "failed",
        errorCode: "STORAGE_FAILURE",
      }),
    ).rejects.toThrow(/forced settlement failure/);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          pending_jobs: 1,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          active_jobs: 1,
        }),
      ],
      network: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          pending_jobs: 1,
        }),
      ],
      ledger: [expect.objectContaining({ actual_units: null, settled_at: null })],
    });
  });

  it("fails closed without partial settlement when an aggregate usage row is missing", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    const reservation = await reservationInput();
    await repository.reserveAndCreate(reservation);
    await repository.beginUpload({ jobId, now });
    database.sqlite.prepare("DELETE FROM network_usage WHERE network_hash = ?").run(networkHash);

    await expect(
      repository.settlePreEngineFailure({
        jobId,
        inputKey,
        uploadVersion: 1,
        now: now + 1,
        outcome: "failed",
        errorCode: "STORAGE_FAILURE",
      }),
    ).rejects.toBeInstanceOf(RepositoryIntegrityError);
    expect(usageRows(database)).toMatchObject({
      account: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          pending_jobs: 1,
        }),
      ],
      anonymous: [
        expect.objectContaining({
          reserved_units: reservation.estimate.reservedWeightedUnits,
          settled_units: 0,
          active_jobs: 1,
        }),
      ],
      network: [],
      ledger: [expect.objectContaining({ actual_units: null, settled_at: null })],
    });
    expect(
      database.sqlite
        .prepare("SELECT status, settlement_state, actual_units FROM jobs WHERE id = ?")
        .get(jobId),
    ).toEqual({
      status: "uploading",
      settlement_state: "reserved",
      actual_units: null,
    });
  });
});

describe("normalized invariant circuit", () => {
  it("opens the singleton with only the normalized reason", async () => {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);

    await repository.openInvariantCircuit({
      now,
      reason: "INPUT_ETAG_CONFLICT",
    });

    expect(
      database.sqlite.prepare("SELECT * FROM rollout_control WHERE id = 1").get(),
    ).toMatchObject({
      circuit_open: 1,
      reason: "INPUT_ETAG_CONFLICT",
      opened_at: now,
    });
  });
});

describe("fenced queue leases", () => {
  async function queuedDatabase(): Promise<SqliteD1Database> {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });
    await repository.commitStoredInput({
      jobId,
      uploadVersion: 1,
      inputEtag: "raw-etag",
      now: now + 1,
    });
    return database;
  }

  it("allows exactly one concurrent claimant", async () => {
    const database = await queuedDatabase();
    const [first, second] = await Promise.all([
      claimQueuedJob(database, jobId, now + 2),
      claimQueuedJob(database, jobId, now + 2),
    ]);

    expect([first, second].filter((lease) => lease !== null)).toHaveLength(1);
    expect(database.sessionConstraints.slice(-2)).toEqual(["first-primary", "first-primary"]);
  });

  it("recovers only an expired running lease with a new fence token", async () => {
    const database = await queuedDatabase();
    const first = await claimQueuedJob(database, jobId, now + 2);
    expect(first).not.toBeNull();
    await expect(claimQueuedJob(database, jobId, now + 3)).resolves.toBeNull();

    database.sqlite
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run(now + 3, jobId);
    const recovered = await claimQueuedJob(database, jobId, now + 4);

    expect(recovered).not.toBeNull();
    expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
  });
});

describe("authenticated lifecycle persistence", () => {
  async function queuedDatabase(): Promise<SqliteD1Database> {
    const database = new SqliteD1Database();
    const repository = createD1JobRepository(database);
    await repository.reserveAndCreate(await reservationInput());
    await repository.beginUpload({ jobId, now });
    await repository.commitStoredInput({
      jobId,
      uploadVersion: 1,
      inputEtag: "raw-etag",
      now: now + 1,
    });
    return database;
  }

  it("settles a queued cancellation exactly once and removes its outbox", async () => {
    const database = await queuedDatabase();
    const lifecycle = createD1LifecycleRepository(database);
    const before = usageRows(database);

    await expect(lifecycle.cancelJob(jobId, now + 2)).resolves.toMatchObject({
      kind: "cancelled-and-settled",
      job: { state: "cancelled", errorCode: "CANCELLED" },
      inputKey,
      outputKey,
    });
    await expect(lifecycle.cancelJob(jobId, now + 3)).resolves.toMatchObject({
      kind: "terminal",
      job: { state: "cancelled" },
    });

    expect(count(database, "job_outbox")).toBe(0);
    const after = usageRows(database) as {
      account: Array<{ reserved_units: number; settled_units: number; pending_jobs: number }>;
      anonymous: Array<{ reserved_units: number; settled_units: number; active_jobs: number }>;
      network: Array<{ reserved_units: number; settled_units: number; pending_jobs: number }>;
      ledger: Array<{ actual_units: number; outcome: string; settled_at: number }>;
    };
    expect(after.account[0]).toMatchObject({
      reserved_units: 0,
      pending_jobs: 0,
      settled_units: calculateSettledWeightedUnits([]),
    });
    expect(after.anonymous[0]).toMatchObject({ reserved_units: 0, active_jobs: 0 });
    expect(after.network[0]).toMatchObject({ reserved_units: 0, pending_jobs: 0 });
    expect(after.ledger[0]).toMatchObject({
      actual_units: calculateSettledWeightedUnits([]),
      outcome: "cancelled",
      settled_at: now + 2,
    });
    expect(before.ledger).toHaveLength(1);
  });

  it("records running cancellation without changing its lease or accounting", async () => {
    const database = await queuedDatabase();
    const lease = await claimQueuedJob(database, jobId, now + 2);
    const before = usageRows(database);
    const lifecycle = createD1LifecycleRepository(database);

    await expect(lifecycle.deleteJob(jobId, now + 3)).resolves.toMatchObject({
      kind: "running",
      job: { state: "running" },
    });

    const row = database.sqlite
      .prepare(
        "SELECT status, lease_token, lease_expires_at, cancel_requested_at, settlement_state FROM jobs WHERE id = ?",
      )
      .get(jobId);
    expect(row).toMatchObject({
      status: "running",
      lease_token: lease?.leaseToken,
      lease_expires_at: lease?.leaseExpiresAt,
      cancel_requested_at: now + 3,
      settlement_state: "reserved",
    });
    expect(usageRows(database)).toEqual(before);
  });

  it("fences download leases and acknowledges only the matching live hash", async () => {
    const database = await queuedDatabase();
    database.sqlite
      .prepare(
        `UPDATE jobs
         SET status = 'succeeded', phase = 'completed', phase_fraction = 1,
             phase_sequence = 8, settlement_state = 'settled', actual_units = 10,
             result_kind = 'download', output_bytes = 2, output_mime = 'image/png',
             output_width = 1, output_height = 1, engine_build_id = 'engine-1',
             codec_build_id = 'codec-1', warnings_json = '[]', tested_candidates = 1,
             started_at = ?, engine_contact_started_at = ?, finished_at = ?,
             result_expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now + 2, now + 3, now + 4, now + 30 * 60_000, now + 4, jobId);
    const lifecycle = createD1LifecycleRepository(database);
    const leaseHash = "d".repeat(64);

    await expect(
      lifecycle.claimDownload({
        jobId,
        leaseHash,
        now: now + 5,
        expiresAt: now + 5 + 2 * 60_000,
      }),
    ).resolves.toMatchObject({ kind: "claimed", job: { outputBytes: 2 } });
    await expect(
      lifecycle.claimDownload({
        jobId,
        leaseHash: "e".repeat(64),
        now: now + 6,
        expiresAt: now + 6 + 2 * 60_000,
      }),
    ).resolves.toEqual({ kind: "busy" });
    const reclaimedAt = now + 5 + 2 * 60_000;
    await expect(
      lifecycle.claimDownload({
        jobId,
        leaseHash: "e".repeat(64),
        now: reclaimedAt,
        expiresAt: reclaimedAt + 2 * 60_000,
      }),
    ).resolves.toMatchObject({ kind: "claimed" });
    await expect(lifecycle.acknowledgeDownload(jobId, leaseHash, reclaimedAt + 1)).resolves.toEqual(
      { kind: "invalid-lease" },
    );
    await expect(
      lifecycle.acknowledgeDownload(jobId, "e".repeat(64), reclaimedAt + 1),
    ).resolves.toEqual({ kind: "acknowledged", outputKey });
    await expect(lifecycle.completeResultDeletion(jobId, reclaimedAt + 2)).resolves.toBe(true);
    await expect(lifecycle.loadDownloadLeaseHash(jobId)).resolves.toBeNull();
  });
});
