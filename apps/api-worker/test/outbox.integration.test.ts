import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchJobOutbox, dispatchPendingOutbox } from "../src/outbox";

const seededJobs = new Set<string>();

function message(jobId: string, queueGeneration = 1) {
  return {
    jobId,
    contractId: "image.optimize@1",
    specHash: "a".repeat(64),
    inputKey: `inputs/${crypto.randomUUID()}`,
    inputEtag: "raw-etag",
    outputKey: `outputs/${crypto.randomUUID()}`,
    resourceClass: "image-standard-v1",
    attempt: 1,
    queueEpoch: crypto.randomUUID(),
    queueGeneration,
  };
}

async function seedOutbox(payload: string, now: number, attempts = 0) {
  let jobId: string = crypto.randomUUID();
  try {
    const parsed = JSON.parse(payload) as { jobId?: unknown };
    if (typeof parsed.jobId === "string") jobId = parsed.jobId;
  } catch {
    // Corrupt persisted payloads still belong to a valid outbox row.
  }
  const sessionHash = `session-${jobId}`;
  seededJobs.add(jobId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO anonymous_usage (
          session_hash, day_key, reserved_units, settled_units, active_jobs, created_at, updated_at
        ) VALUES (?, '2026-07-16', 1, 0, 1, ?, ?)`,
    ).bind(sessionHash, now, now),
    env.DB.prepare(
      `INSERT INTO jobs (
          id, client_request_id, token_hash, session_hash, day_key, status, phase,
          contract_id, spec_json, spec_hash, declared_bytes, declared_mime,
          declared_width, declared_height, input_key, output_key, reserved_units,
          resource_class, queue_epoch, upload_expires_at, created_at, updated_at
        ) VALUES (
          ?, ?, 'token-hash', ?, '2026-07-16', 'queued', 'queued',
          'image.optimize@1', '{}', ?, 3, 'image/png',
          1, 1, ?, ?, 1,
          'image-standard-v1', ?, ?, ?, ?
        )`,
    ).bind(
      jobId,
      crypto.randomUUID(),
      sessionHash,
      "a".repeat(64),
      `inputs/${crypto.randomUUID()}`,
      `outputs/${crypto.randomUUID()}`,
      crypto.randomUUID(),
      now + 60_000,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO job_outbox (
          job_id, payload, attempts, next_attempt_at, sent_at
        ) VALUES (?, ?, ?, ?, NULL)`,
    ).bind(jobId, payload, attempts, now),
  ]);
  return jobId;
}

afterEach(async () => {
  for (const jobId of seededJobs) {
    await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId).run();
  }
  seededJobs.clear();
});

