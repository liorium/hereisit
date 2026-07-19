import { describe, expect, it } from "vitest";
import { applyWorkerVersionAttestationBatch } from "../scripts/apply-worker-version-attestations.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const databaseId = "11111111-2222-3333-4444-555555555555";

function queryResult({ results = [], changed = false, primary = true } = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: [
      {
        success: true,
        meta: {
          changed_db: changed,
          changes: changed ? 1 : 0,
          duration: 0.2,
          last_row_id: 0,
          rows_read: results.length,
          rows_written: changed ? 1 : 0,
          served_by_colo: "ICN",
          served_by_primary: primary,
          served_by_region: "APAC",
          size_after: 4096,
          timings: { sql_duration_ms: 0.2 },
        },
        results,
      },
    ],
  };
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function validBatch() {
  return {
    version: 1,
    statements: [{ sql: "INSERT INTO worker_version_attestations VALUES (?)", params: ["v1"] }],
    verification: [
      {
        sql: "SELECT version_id AS versionId FROM worker_version_attestations WHERE version_id = ?",
        params: ["v1"],
        expected: [{ versionId: "v1" }],
      },
    ],
  };
}

describe("remote Worker version attestation application", () => {
  it("posts one parameterized primary batch then verifies exact persisted rows", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const replies = [
      response(queryResult({ changed: true })),
      response(queryResult({ results: [{ versionId: "v1" }] })),
    ];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return replies.shift() as Response;
    };

    await expect(
      applyWorkerVersionAttestationBatch({
        accountId,
        databaseId,
        apiToken: "deployment-token-value",
        batch: validBatch(),
        fetchImpl,
      }),
    ).resolves.toEqual({ applied: true, statements: 1, verificationQueries: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    );
    expect(calls[0].init).toMatchObject({
      method: "POST",
      signal: expect.any(AbortSignal),
      headers: {
        authorization: "Bearer deployment-token-value",
        "content-type": "application/json",
      },
    });
    expect(calls[0].body).toEqual({ batch: validBatch().statements });
    expect(JSON.stringify(calls[0].body)).not.toContain("deployment-token-value");
    expect(calls[1].body).toEqual({
      sql: validBatch().verification[0].sql,
      params: validBatch().verification[0].params,
    });
  });

  it("rejects a write response not served by the primary", async () => {
    await expect(
      applyWorkerVersionAttestationBatch({
        accountId,
        databaseId,
        apiToken: "deployment-token-value",
        batch: validBatch(),
        fetchImpl: async () => response(queryResult({ changed: true, primary: false })),
      }),
    ).rejects.toThrow(/primary/i);
  });

  it("rejects persisted rows that differ from the attested expectation", async () => {
    const replies = [
      response(queryResult({ changed: true })),
      response(queryResult({ results: [{ versionId: "other" }] })),
    ];
    await expect(
      applyWorkerVersionAttestationBatch({
        accountId,
        databaseId,
        apiToken: "deployment-token-value",
        batch: validBatch(),
        fetchImpl: async () => replies.shift() as Response,
      }),
    ).rejects.toThrow(/verification|persisted/i);
  });
});
