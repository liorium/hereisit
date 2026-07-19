import { describe, expect, it, vi } from "vitest";
import { dispatchJobOutbox, dispatchPendingOutbox, outboxRetryDelayMilliseconds } from "./outbox";

const JOB_ID = "018f47a2-65d4-7f31-a377-5afbb8f53f27";
const OTHER_JOB_ID = "018f47a2-65d4-7f31-a377-5afbb8f53f28";
const QUEUE_EPOCH = "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe";

function message(overrides: Record<string, unknown> = {}) {
  return {
    jobId: JOB_ID,
    contractId: "image.optimize@1",
    specHash: "a".repeat(64),
    inputKey: "inputs/550e8400-e29b-41d4-a716-446655440000",
    inputEtag: "raw-etag",
    outputKey: "outputs/6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    resourceClass: "image-standard-v1",
    attempt: 1,
    queueEpoch: QUEUE_EPOCH,
    queueGeneration: 1,
    ...overrides,
  };
}

interface TestRow {
  job_id: string;
  payload: string;
  attempts: number;
  next_attempt_at: number;
  sent_at: number | null;
}

class TestStatement {
  readonly #db: TestDb;
  readonly #sql: string;
  readonly #values: readonly unknown[];

  constructor(db: TestDb, sql: string, values: readonly unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#values = values;
  }

  bind(...values: unknown[]) {
    return new TestStatement(this.#db, this.#sql, values);
  }

  async all<T>() {
    if (!this.#sql.includes("FROM job_outbox")) throw new Error("unexpected SELECT");
    if (this.#sql.includes("job_id = ?")) {
      const [jobId, now] = this.#values as [string, number];
      return {
        success: true,
        results: this.#db.rows
          .filter(
            (row) => row.job_id === jobId && row.sent_at === null && row.next_attempt_at <= now,
          )
          .slice(0, 1) as T[],
      };
    }
    const [now, limit] = this.#values as [number, number];
    return {
      success: true,
      results: this.#db.rows
        .filter((row) => row.sent_at === null && row.next_attempt_at <= now)
        .sort(
          (left, right) =>
            left.next_attempt_at - right.next_attempt_at || left.job_id.localeCompare(right.job_id),
        )
        .slice(0, limit) as T[],
    };
  }

  async run() {
    const isSuccess = this.#sql.includes("SET sent_at");
    const isFailure = this.#sql.includes("SET attempts");
    if (!isSuccess && !isFailure) throw new Error("unexpected UPDATE");

    const values = this.#values;
    const identityOffset = isSuccess ? 1 : 2;
    const jobId = values[identityOffset] as string;
    const selectedPayload = values[identityOffset + 1] as string;
    const selectedAttempts = values[identityOffset + 2] as number;
    const selectedNextAttemptAt = values[identityOffset + 3] as number;

    const row = this.#db.rows.find(
      (candidate) =>
        candidate.job_id === jobId &&
        candidate.payload === selectedPayload &&
        candidate.attempts === selectedAttempts &&
        candidate.next_attempt_at === selectedNextAttemptAt &&
        candidate.sent_at === null,
    );
    if (row === undefined) {
      return { success: true, meta: { changes: 0 } };
    }
    if (isSuccess) {
      row.sent_at = values[0] as number;
    } else {
      row.attempts = values[0] as number;
      row.next_attempt_at = values[1] as number;
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class TestDb {
  rows: TestRow[];

  constructor(rows: TestRow[]) {
    this.rows = rows;
  }

  prepare(sql: string) {
    return new TestStatement(this, sql);
  }
}

function dueRow(overrides: Partial<TestRow> = {}): TestRow {
  return {
    job_id: JOB_ID,
    payload: JSON.stringify(message()),
    attempts: 0,
    next_attempt_at: 1_000,
    sent_at: null,
    ...overrides,
  };
}

describe("outbox retry policy", () => {
  it.each([
    [0, 10_000],
    [1, 30_000],
    [2, 120_000],
    [3, 120_000],
    [99, 120_000],
  ])("delays failure %s by %sms", (attempts, expected) => {
    expect(outboxRetryDelayMilliseconds(attempts)).toBe(expected);
  });
});

describe("transactional outbox dispatcher", () => {
  it("validates and sends the selected object as JSON before marking it sent", async () => {
    const row = dueRow();
    const queue = { send: vi.fn(async () => undefined) };
    const db = new TestDb([row]);

    await expect(dispatchPendingOutbox({ DB: db, IMAGE_JOBS: queue }, 5_000, 10)).resolves.toBe(1);

    expect(queue.send).toHaveBeenCalledWith(message(), { contentType: "json" });
    expect(row.sent_at).toBe(5_000);
  });

  it("uses 10, 30, then capped 120 second failure delays", async () => {
    for (const [attempts, delay] of [
      [0, 10_000],
      [1, 30_000],
      [2, 120_000],
      [8, 120_000],
    ] as const) {
      const row = dueRow({ attempts });
      const queue = { send: vi.fn(async () => Promise.reject(new Error("queue unavailable"))) };

      await expect(
        dispatchPendingOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, 5_000, 1),
      ).resolves.toBe(0);
      expect(row.attempts).toBe(attempts + 1);
      expect(row.next_attempt_at).toBe(5_000 + delay);
      expect(row.sent_at).toBeNull();
    }
  });

  it("does not send corrupt payloads and moves them out of the hot loop", async () => {
    const row = dueRow({ payload: '{"jobId":"not-a-message"}' });
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchPendingOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, 5_000, 1),
    ).resolves.toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe(15_000);
  });

  it("does not mark a replacement row after a stale send resolves", async () => {
    const row = dueRow();
    const replacement = JSON.stringify(message({ queueGeneration: 2 }));
    const queue = {
      send: vi.fn(async () => {
        row.payload = replacement;
        row.attempts = 0;
        row.next_attempt_at = 5_001;
      }),
    };

    await expect(
      dispatchPendingOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, 5_000, 1),
    ).resolves.toBe(0);
    expect(row.sent_at).toBeNull();
    expect(row.payload).toBe(replacement);
  });

  it("does not let malformed replacement JSON break the exact-payload CAS", async () => {
    const row = dueRow();
    const queue = {
      send: vi.fn(async () => {
        row.payload = "{";
        row.next_attempt_at = 5_001;
      }),
    };

    await expect(
      dispatchPendingOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, 5_000, 1),
    ).resolves.toBe(0);
    expect(row.sent_at).toBeNull();
    expect(row.payload).toBe("{");
  });

