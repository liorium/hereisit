import { env, exports } from "cloudflare:workers";
import { imageJobMessageSchema } from "@hereisit/server-contracts";
import { imageOptimizeCreateResponseSchema } from "@hereisit/tool-contracts/image-optimize";
import { afterEach, describe, expect, it } from "vitest";
import { createD1JobRepository } from "../src/d1-job-repository";
import { dispatchJobOutbox } from "../src/outbox";
import { deleteAuthorizedArtifact, storeExactInputArtifact } from "../src/r2-artifacts";
import { routeUploadRequest } from "../src/routes/uploads";

const createdJobIds = new Set<string>();
const jobToken = "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA";
const currentSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const previousSecret = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

function imageCreateBody(input: {
  anonymousSessionId: string;
  clientRequestId: string;
  byteLength?: number;
}) {
  return {
    jobContract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId: input.anonymousSessionId,
    clientRequestId: input.clientRequestId,
    jobToken,
    input: {
      byteLength: input.byteLength ?? 3,
      mimeHint: "image/png",
      width: 1,
      height: 1,
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
  };
}

async function createJobRequest(input: {
  anonymousSessionId: string;
  clientRequestId: string;
  ip: string;
}) {
  return exports.default.fetch("https://api.example/v1/jobs", {
    method: "POST",
    headers: {
      "cf-connecting-ip": input.ip,
      "content-type": "application/json",
      origin: "http://localhost:4173",
    },
    body: JSON.stringify(imageCreateBody(input)),
  });
}

async function rememberCreatedJob(response: Response) {
  const payload = imageOptimizeCreateResponseSchema.parse(await response.json());
  createdJobIds.add(payload.jobId);
  return payload;
}

afterEach(async () => {
  for (const jobId of createdJobIds) {
    const row = await env.DB.prepare(
      `SELECT jobs.input_key, jobs.output_key, jobs.session_hash, jobs.network_hash,
              jobs.day_key, jobs.reserved_units, jobs.settlement_state
       FROM jobs
       WHERE jobs.id = ?`,
    )
      .bind(jobId)
      .first<{
        input_key: string;
        output_key: string | null;
        session_hash: string;
        network_hash: string | null;
        day_key: string;
        reserved_units: number;
        settlement_state: "reserved" | "settled";
      }>();
    if (row === null) continue;
    await Promise.all([
      env.JOB_OBJECTS.delete(row.input_key),
      row.output_key === null ? Promise.resolve() : env.JOB_OBJECTS.delete(row.output_key),
    ]);
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId).run();
    if (row.settlement_state === "reserved") {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE account_usage
           SET reserved_units = reserved_units - ?,
               pending_jobs = pending_jobs - 1
           WHERE day_key = ?`,
        ).bind(row.reserved_units, row.day_key),
        env.DB.prepare(
          `UPDATE anonymous_usage
           SET reserved_units = reserved_units - ?,
               active_jobs = active_jobs - 1
           WHERE session_hash = ? AND day_key = ?`,
        ).bind(row.reserved_units, row.session_hash, row.day_key),
        row.network_hash === null
          ? env.DB.prepare("SELECT 1")
          : env.DB.prepare(
              `UPDATE network_usage
               SET reserved_units = reserved_units - ?,
                   pending_jobs = pending_jobs - 1
               WHERE network_hash = ? AND day_key = ?`,
            ).bind(row.reserved_units, row.network_hash, row.day_key),
      ]);
    }
  }
  createdJobIds.clear();
});

interface D1TableColumn {
  name: string;
  notnull: number;
  pk: number;
}

const primaryKeyColumns = [
  ["account_usage", "day_key"],
  ["jobs", "id"],
  ["usage_ledger", "job_id"],
  ["job_outbox", "job_id"],
  ["maintenance_cursors", "task"],
  ["job_quarantine", "job_id"],
  ["worker_version_attestations", "version_id"],
  ["operational_alert_state", "kind"],
  ["artifact_presence_audit", "job_id"],
] as const;

describe("Worker control-plane bindings and routes", () => {
  it("applies migrations and exposes non-null D1 primary-key identities", async () => {
    const migration = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
    ).first<{ name: string }>();
    expect(migration?.name).toBe("0003_circuit_breaker.sql");

    for (const [table, column] of primaryKeyColumns) {
      const schema = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<D1TableColumn>();
      expect(schema.results.find((entry) => entry.name === column)).toMatchObject({
        name: column,
        notnull: 1,
        pk: 1,
      });
    }
  });

  it("streams an R2 object through put, head, and delete", async () => {
    const key = `integration/${crypto.randomUUID()}`;
    const chunks = [
      new TextEncoder().encode("worker-runtime-"),
      new TextEncoder().encode("streaming-r2"),
    ];
    const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const stream = new FixedLengthStream(byteLength);
    const writer = stream.writable.getWriter();
    const upload = env.JOB_OBJECTS.put(key, stream.readable, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { source: "worker-integration" },
    });

    try {
      for (const chunk of chunks) {
        await writer.write(chunk);
      }
      await writer.close();
      await upload;

      const stored = await env.JOB_OBJECTS.head(key);
      expect(stored).toMatchObject({
        key,
        size: byteLength,
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { source: "worker-integration" },
      });
    } finally {
      await env.JOB_OBJECTS.delete(key);
    }

    await expect(env.JOB_OBJECTS.head(key)).resolves.toBeNull();
  });

  it("routes a policy request through the real Worker and bindings", async () => {
    const response = await exports.default.fetch("https://api.example/v1/policy", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.77",
        "content-type": "application/json",
        origin: "http://localhost:4173",
      },
      body: JSON.stringify({
        contract: "tool-job@1",
        toolContract: "image.optimize@1",
        anonymousSessionId: "018f47a2-65d4-7f31-a377-5afbb8f53f27",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4173");
    await expect(response.json()).resolves.toMatchObject({
      contract: "tool-job@1",
      toolContract: "image.optimize@1",
      execution: "server",
      reason: null,
      disclosure: { upload: true },
    });
  });

  it("reserves one real D1 job for two concurrent create requests", async () => {
    const anonymousSessionId = crypto.randomUUID();
    const clientRequestId = crypto.randomUUID();
    const responses = await Promise.all([
      createJobRequest({
        anonymousSessionId,
        clientRequestId,
        ip: "203.0.114.77",
      }),
      createJobRequest({
        anonymousSessionId,
        clientRequestId,
        ip: "203.0.114.77",
      }),
    ]);
    const payloads = await Promise.all(responses.map((response) => rememberCreatedJob(response)));

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
    expect(new Set(payloads.map(({ jobId }) => jobId)).size).toBe(1);
    const persisted = await env.DB.prepare(
      `SELECT jobs.id, jobs.reserved_units, jobs.session_hash, jobs.network_hash,
              account_usage.pending_jobs AS account_pending,
              anonymous_usage.active_jobs AS anonymous_active,
              network_usage.pending_jobs AS network_pending,
              (SELECT COUNT(*) FROM usage_ledger WHERE job_id = jobs.id) AS ledger_count
       FROM jobs
       JOIN account_usage ON account_usage.day_key = jobs.day_key
       JOIN anonymous_usage
         ON anonymous_usage.session_hash = jobs.session_hash
        AND anonymous_usage.day_key = jobs.day_key
       JOIN network_usage
         ON network_usage.network_hash = jobs.network_hash
        AND network_usage.day_key = jobs.day_key
       WHERE jobs.client_request_id = ?`,
    )
      .bind(clientRequestId)
      .all<{
        id: string;
        reserved_units: number;
        session_hash: string;
        network_hash: string;
        account_pending: number;
        anonymous_active: number;
        network_pending: number;
        ledger_count: number;
      }>();

    expect(persisted.results).toHaveLength(1);
    expect(persisted.results[0]).toMatchObject({
      account_pending: 1,
      anonymous_active: 1,
      network_pending: 1,
      ledger_count: 1,
    });

    const conflictingBody = imageCreateBody({
      anonymousSessionId,
      clientRequestId,
    });
    conflictingBody.spec.preset = "smallest";
    const conflict = await exports.default.fetch("https://api.example/v1/jobs", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.114.77",
        "content-type": "application/json",
        origin: "http://localhost:4173",
      },
      body: JSON.stringify(conflictingBody),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      contract: "tool-job@1",
      error: { code: "INVALID_REQUEST", retryable: false },
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE client_request_id = ?")
        .bind(clientRequestId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
    const afterConflict = await env.DB.prepare(
      `SELECT jobs.id, jobs.reserved_units, jobs.session_hash, jobs.network_hash,
              account_usage.pending_jobs AS account_pending,
              anonymous_usage.active_jobs AS anonymous_active,
              network_usage.pending_jobs AS network_pending,
              (SELECT COUNT(*) FROM usage_ledger WHERE job_id = jobs.id) AS ledger_count
       FROM jobs
       JOIN account_usage ON account_usage.day_key = jobs.day_key
       JOIN anonymous_usage
         ON anonymous_usage.session_hash = jobs.session_hash
        AND anonymous_usage.day_key = jobs.day_key
       JOIN network_usage
         ON network_usage.network_hash = jobs.network_hash
        AND network_usage.day_key = jobs.day_key
       WHERE jobs.client_request_id = ?`,
    )
      .bind(clientRequestId)
      .all();
    expect(afterConflict.results).toEqual(persisted.results);
  });

  it("converges two exact streamed uploads on one R2 object and one outbox row", async () => {
    const anonymousSessionId = crypto.randomUUID();
    const clientRequestId = crypto.randomUUID();
    const createResponse = await createJobRequest({
      anonymousSessionId,
      clientRequestId,
      ip: "203.0.115.77",
    });
    const created = await rememberCreatedJob(createResponse);
    expect(createResponse.status).toBe(201);

    const upload = (bytes: Uint8Array) =>
      exports.default.fetch(`https://api.example/v1/jobs/${created.jobId}/input`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${jobToken}`,
          "cf-connecting-ip": "203.0.115.77",
          "content-length": "3",
          "content-type": "image/png",
          origin: "http://localhost:4173",
        },
        body: Uint8Array.from(bytes).buffer,
      });
    const responses = await Promise.all([
      upload(Uint8Array.of(1, 2, 3)),
      upload(Uint8Array.of(9, 8, 7)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([204, 204]);
    await Promise.all(responses.map((response) => expect(response.text()).resolves.toBe("")));
    const job = await env.DB.prepare(
      `SELECT input_key, input_etag, upload_version, status
       FROM jobs WHERE id = ?`,
    )
      .bind(created.jobId)
      .first<{
        input_key: string;
        input_etag: string;
        upload_version: number;
        status: string;
      }>();
    expect(job).toMatchObject({
      input_etag: expect.any(String),
      upload_version: 1,
      status: "queued",
    });
    if (job === null) throw new Error("Queued job was not persisted.");
    await expect(env.JOB_OBJECTS.head(job.input_key)).resolves.toMatchObject({
      key: job.input_key,
      size: 3,
      etag: job.input_etag,
      httpMetadata: { contentType: "image/png" },
      customMetadata: { kind: "input", uploadVersion: "1" },
    });
    const outbox = await env.DB.prepare(
      `SELECT payload, attempts, next_attempt_at, sent_at
       FROM job_outbox
       WHERE job_id = ?`,
    )
      .bind(created.jobId)
      .first<{
        payload: string;
        attempts: number;
        next_attempt_at: number;
        sent_at: number | null;
      }>();
    expect(outbox).toMatchObject({
      attempts: 0,
      next_attempt_at: expect.any(Number),
      sent_at: expect.any(Number),
    });
    if (outbox === null) throw new Error("Queued job was missing its outbox row.");
    expect(imageJobMessageSchema.parse(JSON.parse(outbox.payload))).toMatchObject({
      jobId: created.jobId,
      inputKey: job.input_key,
      inputEtag: job.input_etag,
      queueGeneration: 1,
    });

    let repeatedBodyRead = false;
    const repeatedBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          repeatedBodyRead = true;
          controller.error(new Error("committed replay body was consumed"));
        },
      },
      { highWaterMark: 0 },
    );
    const replay = await routeUploadRequest(
      new Request(`https://api.example/v1/jobs/${created.jobId}/input`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${jobToken}`,
          "cf-connecting-ip": "203.0.115.77",
          "content-length": "3",
          "content-type": "image/png",
          origin: "http://localhost:4173",
        },
        body: repeatedBody,
      }),
      created.jobId,
      {
        config: { appOrigins: [new URL("http://localhost:4173")] },
        currentSecret,
        previousSecret,
        networkRateLimiter: env.JOB_API_NETWORK_RATE_LIMITER,
        repository: createD1JobRepository(env.DB),
        storeInput: (input) =>
          storeExactInputArtifact({
            bucket: env.JOB_OBJECTS,
            ...input,
          }),
        deleteInput: (authorization) => deleteAuthorizedArtifact(env.JOB_OBJECTS, authorization),
        dispatchOutbox: (replayJobId, now) =>
          dispatchJobOutbox({ DB: env.DB, IMAGE_JOBS: env.IMAGE_JOBS }, replayJobId, now),
        now: Date.now,
      },
    );
    expect(replay.status).toBe(204);
    expect(repeatedBodyRead).toBe(false);
  });
});
