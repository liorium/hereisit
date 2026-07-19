import { describe, expect, it, vi } from "vitest";
import { evaluateCircuitBreaker } from "./circuit-breaker";

function databaseReturning(row: unknown) {
  const statement = {
    bind: vi.fn(function bind() {
      return statement;
    }),
  };
  const session = {
    prepare: vi.fn(() => statement),
    batch: vi.fn(async () => [
      { success: true, results: [], meta: { changes: 1 } },
      { success: true, results: row === undefined ? [] : [row], meta: { changes: 0 } },
    ]),
  };
  const database = {
    withSession: vi.fn(() => session),
  };
  return {
    database: database as unknown as D1Database,
    session,
    withSession: database.withSession,
  };
}

describe("automatic circuit breaker", () => {
  it("reads and updates the singleton through a first-primary D1 batch", async () => {
    const now = Date.parse("2026-07-19T08:00:00.000Z");
    const { database, session, withSession } = databaseReturning({
      circuit_open: 0,
      reason: null,
      opened_at: null,
      last_evaluated_at: now,
    });

    await expect(
      evaluateCircuitBreaker(database, { now, maximumQueuedAgeSeconds: 600 }),
    ).resolves.toEqual({
      open: false,
      reason: null,
      openedAt: null,
      evaluatedAt: now,
    });
    expect(withSession).toHaveBeenCalledWith("first-primary");
    expect(session.batch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { now: -1, maximumQueuedAgeSeconds: 600 },
    { now: 1.5, maximumQueuedAgeSeconds: 600 },
    { now: 0, maximumQueuedAgeSeconds: -1 },
    { now: 0, maximumQueuedAgeSeconds: Number.MAX_SAFE_INTEGER },
  ])("rejects unsafe evaluation bounds before touching D1", async (input) => {
    const { database, withSession } = databaseReturning(undefined);

    await expect(evaluateCircuitBreaker(database, input)).rejects.toThrow();
    expect(withSession).not.toHaveBeenCalled();
  });

  it("rejects an absent or malformed singleton snapshot", async () => {
    const now = Date.parse("2026-07-19T08:00:00.000Z");
    const missing = databaseReturning(undefined).database;
    const malformed = databaseReturning({
      circuit_open: 2,
      reason: null,
      opened_at: null,
      last_evaluated_at: now,
    }).database;

    await expect(
      evaluateCircuitBreaker(missing, { now, maximumQueuedAgeSeconds: 600 }),
    ).rejects.toThrow(/unavailable or malformed/i);
    await expect(
      evaluateCircuitBreaker(malformed, { now, maximumQueuedAgeSeconds: 600 }),
    ).rejects.toThrow(/unavailable or malformed/i);
  });
});