  it("reschedules a non-UUID row identity without sending it", async () => {
    const row = dueRow({ job_id: "not-a-uuid" });
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchPendingOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, 5_000, 1),
    ).resolves.toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe(15_000);
  });

  it("fails visibly for a row whose CAS identity cannot be used safely", async () => {
    const row = dueRow({ attempts: -1 });
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchPendingOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, 5_000, 1),
    ).rejects.toThrow("Outbox row validation failed");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("rejects a dispatch time whose retry deadline would overflow", async () => {
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchPendingOutbox(
        { DB: new TestDb([dueRow()]), IMAGE_JOBS: queue },
        Number.MAX_SAFE_INTEGER,
        1,
      ),
    ).rejects.toThrow("non-negative safe integer");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("preserves duplicate delivery when send succeeds but marking fails", async () => {
    const row = dueRow();
    const queue = {
      send: vi.fn(async (_message: unknown, _options: unknown) => undefined),
    };
    const db = new TestDb([row]);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("SET sent_at")) return statement;
      return {
        bind: (..._values: unknown[]) => ({
          run: async () => ({ success: true, meta: { changes: 0 } }),
        }),
      } as TestStatement;
    };

    await expect(dispatchPendingOutbox({ DB: db, IMAGE_JOBS: queue }, 5_000, 1)).resolves.toBe(0);
    await expect(dispatchPendingOutbox({ DB: db, IMAGE_JOBS: queue }, 5_001, 1)).resolves.toBe(0);

    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send.mock.calls.at(0)).toEqual(queue.send.mock.calls.at(1));
    expect(row.sent_at).toBeNull();
  });

  it("bounds and deterministically orders selected rows", async () => {
    const rows = [
      dueRow({ job_id: "018f47a2-65d4-7f31-a377-5afbb8f53f29", next_attempt_at: 900 }),
      dueRow({ job_id: "018f47a2-65d4-7f31-a377-5afbb8f53f28", next_attempt_at: 900 }),
      dueRow({ job_id: "018f47a2-65d4-7f31-a377-5afbb8f53f30", next_attempt_at: 800 }),
    ];
    rows.forEach((row) => {
      row.payload = JSON.stringify(message({ jobId: row.job_id }));
    });
    const queue = {
      send: vi.fn(async (_message: unknown, _options: unknown) => undefined),
    };

    await expect(
      dispatchPendingOutbox({ DB: new TestDb(rows), IMAGE_JOBS: queue }, 5_000, 2),
    ).resolves.toBe(2);
    expect(queue.send.mock.calls.map(([body]) => body)).toEqual([
      expect.objectContaining({ jobId: "018f47a2-65d4-7f31-a377-5afbb8f53f30" }),
      expect.objectContaining({ jobId: "018f47a2-65d4-7f31-a377-5afbb8f53f28" }),
    ]);
  });
});

