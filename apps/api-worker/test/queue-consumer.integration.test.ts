import { env } from "cloudflare:test";
import type { EngineJobStatus } from "@hereisit/server-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineClient } from "../src/container-client";
import type { Env } from "../src/env";
import {
  consumeImageJob,
  createR2QueueArtifactStore,
  VerificationFailureError,
} from "../src/queue-consumer";

const jobId = "550e8400-e29b-41d4-a716-446655440000";
const outputKey = "outputs/22222222-2222-4222-8222-222222222222";

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function digestHeader(bytes: Uint8Array): Promise<string> {
  return `sha-256=${base64(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))}`;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function recoveryStatus(byteLength: number): Extract<EngineJobStatus, { state: "succeeded" }> {
  return {
    protocol: 1,
    jobId,
    state: "succeeded",
    phase: "preparing-output",
    fraction: 1,
    sequence: 2,
    result: {
      kind: "download",
      mime: "image/png",
      byteLength,
      width: 1,
      height: 1,
      testedCandidates: 1,
      engineBuildId: "engine-1",
      codecBuildId: "codec-1",
      warnings: [],
    },
    inspection: {
      verifiedInputMime: "image/png",
      inputHasAlpha: true,
      contentClass: "flat-graphic",
    },
    measurements: {
      processedInputBytes: byteLength + 1,
      processedPixels: 1,
      cpuMs: 1,
      memoryByteMilliseconds: 1,
      peakMemoryBytes: 1,
      testedCandidates: 1,
      processingMs: 1,
    },
  };
}

afterEach(async () => {
  await env.JOB_OBJECTS.delete(outputKey);
});

describe("workerd output artifact streaming", () => {
  it("streams through fixed-length and SHA-256 verification into create-only R2", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const artifacts = createR2QueueArtifactStore(env.JOB_OBJECTS);

    await artifacts.storeOutput({
      key: outputKey,
      body: stream(bytes),
      byteLength: bytes.byteLength,
      mime: "image/png",
      digestHeader: await digestHeader(bytes),
      jobId,
      engineBuildId: "engine-1",
      recoveryStatus: recoveryStatus(bytes.byteLength),
    });

    const stored = await env.JOB_OBJECTS.get(outputKey);
    expect(stored?.size).toBe(bytes.byteLength);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
    expect(stored?.customMetadata).toMatchObject({
      kind: "output",
      jobId,
      engineBuildId: "engine-1",
    });
    await expect(artifacts.headOutput(outputKey)).resolves.toMatchObject({
      recoveryStatus: {
        jobId,
        state: "succeeded",
        result: { kind: "download", byteLength: bytes.byteLength },
      },
    });
    await expect(stored?.arrayBuffer()).resolves.toEqual(bytes.buffer);
  });

  it("deletes a newly written object when the streamed digest mismatches", async () => {
    const artifacts = createR2QueueArtifactStore(env.JOB_OBJECTS);
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(
      artifacts.storeOutput({
        key: outputKey,
        body: stream(bytes),
        byteLength: bytes.byteLength,
        mime: "image/png",
        digestHeader: `sha-256=${"A".repeat(43)}=`,
        jobId,
        engineBuildId: "engine-1",
        recoveryStatus: recoveryStatus(bytes.byteLength),
      }),
    ).rejects.toBeInstanceOf(VerificationFailureError);
    await expect(env.JOB_OBJECTS.head(outputKey)).resolves.toBeNull();
  });

  it("never deletes an existing first-writer object when a later stream is corrupt", async () => {
    await env.JOB_OBJECTS.put(outputKey, new Uint8Array([9]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        kind: "output",
        jobId,
        sha256: `${"A".repeat(43)}=`,
        engineBuildId: "engine-1",
      },
    });
    const artifacts = createR2QueueArtifactStore(env.JOB_OBJECTS);

    await expect(
      artifacts.storeOutput({
        key: outputKey,
        body: stream(new Uint8Array([1])),
        byteLength: 1,
        mime: "image/png",
        digestHeader: `sha-256=${"A".repeat(43)}=`,
        jobId,
        engineBuildId: "engine-1",
        recoveryStatus: recoveryStatus(1),
      }),
    ).rejects.toBeInstanceOf(VerificationFailureError);
    await expect(env.JOB_OBJECTS.head(outputKey)).resolves.toMatchObject({ size: 1 });
  });

  it("rejects a short stream without publishing an object", async () => {
    const artifacts = createR2QueueArtifactStore(env.JOB_OBJECTS);
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(
      artifacts.storeOutput({
        key: outputKey,
        body: stream(bytes),
        byteLength: bytes.byteLength + 1,
        mime: "image/png",
        digestHeader: await digestHeader(bytes),
        jobId,
        engineBuildId: "engine-1",
        recoveryStatus: recoveryStatus(bytes.byteLength + 1),
      }),
    ).rejects.toThrow();
    await expect(env.JOB_OBJECTS.head(outputKey)).resolves.toBeNull();
  });
});

