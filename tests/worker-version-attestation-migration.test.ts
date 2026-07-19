import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWorkerVersionAttestationBatch } from "../scripts/verify-worker-version-chain.mjs";

const migrations = [
  "apps/api-worker/migrations/0001_processing_jobs.sql",
  "apps/api-worker/migrations/0002_worker_version_attestations.sql",
].map((path) => readFileSync(path, "utf8"));

const hashes = {
  worker: "a".repeat(64),
  config: "b".repeat(64),
  report: "c".repeat(64),
};

type Attestation = {
  versionId?: string;
  workerModuleSha256?: string;
  generatedConfigSha256?: string;
  releaseReportSha256?: string;
  kind?: string;
  publicAdmissionAllowed?: number;
  observedAt?: number;
  retiredAt?: number | null;
};

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration);
  return database;
}

function insertAttestation(database: DatabaseSync, overrides: Attestation = {}) {
  const value = {
    versionId: "00000000-0000-0000-0000-000000000001",
    workerModuleSha256: hashes.worker,
    generatedConfigSha256: hashes.config,
    releaseReportSha256: hashes.report,
    kind: "active",
    publicAdmissionAllowed: 1,
    observedAt: 1_700_000_000_000,
    retiredAt: null,
    ...overrides,
  };
  database
    .prepare(
      `INSERT INTO worker_version_attestations (
        version_id,
        worker_module_sha256,
        generated_config_sha256,
        release_report_sha256,
        kind,
        public_admission_allowed,
        observed_at,
        retired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      value.versionId,
      value.workerModuleSha256,
      value.generatedConfigSha256,
      value.releaseReportSha256,
      value.kind,
      value.publicAdmissionAllowed,
      value.observedAt,
      value.retiredAt,
    );
}

describe("Worker version attestation migration", () => {
  it("creates the exact persisted contract and accepts a valid active attestation", () => {
    const database = createDatabase();

    insertAttestation(database);

    const columns = database
      .prepare("PRAGMA table_info(worker_version_attestations)")
      .all()
      .map((column) => column.name);
    expect(columns).toEqual([
      "version_id",
      "worker_module_sha256",
      "generated_config_sha256",
      "release_report_sha256",
      "kind",
      "public_admission_allowed",
      "observed_at",
      "retired_at",
    ]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM worker_version_attestations").get(),
    ).toEqual({ count: 1 });
  });

  it.each([
    ["malformed version ID", { versionId: "not-a-version" }],
    ["uppercase version ID", { versionId: "00000000-0000-0000-0000-00000000000A" }],
    ["short Worker hash", { workerModuleSha256: "a".repeat(63) }],
    ["uppercase config hash", { generatedConfigSha256: "B".repeat(64) }],
    ["non-hex report hash", { releaseReportSha256: "z".repeat(64) }],
    ["unknown kind", { kind: "candidate" }],
    ["invalid admission flag", { publicAdmissionAllowed: 2 }],
    ["negative observation time", { observedAt: -1 }],
    ["fractional observation time", { observedAt: 1.5 }],
    ["public bootstrap", { kind: "bootstrap", publicAdmissionAllowed: 1 }],
    ["unretired retired version", { kind: "retired", publicAdmissionAllowed: 0 }],
    ["retirement on an active version", { retiredAt: 1_700_000_000_001 }],
    [
      "fractional retirement time",
      {
        kind: "retired",
        publicAdmissionAllowed: 0,
        observedAt: 1,
        retiredAt: 1.5,
      },
    ],
  ] satisfies Array<[string, Attestation]>)("rejects %s", (_label, overrides) => {
    const database = createDatabase();

    expect(() => insertAttestation(database, overrides)).toThrow();
  });

  it("requires retirement to follow observation", () => {
    const database = createDatabase();

    expect(() =>
      insertAttestation(database, {
        kind: "retired",
        publicAdmissionAllowed: 0,
        retiredAt: 1_699_999_999_999,
      }),
    ).toThrow();
  });

  it("permits at most one active version", () => {
    const database = createDatabase();
    insertAttestation(database);

    expect(() =>
      insertAttestation(database, {
        versionId: "00000000-0000-0000-0000-000000000002",
      }),
    ).toThrow();
  });

  it("applies the generated deployment batch atomically against the persisted contract", () => {
    const database = createDatabase();
    const versionIds = Array.from(
      { length: 7 },
      (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    );
    insertAttestation(database, {
      versionId: versionIds[0],
      observedAt: Date.parse("2026-07-19T00:00:00.000Z"),
    });
    const batch = createWorkerVersionAttestationBatch({
      schema: "hereisit-worker-version-attestations@1",
      version: 1,
      verifiedAt: "2026-07-19T00:08:00.000Z",
      workerModuleSha256: hashes.worker,
      generatedConfigSha256: hashes.config,
      releaseReportSha256: hashes.report,
      activeVersionId: versionIds[6],
      previousActive: {
        versionId: versionIds[0],
        state: "retiring",
        retireAfter: "2026-07-19T00:18:00.000Z",
      },
      versions: versionIds.slice(1).map((versionId, index) => ({
        versionId,
        state: index === 0 ? "bootstrap" : index === 5 ? "active" : "secret-intermediate",
        publicAdmissionPercent: 0,
      })),
    });

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of batch.statements) {
        database.prepare(statement.sql).run(...statement.params);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    for (const query of batch.verification) {
      expect(database.prepare(query.sql).all(...query.params)).toEqual(query.expected);
    }
    expect(
      database
        .prepare("SELECT version_id AS versionId FROM worker_version_attestations WHERE kind = ?")
        .all("active"),
    ).toEqual([{ versionId: versionIds[6] }]);
  });
});