describe("real D1 outbox compare-and-set", () => {
  it("marks a valid message only after Queue send resolves", async () => {
    const now = Date.now();
    const payload = message(crypto.randomUUID());
    const jobId = await seedOutbox(JSON.stringify(payload), now);
    const queue = { send: vi.fn(async () => undefined) };

    await expect(dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1)).resolves.toBe(1);
    expect(queue.send).toHaveBeenCalledWith(payload, { contentType: "json" });
    await expect(
      env.DB.prepare("SELECT sent_at FROM job_outbox WHERE job_id = ?")
        .bind(jobId)
        .first<{ sent_at: number | null }>(),
    ).resolves.toEqual({ sent_at: now });
  });

  it("does not send corrupt JSON and schedules a bounded retry", async () => {
    const now = Date.now();
    const jobId = await seedOutbox("{", now);
    const queue = { send: vi.fn(async () => undefined) };

    await expect(dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1)).resolves.toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare("SELECT attempts, next_attempt_at, sent_at FROM job_outbox WHERE job_id = ?")
        .bind(jobId)
        .first(),
    ).resolves.toEqual({
      attempts: 1,
      next_attempt_at: now + 10_000,
      sent_at: null,
    });
  });

  it("cannot mark a row whose exact payload was replaced while send was pending", async () => {
    const now = Date.now();
    const first = message(crypto.randomUUID());
    const jobId = await seedOutbox(JSON.stringify(first), now);
    const replacement = message(jobId, 2);
    const queue = {
      send: vi.fn(async () => {
        await env.DB.prepare(
          "UPDATE job_outbox SET payload = ?, next_attempt_at = ? WHERE job_id = ?",
        )
          .bind(JSON.stringify(replacement), now + 1, jobId)
          .run();
      }),
    };

    await expect(dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1)).resolves.toBe(0);
    await expect(
      env.DB.prepare("SELECT payload, sent_at FROM job_outbox WHERE job_id = ?")
        .bind(jobId)
        .first(),
    ).resolves.toEqual({ payload: JSON.stringify(replacement), sent_at: null });
  });

  it("does not evaluate malformed replacement JSON while applying the exact-payload CAS", async () => {
    const now = Date.now();
    const first = message(crypto.randomUUID());
    const jobId = await seedOutbox(JSON.stringify(first), now);
    const queue = {
      send: vi.fn(async () => {
        await env.DB.prepare(
          "UPDATE job_outbox SET payload = '{', next_attempt_at = ? WHERE job_id = ?",
        )
          .bind(now + 1, jobId)
          .run();
      }),
    };

    await expect(dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1)).resolves.toBe(0);
    await expect(
      env.DB.prepare("SELECT payload, sent_at FROM job_outbox WHERE job_id = ?")
        .bind(jobId)
        .first(),
    ).resolves.toEqual({ payload: "{", sent_at: null });
  });

  it("fails visibly for an unsafe selected row instead of silently hot-looping", async () => {
    const now = Date.now();
    const payload = message(crypto.randomUUID());
    await seedOutbox(JSON.stringify(payload), now, -1);
    const queue = { send: vi.fn(async () => undefined) };

    await expect(dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1)).rejects.toThrow(
      "Outbox row validation failed",
    );
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("lets two real-D1 dispatchers race while only one exact row CAS is marked sent", async () => {
    const now = Date.now();
    const payload = message(crypto.randomUUID());
    const jobId = await seedOutbox(JSON.stringify(payload), now);
    let arrivals = 0;
    let releaseSends: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSends = resolve;
    });
    const queue = {
      send: vi.fn(async () => {
        arrivals += 1;
        if (arrivals === 2) releaseSends?.();
        await sendGate;
      }),
    };

    const results = await Promise.all([
      dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1),
      dispatchPendingOutbox({ DB: env.DB, IMAGE_JOBS: queue }, now, 1),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send.mock.calls.at(0)).toEqual(queue.send.mock.calls.at(1));
    await expect(
      env.DB.prepare("SELECT sent_at FROM job_outbox WHERE job_id = ?").bind(jobId).first(),
    ).resolves.toEqual({ sent_at: now });
  });

  it("dispatches only the requested real-D1 row", async () => {
    const now = Date.now();
    const targetPayload = message(crypto.randomUUID());
    const otherPayload = message(crypto.randomUUID());
    const targetJobId = await seedOutbox(JSON.stringify(targetPayload), now);
    const otherJobId = await seedOutbox(JSON.stringify(otherPayload), now);
    const queue = {
      send: vi.fn(async (_message: unknown, _options: unknown) => undefined),
    };

    await expect(
      dispatchJobOutbox({ DB: env.DB, IMAGE_JOBS: queue }, targetJobId, now),
    ).resolves.toBe(true);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0]?.[0]).toEqual(targetPayload);
    await expect(
      env.DB.prepare("SELECT sent_at FROM job_outbox WHERE job_id = ?").bind(targetJobId).first(),
    ).resolves.toEqual({ sent_at: now });
    await expect(
      env.DB.prepare("SELECT sent_at FROM job_outbox WHERE job_id = ?").bind(otherJobId).first(),
    ).resolves.toEqual({ sent_at: null });
  });
});