describe("workerd fenced settlement", () => {
  it("claims, settles all ledgers once, and treats redelivery as a duplicate", async () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const dayKey = "2026-07-16";
    const sessionHash = "b".repeat(64);
    const networkHash = "c".repeat(64);
    const inputKey = "inputs/11111111-1111-4111-8111-111111111111";
    const queueEpoch = "33333333-3333-4333-8333-333333333333";
    const reservedUnits = 3_000_000_000;
    const specJson = JSON.stringify({
      version: 1,
      mode: "smart",
      preset: "balanced",
      output: "same-format",
      metadata: "strip",
      orientation: "apply",
      colorSpace: "srgb",
      minimumSavingsPercent: 1,
    });
    const specHashHex = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(specJson))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_usage
          (day_key, reserved_units, pending_jobs, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).bind(dayKey, reservedUnits, now, now),
      env.DB.prepare(
        `INSERT INTO anonymous_usage
          (session_hash, day_key, reserved_units, active_jobs, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(sessionHash, dayKey, reservedUnits, now, now),
      env.DB.prepare(
        `INSERT INTO network_usage
          (network_hash, day_key, reserved_units, pending_jobs, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(networkHash, dayKey, reservedUnits, now, now),
      env.DB.prepare(
        `INSERT INTO jobs (
          id, client_request_id, token_hash, session_hash, network_hash,
          network_hash_expires_at, day_key, status, phase, contract_id, spec_json, spec_hash,
          declared_bytes, declared_mime, declared_width, declared_height, input_key, input_etag,
          upload_version, output_key, reserved_units, resource_class, queue_epoch, queue_generation,
          upload_expires_at, processing_deadline_at, queued_at, created_at, updated_at
        ) VALUES (
          ?, '66666666-6666-4666-8666-666666666666', ?, ?, ?, ?, ?, 'queued', 'queued',
          'image.optimize@1', ?, ?, 3, 'image/png', 1, 1, ?, 'input-etag', 1, ?, ?,
          'image-standard-v1', ?, 1, ?, ?, ?, ?, ?
        )`,
      ).bind(
        jobId,
        "d".repeat(64),
        sessionHash,
        networkHash,
        now + 48 * 60 * 60_000,
        dayKey,
        specJson,
        specHashHex,
        inputKey,
        outputKey,
        reservedUnits,
        queueEpoch,
        now + 60_000,
        now + 20 * 60_000,
        now - 1_000,
        now - 2_000,
        now - 1_000,
      ),
      env.DB.prepare(
        `INSERT INTO usage_ledger
          (job_id, session_hash, network_hash, day_key, reserved_units, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(jobId, sessionHash, networkHash, dayKey, reservedUnits, now),
    ]);
    const message = {
      jobId,
      contractId: "image.optimize@1",
      specHash: specHashHex,
      inputKey,
      inputEtag: "input-etag",
      outputKey,
      resourceClass: "image-standard-v1",
      attempt: 1,
      queueEpoch,
      queueGeneration: 1,
    } as const;
    let returnOom = true;
    const engine: EngineClient = {
      create: async () => ({ coldStart: false, containerReadyMs: 1 }),
      upload: async (_id, body) => {
        const reader = body.getReader();
        while (!(await reader.read()).done) {}
      },
      run: async () => undefined,
      status: async () => {
        const measurements = {
          processedInputBytes: 3,
          processedPixels: 1,
          cpuMs: 2,
          memoryByteMilliseconds: 3,
          peakMemoryBytes: 4,
          testedCandidates: 1,
          processingMs: 5,
        } as const;
        const inspection = {
          verifiedInputMime: "image/png",
          inputHasAlpha: true,
          contentClass: "flat-graphic",
        } as const;
        if (returnOom) {
          return {
            protocol: 1,
            jobId,
            state: "failed",
            phase: "optimizing",
            fraction: 0.5,
            sequence: 2,
            measurements,
            inspection,
            error: { code: "ENGINE_OOM", retryable: true },
          };
        }
        return {
          protocol: 1,
          jobId,
          state: "succeeded",
          phase: "preparing-output",
          fraction: 1,
          sequence: 2,
          result: {
            kind: "original-retained",
            testedCandidates: 1,
            engineBuildId: "engine-1",
            codecBuildId: "codec-1",
            warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
          },
          inspection,
          measurements,
        };
      },
      output: async () => new Response(null, { status: 409 }),
      cancel: async () => undefined,
      remove: async () => undefined,
    };
    const artifacts = {
      getInput: async () => ({
        body: stream(new Uint8Array([1, 2, 3])),
        size: 3,
        etag: "input-etag",
        httpMetadata: { contentType: "image/png" as const },
      }),
      headOutput: async () => null,
      storeOutput: async () => undefined,
      deleteInput: async () => undefined,
      deleteOutput: async () => undefined,
    };

    await expect(
      consumeImageJob(message, env as Env, {
        engine,
        artifacts,
        now: () => now,
        leaseHeartbeat: false,
      }),
    ).resolves.toBe("retry-scheduled");
    const retry = await env.DB.prepare(
      `SELECT status, attempt, queue_generation, resource_class, settlement_state
       FROM jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first<Record<string, unknown>>();
    expect(retry).toEqual({
      status: "queued",
      attempt: 2,
      queue_generation: 2,
      resource_class: "image-large-v1",
      settlement_state: "reserved",
    });
    expect(
      await env.DB.prepare(`SELECT sent_at, payload FROM job_outbox WHERE job_id = ?`)
        .bind(jobId)
        .first<Record<string, unknown>>(),
    ).toMatchObject({ sent_at: now, payload: expect.any(String) });

    returnOom = false;
    const retryMessage = {
      ...message,
      resourceClass: "image-large-v1" as const,
      attempt: 2 as const,
      queueGeneration: 2,
    };
    await expect(
      consumeImageJob(retryMessage, env as Env, {
        engine,
        artifacts,
        now: () => now,
        leaseHeartbeat: false,
      }),
    ).resolves.toBe("completed");
    await expect(
      consumeImageJob(retryMessage, env as Env, {
        engine,
        artifacts,
        now: () => now,
        leaseHeartbeat: false,
      }),
    ).resolves.toBe("duplicate");

    const job = await env.DB.prepare(
      `SELECT status, settlement_state, actual_units, result_kind, lease_token
       FROM jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first<Record<string, unknown>>();
    expect(job).toMatchObject({
      status: "succeeded",
      settlement_state: "settled",
      actual_units: expect.any(Number),
      result_kind: "original-retained",
      lease_token: null,
    });
    const actualUnits = job?.actual_units;
    expect(
      await env.DB.prepare(
        `SELECT reserved_units, settled_units, pending_jobs
         FROM account_usage WHERE day_key = ?`,
      )
        .bind(dayKey)
        .first(),
    ).toEqual({ reserved_units: 0, settled_units: actualUnits, pending_jobs: 0 });
    expect(
      await env.DB.prepare(
        `SELECT actual_units, outcome, settled_at FROM usage_ledger WHERE job_id = ?`,
      )
        .bind(jobId)
        .first(),
    ).toEqual({ actual_units: actualUnits, outcome: "succeeded", settled_at: now });
  });
});
