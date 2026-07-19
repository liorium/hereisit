import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareProcessingResourceApi,
  logpushDestinationMatches,
} from "../scripts/cloudflare-processing-resource-api.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const config = {
  environment: "staging" as const,
  accountId,
  location: "apac",
  workerScriptName: "hereisit-processing-staging",
  databaseName: "hereisit-processing-staging",
  bucketName: "hereisit-processing-staging",
  usageLogBucketName: "hereisit-processing-usage-staging",
  queueName: "hereisit-image-jobs-staging",
  dlqName: "hereisit-image-jobs-dlq-staging",
};

function response(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    headers: { "content-type": "application/json" },
  });
}

describe("Cloudflare processing resource API", () => {
  it("accepts only the exact private Logpush destination and credential scope", () => {
    const destination =
      `r2://hereisit-processing-usage-staging/workers-trace-events/staging/{DATE}` +
      `?account-id=${accountId}&access-key-id=access-key&secret-access-key=secret-key`;
    const expected = {
      accountId,
      bucketName: config.usageLogBucketName,
      environment: config.environment,
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    };

    expect(logpushDestinationMatches(destination, expected)).toBe(true);
    expect(logpushDestinationMatches(destination.replace("secret-key", "wrong"), expected)).toBe(
      false,
    );
    expect(logpushDestinationMatches(`${destination}&extra=1`, expected)).toBe(false);
    expect(
      logpushDestinationMatches(
        destination.replace("staging/{DATE}", "production/{DATE}"),
        expected,
      ),
    ).toBe(false);
  });

  it("reads an empty account inventory without exposing credentials", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const authorization = new Headers(init?.headers).get("authorization");
      if (path.endsWith("/logpush/jobs")) {
        expect(authorization).toBe("Bearer logs-token");
        return response([]);
      }
      expect(authorization).toBe("Bearer resource-token");
      if (path.endsWith("/r2/buckets")) return response({ buckets: [] });
      return response([]);
    });
    const api = createCloudflareProcessingResourceApi({
      config,
      fetcher,
      apiToken: "resource-token",
      logpushApiToken: "logs-token",
      logpushR2AccessKeyId: "access-key",
      logpushR2SecretAccessKey: "secret-key",
    });

    await expect(api.readInventory()).resolves.toEqual({ d1: [], r2: [], queues: [], logpush: [] });
    expect(JSON.stringify(await api.readInventory())).not.toMatch(/token|access-key|secret-key/);
  });

  it("creates private resources with bounded, fail-closed settings", async () => {
    const calls: Array<{
      url: string;
      method: string;
      body: unknown;
      authorization: string | null;
    }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      if (call.url.endsWith("/queues") && call.method === "POST") {
        return response({ queue_id: "1".repeat(32) });
      }
      return response({});
    });
    const api = createCloudflareProcessingResourceApi({
      config,
      fetcher,
      apiToken: "resource-token",
      logpushApiToken: "logs-token",
      logpushR2AccessKeyId: "access-key",
      logpushR2SecretAccessKey: "secret-key",
    });

    await api.applyAction({ type: "create-d1", name: config.databaseName, location: "apac" });
    await api.applyAction({ type: "create-r2", name: config.bucketName, lifecycleDays: 1 });
    await api.applyAction({ type: "create-queue", name: config.queueName, deliveryPaused: true });
    await api.applyAction({
      type: "create-logpush",
      dataset: "workers_trace_events",
      workerScriptName: config.workerScriptName,
    });

    expect(calls.map(({ method }) => method)).toEqual([
      "POST",
      "POST",
      "PUT",
      "POST",
      "PATCH",
      "POST",
    ]);
    expect(calls[0]?.body).toEqual({ name: config.databaseName, primary_location_hint: "apac" });
    expect(calls[1]?.body).toEqual({
      name: config.bucketName,
      location: "apac",
      storage_class: "Standard",
    });
    expect(calls[2]?.body).toMatchObject({
      rules: [
        {
          id: "hereisit-expire-1d",
          conditions: { prefix: "" },
          enabled: true,
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
        },
      ],
    });
    expect(calls[4]?.body).toEqual({ settings: { delivery_paused: true } });
    expect(calls[5]?.authorization).toBe("Bearer logs-token");
    expect(calls[5]?.body).toMatchObject({
      dataset: "workers_trace_events",
      enabled: true,
      filter: JSON.stringify({
        where: { key: "ScriptName", operator: "eq", value: config.workerScriptName },
      }),
      output_options: { output_type: "ndjson", sample_rate: 1 },
    });
    const logpushBody = calls[5]?.body as { destination_conf?: string } | undefined;
    expect(logpushBody?.destination_conf).toContain(
      "r2://hereisit-processing-usage-staging/workers-trace-events/staging/{DATE}",
    );
  });
});