describe("exact-job outbox dispatcher", () => {
  it("sends only the requested due job even when another job is due first", async () => {
    const target = dueRow({ next_attempt_at: 1_000 });
    const other = dueRow({
      job_id: OTHER_JOB_ID,
      payload: JSON.stringify(message({ jobId: OTHER_JOB_ID })),
      next_attempt_at: 500,
    });
    const queue = {
      send: vi.fn(async (_message: ReturnType<typeof message>, _options: unknown) => undefined),
    };

    await expect(
      dispatchJobOutbox({ DB: new TestDb([other, target]), IMAGE_JOBS: queue }, JOB_ID, 5_000),
    ).resolves.toBe(true);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0]?.[0].jobId).toBe(JOB_ID);
    expect(target.sent_at).toBe(5_000);
    expect(other.sent_at).toBeNull();
  });

  it("returns false without sending when the exact row is not due even though another is due", async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const rows = [
      dueRow({ job_id: OTHER_JOB_ID, payload: JSON.stringify(message({ jobId: OTHER_JOB_ID })) }),
      dueRow({ next_attempt_at: 5_001 }),
    ];

    await expect(
      dispatchJobOutbox({ DB: new TestDb(rows), IMAGE_JOBS: queue }, JOB_ID, 5_000),
    ).resolves.toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", []],
    ["already sent", [dueRow({ sent_at: 4_000 })]],
  ])("returns false without sending when the exact row is %s", async (_case, rows) => {
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchJobOutbox({ DB: new TestDb(rows), IMAGE_JOBS: queue }, JOB_ID, 5_000),
    ).resolves.toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-uuid",
    "018F47A2-65D4-7F31-A377-5AFBB8F53F27",
    "018f47a2-65d4-0f31-a377-5afbb8f53f27",
    "018f47a2-65d4-7f31-7377-5afbb8f53f27",
    "018f47a2-65d4-7f31-a377-5afbb8f53f27\u0000suffix",
  ])("rejects noncanonical exact job ID %j before D1 access", async (jobId) => {
    const prepare = vi.fn();
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchJobOutbox({ DB: { prepare }, IMAGE_JOBS: queue }, jobId, 5_000),
    ).rejects.toThrow("canonical lowercase UUID");
    expect(prepare).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("keeps an exact Queue failure retryable and returns false", async () => {
    const row = dueRow();
    const queue = {
      send: vi.fn(async () => Promise.reject(new Error("queue unavailable"))),
    };

    await expect(
      dispatchJobOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, JOB_ID, 5_000),
    ).resolves.toBe(false);
    expect(row).toMatchObject({ attempts: 1, next_attempt_at: 15_000, sent_at: null });
  });

  it("reschedules a corrupt exact payload without sending and returns false", async () => {
    const row = dueRow({ payload: "{" });
    const queue = { send: vi.fn(async () => undefined) };

    await expect(
      dispatchJobOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, JOB_ID, 5_000),
    ).resolves.toBe(false);
    expect(queue.send).not.toHaveBeenCalled();
    expect(row).toMatchObject({ attempts: 1, next_attempt_at: 15_000, sent_at: null });
  });

  it("returns false when a stale replacement wins after the exact send", async () => {
    const row = dueRow();
    const replacement = JSON.stringify(message({ queueGeneration: 2 }));
    const queue = {
      send: vi.fn(async () => {
        row.payload = replacement;
        row.next_attempt_at = 5_001;
      }),
    };

    await expect(
      dispatchJobOutbox({ DB: new TestDb([row]), IMAGE_JOBS: queue }, JOB_ID, 5_000),
    ).resolves.toBe(false);
    expect(row).toMatchObject({ payload: replacement, sent_at: null });
  });
});
