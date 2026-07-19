import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { recordParsedUsageLog } from "../src/usage-log-ledger";
import type { ParsedTraceEvents } from "../src/usage-log-parser";

const objectKey = "trace/2026-07-19/worker.ndjson.gz";
const now = Date.parse("2026-07-19T09:00:00.000Z");

function parsed(overrides: Partial<ParsedTraceEvents> = {}): ParsedTraceEvents {
  return {
    invocationCount: 3,
    decompressedBytes: 1_024,
    payloadSha256: "a".repeat(64),
    hours: [
      {
        hourKey: 100,
        invocationCount: 2,
        workerCpuMs: 7,
        handlerInvocationCount: 2,
        payloadSha256: "b".repeat(64),
      },
      {
        hourKey: 101,
        invocationCount: 1,
        workerCpuMs: 3,
        handlerInvocationCount: 0,
        payloadSha256: "c".repeat(64),
      },
    ],
    ...overrides,
  };
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM usage_log_objects").run();
  await env.DB.prepare(
    `UPDATE rollout_control
     SET circuit_open = 0, reason = NULL, opened_at = NULL
     WHERE id = 1`,
  ).run();
});

describe("usage log D1 ledger", () => {
  it("records all hours atomically and replays the same object exactly once", async () => {
    const input = { objectKey, etag: "etag-1", byteSize: 512, observedAt: now, parsed: parsed() };

    await expect(recordParsedUsageLog(env.DB, input)).resolves.toMatchObject({
      kind: "recorded",
      state: "parsed",
      stableObservationCount: 1,
    });
    await expect(
      recordParsedUsageLog(env.DB, { ...input, observedAt: now + 60_000 }),
    ).resolves.toMatchObject({
      kind: "replayed",
      state: "parsed",
      stableObservationCount: 2,
    });

    await expect(
      env.DB.prepare(
        `SELECT hour_key, invocation_count, worker_cpu_ms, subset_invocation_count
         FROM usage_log_object_hours WHERE object_key = ? ORDER BY hour_key`,
      )
        .bind(objectKey)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { hour_key: 100, invocation_count: 2, worker_cpu_ms: 7, subset_invocation_count: 2 },
        { hour_key: 101, invocation_count: 1, worker_cpu_ms: 3, subset_invocation_count: 0 },
      ],
    });
  });

  it("converges two concurrent claims to one recorded object", async () => {
    const input = { objectKey, etag: "etag-1", byteSize: 512, observedAt: now, parsed: parsed() };

    const results = await Promise.all([
      recordParsedUsageLog(env.DB, input),
      recordParsedUsageLog(env.DB, input),
    ]);

    expect(results.map(({ kind }) => kind).sort()).toEqual(["recorded", "replayed"]);
    for (const result of results) {
      expect(result.kind).not.toBe("conflict");
      if (result.kind === "conflict") throw new Error("Concurrent claims unexpectedly conflicted.");
      expect(result.stableObservationCount).toBe(1);
    }
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM usage_log_object_hours").first(),
    ).resolves.toEqual({ count: 2 });
  });

  it.each([
    { etag: "etag-2" },
    { byteSize: 513 },
    { parsed: parsed({ payloadSha256: "d".repeat(64) }) },
  ])("opens the circuit when immutable object identity changes", async (change) => {
    const input = { objectKey, etag: "etag-1", byteSize: 512, observedAt: now, parsed: parsed() };
    await recordParsedUsageLog(env.DB, input);

    await expect(
      recordParsedUsageLog(env.DB, { ...input, ...change, observedAt: now + 1 }),
    ).resolves.toMatchObject({ kind: "conflict", circuitOpen: true });
    await expect(
      env.DB.prepare("SELECT circuit_open, reason FROM rollout_control WHERE id = 1").first(),
    ).resolves.toEqual({ circuit_open: 1, reason: "USAGE_LOG_OBJECT_CHANGED" });
  });

  it("opens the circuit when an hourly aggregate changes under the same object digest", async () => {
    const initial = parsed();
    const input = { objectKey, etag: "etag-1", byteSize: 512, observedAt: now, parsed: initial };
    await recordParsedUsageLog(env.DB, input);

    const changedHours = initial.hours.map((hour, index) =>
      index === 0 ? { ...hour, workerCpuMs: hour.workerCpuMs + 1 } : hour,
    );
    await expect(
      recordParsedUsageLog(env.DB, {
        ...input,
        observedAt: now + 1,
        parsed: { ...initial, hours: changedHours },
      }),
    ).resolves.toEqual({ kind: "conflict", circuitOpen: true });
  });

  it("rejects unordered hour input before mutating D1", async () => {
    const value = parsed();
    await expect(
      recordParsedUsageLog(env.DB, {
        objectKey,
        etag: "etag-1",
        byteSize: 512,
        observedAt: now,
        parsed: { ...value, hours: [...value.hours].reverse() },
      }),
    ).rejects.toThrow(/strictly ordered/i);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM usage_log_objects").first(),
    ).resolves.toEqual({ count: 0 });
  });
});
