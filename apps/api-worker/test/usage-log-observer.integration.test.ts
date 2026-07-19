import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordParsedUsageLog } from "../src/usage-log-ledger";
import { observeUsageLogHour } from "../src/usage-log-observer";
import {
  createCloudflareSha256Digest,
  type ParsedTraceEvents,
  type StreamingDigest,
} from "../src/usage-log-parser";

const accountingEpoch = "a".repeat(32);
const hourKey = 100;
const observedAt = Date.parse("2026-07-19T10:00:00.000Z");

function parsed(hourPayload = "b".repeat(64)): ParsedTraceEvents {
  return {
    invocationCount: 1,
    decompressedBytes: 256,
    payloadSha256: crypto.randomUUID().replaceAll("-", "").repeat(2),
    hours: [
      {
        hourKey,
        invocationCount: 1,
        workerCpuMs: 7,
        handlerInvocationCount: 1,
        payloadSha256: hourPayload,
      },
    ],
  };
}

async function record(objectKey: string, hourPayload?: string) {
  return recordParsedUsageLog(env.DB, {
    objectKey,
    etag: crypto.randomUUID(),
    byteSize: 512,
    observedAt,
    parsed: parsed(hourPayload),
  });
}

beforeEach(async () => {
  await env.DB.prepare(
    `UPDATE rollout_control
     SET cost_accounting_epoch = ?, circuit_open = 0, reason = NULL, opened_at = NULL
     WHERE id = 1`,
  )
    .bind(accountingEpoch)
    .run();
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM usage_log_hour_observations").run();
  await env.DB.prepare("DELETE FROM usage_log_objects").run();
});

describe("usage-log closed-hour observation", () => {
  it("becomes stable only after the same object set is seen ten minutes apart", async () => {
    await record("logs/one.ndjson.gz");

    await expect(
      observeUsageLogHour(env.DB, {
        hourKey,
        observedAt,
        createDigest: createCloudflareSha256Digest,
      }),
    ).resolves.toEqual({
      kind: "observed",
      matchingObservationCount: 1,
      objectCount: 1,
      objectBytes: 512,
      circuitOpen: false,
    });
    await expect(
      observeUsageLogHour(env.DB, {
        hourKey,
        observedAt: observedAt + 5 * 60_000,
        createDigest: createCloudflareSha256Digest,
      }),
    ).resolves.toMatchObject({ kind: "observed", matchingObservationCount: 1 });
    await expect(
      observeUsageLogHour(env.DB, {
        hourKey,
        observedAt: observedAt + 10 * 60_000,
        createDigest: createCloudflareSha256Digest,
      }),
    ).resolves.toMatchObject({ kind: "stable", matchingObservationCount: 2 });
  });

  it("opens the circuit when a later pass sees a changed object set", async () => {
    await record("logs/one.ndjson.gz");
    await observeUsageLogHour(env.DB, {
      hourKey,
      observedAt,
      createDigest: createCloudflareSha256Digest,
    });
    await record("logs/two.ndjson.gz", "c".repeat(64));

    await expect(
      observeUsageLogHour(env.DB, {
        hourKey,
        observedAt: observedAt + 10 * 60_000,
        createDigest: createCloudflareSha256Digest,
      }),
    ).resolves.toMatchObject({ kind: "conflict", circuitOpen: true });
    await expect(
      env.DB.prepare("SELECT reason FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ reason: "USAGE_LOG_OBJECT_SET_CHANGED" });
  });

  it("opens the circuit when two objects repeat the same hourly payload", async () => {
    const duplicatePayload = "d".repeat(64);
    await record("logs/one.ndjson.gz", duplicatePayload);
    await record("logs/two.ndjson.gz", duplicatePayload);

    await expect(
      observeUsageLogHour(env.DB, {
        hourKey,
        observedAt,
        createDigest: createCloudflareSha256Digest,
      }),
    ).resolves.toMatchObject({ kind: "conflict", circuitOpen: true });
    await expect(
      env.DB.prepare("SELECT reason FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ reason: "USAGE_LOG_DUPLICATE_PAYLOAD" });
  });

  it("fails closed when an object arrives between set hashing and the final D1 batch", async () => {
    await record("logs/one.ndjson.gz");
    let inserted = false;
    const racingDigest = (): StreamingDigest => {
      const digest = createCloudflareSha256Digest();
      return {
        update: digest.update,
        finish: async () => {
          const hash = await digest.finish();
          if (!inserted) {
            inserted = true;
            await record("logs/two.ndjson.gz", "e".repeat(64));
          }
          return hash;
        },
      };
    };

    await expect(
      observeUsageLogHour(env.DB, { hourKey, observedAt, createDigest: racingDigest }),
    ).resolves.toMatchObject({ kind: "conflict", circuitOpen: true });
    await expect(
      env.DB.prepare("SELECT reason FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ reason: "USAGE_LOG_OBJECT_SET_CHANGED" });
  });

  it("stabilizes an explicit zero-object hour", async () => {
    await observeUsageLogHour(env.DB, {
      hourKey,
      observedAt,
      createDigest: createCloudflareSha256Digest,
    });

    await expect(
      observeUsageLogHour(env.DB, {
        hourKey,
        observedAt: observedAt + 10 * 60_000,
        createDigest: createCloudflareSha256Digest,
      }),
    ).resolves.toMatchObject({
      kind: "stable",
      matchingObservationCount: 2,
      objectCount: 0,
      objectBytes: 0,
    });
  });
});
