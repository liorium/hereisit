import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
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
    Entrypoint: "default",
    EventTimestampMs: observedAt - 3_600_000,
    EventType: "fetch",
    Outcome: "ok",
    ScriptName: "hereisit-processing-staging",
    ScriptVersion: { id: versionId, message: null, tag: null },
  };
}

afterEach(async () => {
  await env.USAGE_LOGS.delete(objectKey);
  await env.DB.prepare("DELETE FROM usage_log_objects").run();
  await env.DB.prepare(
    `UPDATE rollout_control
     SET circuit_open = 0, reason = NULL, opened_at = NULL
     WHERE id = 1`,
  ).run();
});

describe("usage-log R2 importer", () => {
  it("streams a private gzip object into D1 and replays it without duplicate hours", async () => {
    await env.USAGE_LOGS.put(objectKey, await gzip(`${JSON.stringify(traceRecord())}\n`));
    const parserOptions = {
      scriptName: "hereisit-processing-staging",
      handlerEntrypoints: new Set(["default"]),
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
    ).resolves.toEqual({ kind: "complete", importedObjects: 1, replayedObjects: 0 });
    await expect(
      importUsageLogPage(dependencies, { observedAt: observedAt + 10 * 60_000, prefix: "logs/" }),
    ).resolves.toEqual({ kind: "complete", importedObjects: 0, replayedObjects: 1 });

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
