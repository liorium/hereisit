import { z } from "zod";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const DATASET_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TOKEN_PATTERN = /^[!-~]{1,4096}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const logpushEnvelopeSchema = z
  .object({
    success: z.boolean(),
    errors: z.array(z.unknown()).max(0),
    messages: z.array(z.unknown()),
    result: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        dataset: z.literal("workers_trace_events"),
        enabled: z.boolean(),
        last_complete: z.string().nullable(),
        last_error: z.string().nullable(),
        error_message: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough();
const analyticsRowSchema = z
  .object({
    event_type: z.enum(["fetch", "queue", "scheduled"]),
    entrypoint: z.enum(["default", "queue", "scheduled"]),
    version_id: z.string().regex(UUID_PATTERN),
    point_count: nonnegativeInteger,
    minimum_sample_interval: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maximum_sample_interval: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const analyticsEnvelopeSchema = z
  .object({
    meta: z.array(z.unknown()).max(64),
    data: z.array(analyticsRowSchema).max(128),
    rows: nonnegativeInteger,
  })
  .passthrough();

export interface LogpushHourCheckInput {
  readonly accountId: string;
  readonly token: string;
  readonly jobId: number;
  readonly hourKey: number;
}

export interface AnalyticsHourQueryInput {
  readonly accountId: string;
  readonly token: string;
  readonly dataset: string;
  readonly environment: "local" | "staging" | "production";
  readonly hourKey: number;
}

function validateCommon(accountId: string, token: string, hourKey: number): void {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new TypeError("Cloudflare account ID is invalid.");
  if (!TOKEN_PATTERN.test(token)) throw new TypeError("Provider read token is invalid.");
  if (!Number.isSafeInteger(hourKey) || hourKey < 0) {
    throw new RangeError("Provider usage hour is invalid.");
  }
}

async function readProviderJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Provider usage request failed.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new TypeError("Provider usage response must be JSON.");
  }
  if (response.body === null) throw new TypeError("Provider usage response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel("Provider usage response exceeded its bound.");
        throw new RangeError("Provider usage response exceeded its bound.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Provider usage response contains invalid JSON.");
  } finally {
    bytes.fill(0);
  }
}

function parseTimestamp(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

export async function checkLogpushHour(
  fetcher: ProviderFetch,
  input: LogpushHourCheckInput,
): Promise<{ readonly complete: boolean; readonly lastCompleteMilliseconds: number | null }> {
  validateCommon(input.accountId, input.token, input.hourKey);
  if (!Number.isSafeInteger(input.jobId) || input.jobId < 1) {
    throw new RangeError("Logpush job ID is invalid.");
  }
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/logpush/jobs/${input.jobId}`,
    {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${input.token}` },
    },
  );
  const envelope = logpushEnvelopeSchema.parse(await readProviderJson(response));
  if (!envelope.success || envelope.result.id !== input.jobId) {
    throw new Error("Logpush status response is not authoritative.");
  }
  const lastCompleteMilliseconds = parseTimestamp(envelope.result.last_complete);
  const hourEnd = (input.hourKey + 1) * 3_600_000;
  if (!Number.isSafeInteger(hourEnd)) throw new RangeError("Logpush hour end exceeded its bound.");
  return {
    complete:
      envelope.result.enabled &&
      envelope.result.last_error === null &&
      envelope.result.error_message === null &&
      lastCompleteMilliseconds !== null &&
      lastCompleteMilliseconds >= hourEnd,
    lastCompleteMilliseconds,
  };
}

export async function queryAnalyticsHour(
  fetcher: ProviderFetch,
  input: AnalyticsHourQueryInput,
): Promise<{
  readonly handlerInvocationCount: number;
  readonly sampled: false;
  readonly groups: readonly z.infer<typeof analyticsRowSchema>[];
}> {
  validateCommon(input.accountId, input.token, input.hourKey);
  if (!DATASET_PATTERN.test(input.dataset))
    throw new TypeError("Analytics dataset name is invalid.");
  const query = `SELECT blob3 AS event_type,
       blob4 AS entrypoint,
       blob7 AS version_id,
       count() AS point_count,
       min(_sample_interval) AS minimum_sample_interval,
       max(_sample_interval) AS maximum_sample_interval
FROM ${input.dataset}
WHERE double1 = ${input.hourKey}
  AND blob1 = 'usage-v1'
  AND blob2 = '${input.environment}'
GROUP BY event_type, entrypoint, version_id
ORDER BY event_type, entrypoint, version_id
FORMAT JSON`;
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/analytics_engine/sql`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "text/plain; charset=utf-8",
      },
      body: query,
    },
  );
  const envelope = analyticsEnvelopeSchema.parse(await readProviderJson(response));
  if (envelope.rows !== envelope.data.length) {
    throw new TypeError("Analytics response row count is inconsistent.");
  }
  let handlerInvocationCount = 0;
  for (const row of envelope.data) {
    if (row.minimum_sample_interval !== 1 || row.maximum_sample_interval !== 1) {
      throw new TypeError("Sampled Analytics results cannot seal provider usage.");
    }
    handlerInvocationCount += row.point_count;
    if (!Number.isSafeInteger(handlerInvocationCount)) {
      throw new RangeError("Analytics handler count exceeded its bound.");
    }
  }
  return { handlerInvocationCount, sampled: false, groups: envelope.data };
}
