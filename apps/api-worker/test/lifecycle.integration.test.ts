import { env } from "cloudflare:test";
import { calculateSettledWeightedUnits } from "@hereisit/server-job";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashJobToken } from "../src/auth";
import { createD1LifecycleRepository } from "../src/d1-job-repository";
import type { Env } from "../src/env";
import {
  type LifecycleRouteRuntime,
  routeJobDownloadedRequest,
  routeJobResultRequest,
} from "../src/routes/results";
import {
  recoverStaleLeasesAndLostQueueMessages,
  sweepExpiredJobs,
  sweepOrphanArtifactsFromSavedCursor,
} from "../src/sweeper";

const token = "A".repeat(43);
const now = Date.parse("2026-07-16T12:00:00.000Z");
const objectKeys = new Set<string>();

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function jobRequest(jobId: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("cf-connecting-ip", "203.0.113.8");
  return new Request(`https://api.example/v1/jobs/${jobId}${path}`, { ...init, headers });
}

async function insertJob(input: {
  jobId: string;
  inputKey: string;
  outputKey: string;
  state: "succeeded" | "failed";
  resultExpiresAt?: number;
  downloadLeaseExpiresAt?: number;
  terminalRecordExpiresAt?: number;
}): Promise<void> {
  const sessionHash = input.jobId.replaceAll("-", "").padEnd(64, "a").slice(0, 64);
  const tokenHash = await hashJobToken(token);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO anonymous_usage (
         session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at
       ) VALUES (?, '2026-07-16', 0, 10, 0, ?, ?)`,
    ).bind(sessionHash, now, now),
    env.DB.prepare(
      `INSERT INTO jobs (
         id, client_request_id, token_hash, session_hash, day_key, status, phase,
         contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
         declared_width, declared_height, input_key, output_key, reserved_units,
         resource_class, queue_epoch, upload_expires_at, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, '2026-07-16', ?, 'completed', 'image.optimize@1',
         '{"version":1,"mode":"smart","preset":"balanced","output":"same-format","metadata":"strip","orientation":"apply","colorSpace":"srgb","minimumSavingsPercent":1}',
         ?, 3, 'image/png', 1, 1, ?, ?, 10, 'image-standard-v1', ?, ?, ?, ?
       )`,
    ).bind(
      input.jobId,
      uuid(Number(input.jobId.slice(-3)) + 500),
      tokenHash,
      sessionHash,
      input.state,
      "a".repeat(64),
      input.inputKey,
      input.outputKey,
      uuid(Number(input.jobId.slice(-3)) + 600),
      now + 10 * 60_000,
      now - 3_000,
      now - 500,
    ),
    env.DB.prepare(
      `UPDATE jobs
       SET phase_fraction = 1, phase_sequence = 8, input_etag = 'input-etag',
           output_bytes = ?, output_mime = ?, output_width = ?, output_height = ?,
           result_kind = ?, actual_units = 10, settlement_state = 'settled',
           result_expires_at = ?, terminal_record_expires_at = ?,
           download_lease_hash = ?, download_lease_expires_at = ?,
           engine_build_id = 'engine-1', codec_build_id = 'codec-1',
           warnings_json = '[]', tested_candidates = 1, error_code = ?,
           queued_at = ?, started_at = ?, engine_contact_started_at = ?, finished_at = ?
       WHERE id = ?`,
    ).bind(
      input.state === "succeeded" ? 2 : null,
      input.state === "succeeded" ? "image/png" : null,
      input.state === "succeeded" ? 1 : null,
      input.state === "succeeded" ? 1 : null,
      input.state === "succeeded" ? "download" : null,
      input.resultExpiresAt ?? null,
      input.terminalRecordExpiresAt ?? now + 24 * 60 * 60_000,
      input.downloadLeaseExpiresAt === undefined ? null : "d".repeat(64),
      input.downloadLeaseExpiresAt ?? null,
      input.state === "failed" ? "ENGINE_CRASH" : null,
      now - 2_000,
      now - 1_500,
      now - 1_000,
      now - 500,
      input.jobId,
    ),
  ]);
}

async function runtime(): Promise<LifecycleRouteRuntime> {
  return {
    now: () => now,
    randomLeaseToken: () => `${"B".repeat(42)}A`,
    networkKey: vi.fn(async () => "c".repeat(64)),
    networkRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    jobRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    downloadRateLimiter: { limit: vi.fn(async () => ({ success: true })) },
    repository: createD1LifecycleRepository(env.DB),
    artifacts: {
      getOutput: async (key) => {
        const object = await env.JOB_OBJECTS.get(key);
        if (object === null) return null;
        return {
          body: object.body,
          size: object.size,
          httpEtag: object.httpEtag,
          contentType: object.httpMetadata?.contentType,
          kind: object.customMetadata?.kind,
          jobId: object.customMetadata?.jobId,
          sha256: object.customMetadata?.sha256,
        };
      },
      deleteInput: (key) => env.JOB_OBJECTS.delete(key),
      deleteOutput: (key) => env.JOB_OBJECTS.delete(key),
    },
    engine: {
      cancel: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

afterEach(async () => {
  if (objectKeys.size > 0) await env.JOB_OBJECTS.delete([...objectKeys]);
  objectKeys.clear();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artifact_cleanup_tombstones"),
    env.DB.prepare("DELETE FROM maintenance_cursors"),
    env.DB.prepare("DELETE FROM job_quarantine"),
    env.DB.prepare("DELETE FROM job_outbox"),
    env.DB.prepare("DELETE FROM usage_ledger"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM anonymous_usage"),
    env.DB.prepare("DELETE FROM account_usage"),
    env.DB.prepare("DELETE FROM network_usage"),
  ]);
});

describe("workerd result lifecycle", () => {
  it("streams one leased attachment and deletes it only after exact acknowledgement", async () => {
    const jobId = uuid(1);
    const inputKey = `inputs/${uuid(101)}`;
    const outputKey = `outputs/${uuid(201)}`;
    objectKeys.add(outputKey);
    await insertJob({
      jobId,
      inputKey,
      outputKey,
      state: "succeeded",
      resultExpiresAt: now + 60_000,
    });
    await env.JOB_OBJECTS.put(outputKey, Uint8Array.of(1, 2), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { kind: "output", jobId },
    });
    const rt = await runtime();

    const result = await routeJobResultRequest(jobRequest(jobId, "/result"), jobId, rt);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toBe(
      'attachment; filename="hereisit-compressed.png"',
    );
    const lease = result.headers.get("x-download-lease");
    expect(lease).toHaveLength(43);
    await expect(result.arrayBuffer()).resolves.toEqual(Uint8Array.of(1, 2).buffer);

    const concurrent = await routeJobResultRequest(jobRequest(jobId, "/result"), jobId, rt);
    expect(concurrent.status).toBe(409);
    const acknowledged = await routeJobDownloadedRequest(
      jobRequest(jobId, "/downloaded", {
        method: "POST",
        headers: { "x-download-lease": lease ?? "" },
      }),
      jobId,
      rt,
    );
    expect(acknowledged.status).toBe(204);
    await expect(env.JOB_OBJECTS.head(outputKey)).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT download_acknowledged_at, download_lease_hash FROM jobs WHERE id = ?")
        .bind(jobId)
        .first(),
    ).resolves.toMatchObject({ download_acknowledged_at: now, download_lease_hash: null });
  });

  it("keeps an expired result while its lease is live, then removes it after lease expiry", async () => {
    const jobId = uuid(2);
    const inputKey = `inputs/${uuid(102)}`;
    const outputKey = `outputs/${uuid(202)}`;
    objectKeys.add(outputKey);
    await insertJob({
      jobId,
      inputKey,
      outputKey,
      state: "succeeded",
      resultExpiresAt: now - 1,
      downloadLeaseExpiresAt: now + 1,
    });
    await env.JOB_OBJECTS.put(outputKey, Uint8Array.of(1, 2), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { kind: "output", jobId },
    });

    await sweepExpiredJobs(env as Env, now, 100);
    await expect(env.JOB_OBJECTS.head(outputKey)).resolves.not.toBeNull();
    await sweepExpiredJobs(env as Env, now + 1, 100);
    await expect(env.JOB_OBJECTS.head(outputKey)).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT status, error_code, download_lease_hash FROM jobs WHERE id = ?")
        .bind(jobId)
        .first(),
    ).resolves.toEqual({ status: "expired", error_code: "EXPIRED", download_lease_hash: null });
  });

  it("drops terminal private metadata at 24 hours and finishes from a minimal tombstone", async () => {
    const jobId = uuid(3);
    const inputKey = `inputs/${uuid(103)}`;
    const outputKey = `outputs/${uuid(203)}`;
    objectKeys.add(inputKey);
    await insertJob({
      jobId,
      inputKey,
      outputKey,
      state: "failed",
      terminalRecordExpiresAt: now,
    });
    await env.JOB_OBJECTS.put(inputKey, Uint8Array.of(9));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO usage_ledger (
           job_id, session_hash, day_key, reserved_units, actual_units, outcome, settled_at, created_at
         ) SELECT id, session_hash, day_key, 10, 10, 'failed', ?, ? FROM jobs WHERE id = ?`,
      ).bind(now - 1, now - 3_000, jobId),
      env.DB.prepare(
        `INSERT INTO job_quarantine (job_id, queue_name, attempt, error_code, quarantined_at)
         VALUES (?, 'dlq', 3, 'ENGINE_CRASH', ?)`,
      ).bind(jobId, now - 1),
    ]);

    await sweepExpiredJobs(env as Env, now, 100);
    await expect(
      env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first(),
    ).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        "SELECT input_key, output_key, input_exists, output_exists, last_error_code FROM artifact_cleanup_tombstones",
      ).first(),
    ).resolves.toEqual({
      input_key: inputKey,
      output_key: null,
      input_exists: 1,
      output_exists: 0,
      last_error_code: "STORAGE_FAILURE",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM usage_ledger").first("count")).toBe(
      0,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM job_quarantine").first("count"),
    ).toBe(0);

    await sweepExpiredJobs(env as Env, now + 1, 100);
    await expect(env.JOB_OBJECTS.head(inputKey)).resolves.toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM artifact_cleanup_tombstones").first(
        "count",
      ),
    ).toBe(0);
  });

  it("advances through three saved 100-object orphan pages without starvation", async () => {
    for (let index = 1_000; index < 1_201; index += 1) {
      const key = `inputs/${uuid(index)}`;
      objectKeys.add(key);
      await env.JOB_OBJECTS.put(key, Uint8Array.of(1));
    }
    const olderThan = Date.now() + 1_000;

    expect(await sweepOrphanArtifactsFromSavedCursor(env as Env, olderThan, 100)).toBe(100);
    expect(await sweepOrphanArtifactsFromSavedCursor(env as Env, olderThan, 100)).toBe(100);
    expect(await sweepOrphanArtifactsFromSavedCursor(env as Env, olderThan, 100)).toBe(1);
    expect(await sweepOrphanArtifactsFromSavedCursor(env as Env, olderThan, 100)).toBe(0);
    const listed = await env.JOB_OBJECTS.list({ prefix: "inputs/" });
    expect(listed.objects).toHaveLength(0);
  }, 30_000);

  it("removes a stale pending PDF upload as an orphan-cleanup fallback", async () => {
    const pendingKey = `pending-inputs/${uuid(105)}/${uuid(205)}`;
    objectKeys.add(pendingKey);
    await env.JOB_OBJECTS.put(pendingKey, Uint8Array.of(1, 2, 3), {
      customMetadata: {
        kind: "pending-input",
        uploadVersion: "1",
        ownershipMarker: uuid(305),
      },
    });

    expect(await sweepOrphanArtifactsFromSavedCursor(env as Env, Date.now() + 1_000, 100)).toBe(1);
    await expect(env.JOB_OBJECTS.head(pendingKey)).resolves.toBeNull();
  });

  it("reconciles one lost Queue delivery with a new authoritative generation", async () => {
    const jobId = uuid(4);
    const inputKey = `inputs/${uuid(104)}`;
    const outputKey = `outputs/${uuid(204)}`;
    const queueEpoch = uuid(304);
    const sessionHash = "4".repeat(64);
    const payload = {
      jobId,
      contractId: "image.optimize@1",
      specHash: "a".repeat(64),
      inputKey,
      inputEtag: "input-etag",
      outputKey,
      resourceClass: "image-standard-v1",
      attempt: 1,
      queueEpoch,
      queueGeneration: 1,
    } as const;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO anonymous_usage (
           session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', 10, 0, 1, ?, ?)`,
      ).bind(sessionHash, now, now),
      env.DB.prepare(
        `INSERT INTO jobs (
           id, client_request_id, token_hash, session_hash, day_key, status, phase,
           contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
           declared_width, declared_height, input_key, input_etag, output_key,
           reserved_units, resource_class, queue_epoch, queued_at, processing_deadline_at,
           upload_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '2026-07-16', 'queued', 'queued', 'image.optimize@1',
           ?, ?, 3, 'image/png', 1, 1, ?, 'input-etag', ?, 10,
           'image-standard-v1', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        jobId,
        uuid(504),
        "f".repeat(64),
        sessionHash,
        JSON.stringify({
          version: 1,
          mode: "smart",
          preset: "balanced",
          output: "same-format",
          metadata: "strip",
          orientation: "apply",
          colorSpace: "srgb",
          minimumSavingsPercent: 1,
        }),
        payload.specHash,
        inputKey,
        outputKey,
        queueEpoch,
        now - 120_000,
        now + 60_000,
        now + 60_000,
        now - 120_000,
        now - 120_000,
      ),
      env.DB.prepare(
        `INSERT INTO job_outbox (job_id, payload, attempts, next_attempt_at, sent_at)
         VALUES (?, ?, 0, ?, ?)`,
      ).bind(jobId, JSON.stringify(payload), now - 120_000, now - 120_000),
    ]);
    const queue = { send: vi.fn(async () => undefined) };
    const maintenanceEnv = {
      DB: env.DB,
      JOB_OBJECTS: env.JOB_OBJECTS,
      IMAGE_JOBS: queue,
    } as unknown as Env;

    await expect(recoverStaleLeasesAndLostQueueMessages(maintenanceEnv, now, 100)).resolves.toBe(1);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, queueGeneration: 2 }),
      { contentType: "json" },
    );
    await expect(
      env.DB.prepare(
        `SELECT jobs.status, jobs.queue_generation, job_outbox.sent_at,
                job_outbox.reconciled_at
         FROM jobs JOIN job_outbox ON job_outbox.job_id = jobs.id WHERE jobs.id = ?`,
      )
        .bind(jobId)
        .first(),
    ).resolves.toEqual({
      status: "queued",
      queue_generation: 2,
      sent_at: now,
      reconciled_at: now,
    });
    await expect(
      recoverStaleLeasesAndLostQueueMessages(maintenanceEnv, now + 61_000, 100),
    ).resolves.toBe(0);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("expires an abandoned past-deadline lease and settles all usage once", async () => {
    const jobId = uuid(5);
    const inputKey = `inputs/${uuid(105)}`;
    const outputKey = `outputs/${uuid(205)}`;
    const queueEpoch = uuid(305);
    const sessionHash = "5".repeat(64);
    const networkHash = "6".repeat(64);
    const floor = calculateSettledWeightedUnits([]);
    const reserved = floor + 1_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_usage (
           day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES ('2026-07-16', ?, 0, 1, ?, ?)`,
      ).bind(reserved, now, now),
      env.DB.prepare(
        `INSERT INTO anonymous_usage (
           session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', ?, 0, 1, ?, ?)`,
      ).bind(sessionHash, reserved, now, now),
      env.DB.prepare(
        `INSERT INTO network_usage (
           network_hash, day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', ?, 0, 1, ?, ?)`,
      ).bind(networkHash, reserved, now, now),
      env.DB.prepare(
        `INSERT INTO jobs (
           id, client_request_id, token_hash, session_hash, network_hash,
           network_hash_expires_at, day_key, status, phase, contract_id, spec_json,
           spec_hash, declared_bytes, declared_mime, declared_width, declared_height,
           input_key, input_etag, output_key, reserved_units, resource_class,
           queue_epoch, lease_token, lease_expires_at, queued_at, processing_deadline_at,
           upload_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, '2026-07-16', 'running', 'optimizing',
           'image.optimize@1', ?, ?, 3, 'image/png', 1, 1, ?, 'input-etag', ?, ?,
           'image-standard-v1', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        jobId,
        uuid(505),
        "f".repeat(64),
        sessionHash,
        networkHash,
        now + 48 * 60 * 60_000,
        JSON.stringify({
          version: 1,
          mode: "smart",
          preset: "balanced",
          output: "same-format",
          metadata: "strip",
          orientation: "apply",
          colorSpace: "srgb",
          minimumSavingsPercent: 1,
        }),
        "a".repeat(64),
        inputKey,
        outputKey,
        reserved,
        queueEpoch,
        uuid(405),
        now - 1,
        now - 2_000,
        now,
        now + 60_000,
        now - 3_000,
        now - 1,
      ),
      env.DB.prepare(
        `INSERT INTO usage_ledger (
           job_id, session_hash, network_hash, day_key, reserved_units, created_at
         ) VALUES (?, ?, ?, '2026-07-16', ?, ?)`,
      ).bind(jobId, sessionHash, networkHash, reserved, now - 3_000),
    ]);
    const maintenanceEnv = {
      DB: env.DB,
      JOB_OBJECTS: env.JOB_OBJECTS,
      IMAGE_JOBS: { send: vi.fn(async () => undefined) },
    } as unknown as Env;

    await expect(recoverStaleLeasesAndLostQueueMessages(maintenanceEnv, now, 100)).resolves.toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT jobs.status, jobs.error_code, jobs.settlement_state, usage_ledger.outcome,
                usage_ledger.actual_units
         FROM jobs JOIN usage_ledger ON usage_ledger.job_id = jobs.id WHERE jobs.id = ?`,
      )
        .bind(jobId)
        .first(),
    ).resolves.toEqual({
      status: "expired",
      error_code: "EXPIRED",
      settlement_state: "settled",
      outcome: "expired",
      actual_units: floor,
    });
    await expect(
      env.DB.prepare(
        "SELECT reserved_units, settled_units, pending_jobs FROM account_usage WHERE day_key = '2026-07-16'",
      ).first(),
    ).resolves.toEqual({ reserved_units: 0, settled_units: floor, pending_jobs: 0 });
  });

  it("expires rotating network identity independently and bounds aggregate retention", async () => {
    const jobId = uuid(6);
    const inputKey = `inputs/${uuid(106)}`;
    const outputKey = `outputs/${uuid(206)}`;
    const expiredNetworkHash = "7".repeat(64);
    const freshNetworkHash = "8".repeat(64);
    await insertJob({
      jobId,
      inputKey,
      outputKey,
      state: "succeeded",
      resultExpiresAt: now + 60_000,
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE jobs SET network_hash = ?, network_hash_expires_at = ? WHERE id = ?",
      ).bind(expiredNetworkHash, now, jobId),
      env.DB.prepare(
        `INSERT INTO usage_ledger (
           job_id, session_hash, network_hash, day_key, reserved_units, actual_units,
           outcome, settled_at, created_at
         ) SELECT id, session_hash, ?, day_key, 10, 10, 'succeeded', ?, ?
           FROM jobs WHERE id = ?`,
      ).bind(expiredNetworkHash, now - 1, now - 3_000, jobId),
      env.DB.prepare(
        `INSERT INTO network_usage (
           network_hash, day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', 0, 10, 0, ?, ?)`,
      ).bind(expiredNetworkHash, now - 48 * 60 * 60_000, now - 48 * 60 * 60_000),
      env.DB.prepare(
        `INSERT INTO network_usage (
           network_hash, day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', 0, 10, 0, ?, ?)`,
      ).bind(freshNetworkHash, now - 48 * 60 * 60_000 + 1, now),
      env.DB.prepare(
        `INSERT INTO account_usage (
           day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES ('2026-05-01', 0, 10, 0, ?, ?)`,
      ).bind(now - 35 * 24 * 60 * 60_000, now),
      env.DB.prepare(
        `INSERT INTO anonymous_usage (
           session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at
         ) VALUES (?, '2026-05-01', 0, 10, 0, ?, ?)`,
      ).bind("9".repeat(64), now - 35 * 24 * 60 * 60_000, now),
    ]);

    await sweepExpiredJobs(env as Env, now, 100);

    await expect(
      env.DB.prepare("SELECT network_hash FROM jobs WHERE id = ?").bind(jobId).first(),
    ).resolves.toEqual({ network_hash: null });
    await expect(
      env.DB.prepare("SELECT network_hash FROM usage_ledger WHERE job_id = ?").bind(jobId).first(),
    ).resolves.toEqual({ network_hash: null });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM network_usage WHERE network_hash = ?")
        .bind(expiredNetworkHash)
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM network_usage WHERE network_hash = ?")
        .bind(freshNetworkHash)
        .first("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM account_usage WHERE day_key = '2026-05-01'",
      ).first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM anonymous_usage WHERE day_key = '2026-05-01'",
      ).first("count"),
    ).toBe(0);
  });

  it("settles an expired upload reservation and removes a partial input", async () => {
    const jobId = uuid(7);
    const inputKey = `inputs/${uuid(107)}`;
    const outputKey = `outputs/${uuid(207)}`;
    const sessionHash = "a".repeat(64);
    const networkHash = "b".repeat(64);
    const floor = calculateSettledWeightedUnits([]);
    const reserved = floor + 1_000;
    objectKeys.add(inputKey);
    await env.JOB_OBJECTS.put(inputKey, Uint8Array.of(1));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_usage (
           day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES ('2026-07-16', ?, 0, 1, ?, ?)`,
      ).bind(reserved, now, now),
      env.DB.prepare(
        `INSERT INTO anonymous_usage (
           session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', ?, 0, 1, ?, ?)`,
      ).bind(sessionHash, reserved, now, now),
      env.DB.prepare(
        `INSERT INTO network_usage (
           network_hash, day_key, reserved_units, settled_units, pending_jobs, created_at, updated_at
         ) VALUES (?, '2026-07-16', ?, 0, 1, ?, ?)`,
      ).bind(networkHash, reserved, now, now),
      env.DB.prepare(
        `INSERT INTO jobs (
           id, client_request_id, token_hash, session_hash, network_hash,
           network_hash_expires_at, day_key, status, phase, contract_id, spec_json,
           spec_hash, declared_bytes, declared_mime, declared_width, declared_height,
           input_key, output_key, reserved_units, resource_class, queue_epoch,
           upload_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, '2026-07-16', 'created', 'uploading',
           'image.optimize@1', ?, ?, 3, 'image/png', 1, 1, ?, ?, ?,
           'image-standard-v1', ?, ?, ?, ?)`,
      ).bind(
        jobId,
        uuid(507),
        "c".repeat(64),
        sessionHash,
        networkHash,
        now + 48 * 60 * 60_000,
        JSON.stringify({
          version: 1,
          mode: "smart",
          preset: "balanced",
          output: "same-format",
          metadata: "strip",
          orientation: "apply",
          colorSpace: "srgb",
          minimumSavingsPercent: 1,
        }),
        "d".repeat(64),
        inputKey,
        outputKey,
        reserved,
        uuid(307),
        now,
        now - 1_000,
        now - 1_000,
      ),
      env.DB.prepare(
        `INSERT INTO usage_ledger (
           job_id, session_hash, network_hash, day_key, reserved_units, created_at
         ) VALUES (?, ?, ?, '2026-07-16', ?, ?)`,
      ).bind(jobId, sessionHash, networkHash, reserved, now - 1_000),
    ]);

    await sweepExpiredJobs(env as Env, now, 100);

    await expect(env.JOB_OBJECTS.head(inputKey)).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        `SELECT jobs.status, jobs.error_code, jobs.settlement_state,
                usage_ledger.outcome, usage_ledger.actual_units
         FROM jobs JOIN usage_ledger ON usage_ledger.job_id = jobs.id WHERE jobs.id = ?`,
      )
        .bind(jobId)
        .first(),
    ).resolves.toEqual({
      status: "expired",
      error_code: "UPLOAD_EXPIRED",
      settlement_state: "settled",
      outcome: "expired",
      actual_units: floor,
    });
  });
});
