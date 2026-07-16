import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
] as const;

describe("Task 4 Worker bindings", () => {
  it("applies migrations and exposes non-null D1 primary-key identities", async () => {
    const migration = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
    ).first<{ name: string }>();
    expect(migration?.name).toBe("0001_processing_jobs.sql");

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
});
