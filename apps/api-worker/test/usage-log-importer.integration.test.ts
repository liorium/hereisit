import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CostAccountingRuntimeConfig,
  createCostAccountingRuntime,
} from "../src/cost-accounting-runtime";
import { importUsageLogPage } from "../src/usage-log-importer";
import { createCloudflareSha256Digest, parseGzipTraceEvents } from "../src/usage-log-parser";

const objectKey = "logs/date=2026-07-19/hour=09/trace.ndjson.gz";
const versionId = "123e4567-e89b-42d3-a456-426614174000";
const observedAt = Date.parse("2026-07-19T10:00:00.000Z");

async function gzip(text: string): Promise<ArrayBuffer> {
  const compressor = new CompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(input.pipeThrough(compressor)).arrayBuffer();
}

function traceRecord() {
  return {
    CPUTimeMs: 7,
    Entrypoint: "",
    EventTimestampMs: observedAt - 3_600_000,
    EventType: "fetch",
    Outcome: "ok",
    ScriptName: "hereisit-processing-staging",
    ScriptVersion: { ID: versionId, Message: null, Tag: null },
  };
}

afterEach(async () => {
  await env.USAGE_LOGS.delete(objectKey);
  await env.DB.prepare("DELETE FROM usage_log_objects").run();
  await env.DB.prepare("DELETE FROM maintenance_cursors WHERE task = 'usage-log-import'").run();
  await env.DB.prepare("DELETE FROM operational_counter_hourly").run();
  await env.DB.prepare(
    `UPDATE rollout_control
     SET circuit_open = 0, reason = NULL, opened_at = NULL
     WHERE id = 1`,
  ).run();
});

describe("usage-log R2 importer", () => {
  it("skips only identical previously parsed objects strictly before the target hour", async () => {
    await env.USAGE_LOGS.put(objectKey, await gzip(`${JSON.stringify(traceRecord())}\n`));
    const get = vi.fn(env.USAGE_LOGS.get.bind(env.USAGE_LOGS));
    const dependencies = {
      bucket: { list: env.USAGE_LOGS.list.bind(env.USAGE_LOGS), get },
      database: env.DB,
      parserOptions: {
        scriptName: "hereisit-processing-staging",
        allowedEntrypoints: new Set([""]),
        createDigest: createCloudflareSha256Digest,
      },
    };
    await importUsageLogPage(dependencies, { observedAt, prefix: "logs/" });
    get.mockClear();
    const minimumHourKey = Math.floor(observedAt / 3_600_000);
    const result = await importUsageLogPage(dependencies, {
      observedAt,
      prefix: "logs/",
      minimumHourKey,
    });
    expect(result).toMatchObject({ kind: "complete", importedObjects: 0, replayedObjects: 0 });
    expect(result.metadataRowsRead).toBeGreaterThan(0);
    expect(get).not.toHaveBeenCalled();
    await env.DB.prepare(
      "UPDATE rollout_control SET cost_accounting_started_at = ?, last_sealed_hour_key = NULL",
    )
      .bind(observedAt)
      .run();
    await env.DB.prepare("DELETE FROM maintenance_cursors WHERE task = 'usage-log-import'").run();
    let pages = 7;
    const list = vi.fn(async (_options: R2ListOptions) => {
      const page = await env.USAGE_LOGS.list({ prefix: "logs/" });
      return list.mock.calls.length < pages
        ? { ...page, truncated: true as const, cursor: `page-${list.mock.calls.length}` }
        : page;
    });
    const runtime = createCostAccountingRuntime(
      {
        ...env,
        ANALYTICS_READ_TOKEN: "test",
        LOGPUSH_STATUS_TOKEN: "test",
        USAGE_LOGS: { list, get } as unknown as R2Bucket,
        WORKER_VERSION: {
          id: versionId,
          tag: "test",
          timestamp: new Date(observedAt).toISOString(),
        },
      },
      {
        accountId: "a".repeat(32),
        logpushJobId: 1,
        containerApplicationId: versionId,
        workerScriptName: "hereisit-processing-staging",
        usageLogPrefix: "logs/",
        analyticsDatasetName: "test",
        environment: "staging",
        liveCostModel: {} as CostAccountingRuntimeConfig["liveCostModel"],
        liveCostModelSha256: "a".repeat(64),
        providerUsageSchemaSha256: "b".repeat(64),
        releaseReportSha256: "c".repeat(64),
      },
    );
    await expect(runtime.importUsageLogs(observedAt)).resolves.toBe("complete");
    expect(list).toHaveBeenCalledTimes(7);
    expect(get).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(
        "SELECT r2_class_a_operations, r2_class_b_operations FROM operational_counter_hourly",
      ).first(),
    ).resolves.toEqual({ r2_class_a_operations: 7, r2_class_b_operations: 0 });
    expect(
      await env.DB.prepare("SELECT d1_rows_read FROM operational_counter_hourly").first<number>(
        "d1_rows_read",
      ),
    ).toBeGreaterThanOrEqual(12);
    pages = 65;
    list.mockClear();
    await expect(runtime.importUsageLogs(observedAt + 300_000)).resolves.toBe("partial");
    expect(list).toHaveBeenCalledTimes(64);
    expect(
      await env.DB.prepare(
        "SELECT cursor FROM maintenance_cursors WHERE task = 'usage-log-import'",
      ).first("cursor"),
    ).toBe("page-64");
    expect(get).not.toHaveBeenCalled();
    await expect(
      importUsageLogPage(dependencies, {
        observedAt,
        prefix: "logs/",
        minimumHourKey: minimumHourKey - 1,
      }),
    ).resolves.toMatchObject({ replayedObjects: 1 });
    expect(get).toHaveBeenCalledTimes(1);
    await env.USAGE_LOGS.put(
      objectKey,
      await gzip(`${JSON.stringify({ ...traceRecord(), CPUTimeMs: 9 })}\n`),
    );
    await expect(
      importUsageLogPage(dependencies, { observedAt, prefix: "logs/", minimumHourKey }),
    ).resolves.toMatchObject({ kind: "failed-closed" });
  });

  it("streams a private gzip object into D1 and replays it without duplicate hours", async () => {
    await env.USAGE_LOGS.put(objectKey, await gzip(`${JSON.stringify(traceRecord())}\n`));
    const parserOptions = {
      scriptName: "hereisit-processing-staging",
      allowedEntrypoints: new Set([""]),
      allowedVersionIds: new Set([versionId]),
      createDigest: createCloudflareSha256Digest,
    };
    const listed = await env.USAGE_LOGS.list({ prefix: "logs/", limit: 128 });
    expect(listed.objects).toHaveLength(1);
    const metadata = listed.objects[0];
    if (metadata === undefined) throw new Error("Expected one usage-log object.");
    const fetched = await env.USAGE_LOGS.get(metadata.key, {
      onlyIf: { etagMatches: metadata.etag },
    });
    expect(fetched).not.toBeNull();
    expect(fetched !== null && "body" in fetched).toBe(true);
    if (fetched === null || !("body" in fetched)) throw new Error("Expected an R2 object body.");
    await expect(parseGzipTraceEvents(fetched.body, parserOptions)).resolves.toMatchObject({
      invocationCount: 1,
    });
    const dependencies = { bucket: env.USAGE_LOGS, database: env.DB, parserOptions };

    await expect(
      importUsageLogPage(dependencies, { observedAt, prefix: "logs/" }),
    ).resolves.toEqual({
      kind: "complete",
      importedObjects: 1,
      replayedObjects: 0,
      metadataRowsRead: 0,
    });
    await expect(
      importUsageLogPage(dependencies, { observedAt: observedAt + 10 * 60_000, prefix: "logs/" }),
    ).resolves.toEqual({
      kind: "complete",
      importedObjects: 0,
      replayedObjects: 1,
      metadataRowsRead: 0,
    });

    await expect(
      env.DB.prepare(
        `SELECT objects.state, objects.stable_observation_count,
                hours.invocation_count, hours.worker_cpu_ms
         FROM usage_log_objects AS objects
         JOIN usage_log_object_hours AS hours USING (object_key)`,
      ).first(),
    ).resolves.toEqual({
      state: "parsed",
      stable_observation_count: 2,
      invocation_count: 1,
      worker_cpu_ms: 7,
    });
  });
});
