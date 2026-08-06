import { pathToFileURL } from "node:url";

const MAXIMUM_RESPONSE_BYTES = 256 * 1024;
const ENVIRONMENTS = new Set(["staging", "production"]);
const EVENT_NAMES = new Set([
  "processing-started",
  "processing-succeeded",
  "processing-failed",
  "download-requested",
]);
const DURATIONS = new Set(["", "lt-1s", "1-3s", "3-10s", "10-30s", "gte-30s"]);
const FAILURES = new Set([
  "",
  "invalid-input",
  "unsupported",
  "cancelled",
  "resource-limit",
  "processing-error",
]);

const WEB_ANALYTICS_QUERY = `query HereIsItWebAnalytics($accountTag: String!, $start: Time!, $end: Time!, $host: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      totals: rumPageloadEventsAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) { count sum { visits } avg { sampleInterval } }
      paths: rumPageloadEventsAdaptiveGroups(
        limit: 100
        orderBy: [count_DESC]
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) { count dimensions { requestPath } avg { sampleInterval } }
      referrers: rumPageloadEventsAdaptiveGroups(
        limit: 50
        orderBy: [count_DESC]
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) { count dimensions { refererHost } avg { sampleInterval } }
      countries: rumPageloadEventsAdaptiveGroups(
        limit: 50
        orderBy: [count_DESC]
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) { count dimensions { countryName } avg { sampleInterval } }
      devices: rumPageloadEventsAdaptiveGroups(
        limit: 20
        orderBy: [count_DESC]
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) { count dimensions { deviceType } avg { sampleInterval } }
      browsers: rumPageloadEventsAdaptiveGroups(
        limit: 30
        orderBy: [count_DESC]
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) { count dimensions { userAgentBrowser } avg { sampleInterval } }
      vitals: rumWebVitalsEventsAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $start, datetime_leq: $end, requestHost: $host, bot: 0 }
      ) {
        count
        avg { sampleInterval }
        quantiles {
          largestContentfulPaintP75
          interactionToNextPaintP75
          cumulativeLayoutShiftP75
        }
      }
    }
  }
}`;

function validateEnvironment(environment) {
  if (!ENVIRONMENTS.has(environment)) throw new TypeError("environment is invalid");
  return environment;
}

function validateDays(days) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new TypeError("days must be an integer from 1 to 90");
  }
  return days;
}

function validateAccountId(accountId) {
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  return accountId;
}

function assertRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid response");
  }
  return value;
}

function finiteNumber(value, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError("invalid response");
  }
  return value;
}

function boundedString(value) {
  if (typeof value !== "string" || value.length > 2048) throw new TypeError("invalid response");
  return value;
}

export function buildProductUsageQuery(environment, days) {
  validateEnvironment(environment);
  validateDays(days);
  return `SELECT blob3 AS tool_id,
       blob4 AS event,
       blob5 AS duration,
       blob6 AS failure,
       SUM(_sample_interval) AS event_count
FROM hereisit_product_usage_${environment}
WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
  AND blob1 = 'product-usage@1'
  AND blob2 = '${environment}'
GROUP BY tool_id, event, duration, failure
ORDER BY tool_id, event, duration, failure
FORMAT JSON`;
}

export function buildWebAnalyticsRequest(accountId, environment, days, now = new Date()) {
  validateAccountId(accountId);
  validateEnvironment(environment);
  validateDays(days);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()))
    throw new TypeError("date is invalid");
  return {
    query: WEB_ANALYTICS_QUERY,
    variables: {
      accountTag: accountId,
      start: new Date(now.valueOf() - days * 86_400_000).toISOString(),
      end: now.toISOString(),
      host:
        environment === "staging" ? "processing-staging.hereisit.pages.dev" : "hereisit.pages.dev",
    },
  };
}

async function readBoundedJson(response) {
  if (!response.ok) throw new Error("request failed");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new TypeError("invalid response");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError("invalid response");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TypeError("invalid response");
      }
      chunks.push(value);
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
    throw new TypeError("invalid response");
  }
}

async function requestJson(fetcher, url, init) {
  let response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("Cloudflare analytics request failed");
  }
  try {
    return await readBoundedJson(response);
  } catch (error) {
    if (error instanceof Error && error.message === "request failed") {
      throw new Error("Cloudflare analytics request failed");
    }
    throw new Error("Cloudflare analytics response is invalid");
  }
}

function parseProductRows(value) {
  const data = assertRecord(value).data;
  if (!Array.isArray(data)) throw new TypeError("invalid response");
  return data.map((valueRow) => {
    const row = assertRecord(valueRow);
    const toolId = boundedString(row.tool_id);
    const event = boundedString(row.event);
    const duration = boundedString(row.duration);
    const failure = boundedString(row.failure);
    const count = finiteNumber(row.event_count);
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(toolId) ||
      toolId.length > 64 ||
      !EVENT_NAMES.has(event) ||
      !DURATIONS.has(duration) ||
      !FAILURES.has(failure) ||
      !Number.isSafeInteger(count)
    ) {
      throw new TypeError("invalid response");
    }
    return { tool_id: toolId, event, duration, failure, count };
  });
}

function aggregateProduct(rows) {
  const tools = new Map();
  const durations = new Map();
  const failures = new Map();
  for (const row of rows) {
    const counts = tools.get(row.tool_id) ?? {
      tool_id: row.tool_id,
      started: 0,
      succeeded: 0,
      failed: 0,
      download_requested: 0,
    };
    if (row.event === "processing-started") counts.started += row.count;
    if (row.event === "processing-succeeded") counts.succeeded += row.count;
    if (row.event === "processing-failed") counts.failed += row.count;
    if (row.event === "download-requested") counts.download_requested += row.count;
    tools.set(row.tool_id, counts);
    if (row.duration !== "")
      durations.set(row.duration, (durations.get(row.duration) ?? 0) + row.count);
    if (row.failure !== "") failures.set(row.failure, (failures.get(row.failure) ?? 0) + row.count);
  }
  const sortedEntries = (map) =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    event_counts: rows,
    tools: [...tools.values()]
      .sort((a, b) => a.tool_id.localeCompare(b.tool_id))
      .map((counts) => ({
        ...counts,
        start_to_success_ratio: counts.started === 0 ? null : counts.succeeded / counts.started,
        success_to_download_request_ratio:
          counts.succeeded === 0 ? null : counts.download_requested / counts.succeeded,
      })),
    duration_buckets: sortedEntries(durations),
    failure_classes: sortedEntries(failures),
  };
}

function estimateGroup(value, dimension, label) {
  const group = assertRecord(value);
  const dimensions = assertRecord(group.dimensions);
  const sampleInterval = finiteNumber(assertRecord(group.avg).sampleInterval, 1);
  return {
    [label]: boundedString(dimensions[dimension]),
    page_views: Math.round(finiteNumber(group.count) * sampleInterval),
  };
}

function parseWebAnalytics(value) {
  const root = assertRecord(value);
  if (
    "errors" in root &&
    root.errors !== null &&
    root.errors !== undefined &&
    (!Array.isArray(root.errors) || root.errors.length !== 0)
  ) {
    throw new TypeError("invalid response");
  }
  const accounts = assertRecord(assertRecord(root.data).viewer).accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new TypeError("invalid response");
  const account = assertRecord(accounts[0]);
  const totalValue = Array.isArray(account.totals) ? account.totals[0] : undefined;
  const total = totalValue === undefined ? null : assertRecord(totalValue);
  const sampleInterval =
    total === null ? 1 : finiteNumber(assertRecord(total.avg).sampleInterval, 1);
  const pageViews = total === null ? 0 : Math.round(finiteNumber(total.count) * sampleInterval);
  const visits =
    total === null ? 0 : Math.round(finiteNumber(assertRecord(total.sum).visits) * sampleInterval);
  const groups = (name, dimension, label) => {
    const values = account[name];
    if (!Array.isArray(values)) throw new TypeError("invalid response");
    return values.map((entry) => estimateGroup(entry, dimension, label));
  };
  const vitalValue = Array.isArray(account.vitals) ? account.vitals[0] : undefined;
  const quantiles =
    vitalValue === undefined ? null : assertRecord(assertRecord(vitalValue).quantiles);
  const metric = (metricValue, divisor = 1) =>
    metricValue === null || metricValue === undefined ? null : finiteNumber(metricValue) / divisor;
  return {
    estimates: true,
    sample_interval: sampleInterval,
    page_views: pageViews,
    visits,
    top_paths: groups("paths", "requestPath", "path"),
    top_referrers: groups("referrers", "refererHost", "referrer"),
    countries: groups("countries", "countryName", "country"),
    devices: groups("devices", "deviceType", "device"),
    browsers: groups("browsers", "userAgentBrowser", "browser"),
    web_vitals_p75: {
      lcp_ms: metric(quantiles?.largestContentfulPaintP75, 1000),
      inp_ms: metric(quantiles?.interactionToNextPaintP75, 1000),
      cls: metric(quantiles?.cumulativeLayoutShiftP75),
    },
  };
}

export async function createProductAnalyticsReport({
  accountId,
  token,
  environment,
  days,
  now = new Date(),
  fetcher = fetch,
}) {
  validateAccountId(accountId);
  validateEnvironment(environment);
  validateDays(days);
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
    throw new TypeError("Cloudflare analytics token is invalid");
  }
  const webRequest = buildWebAnalyticsRequest(accountId, environment, days, now);
  const authorization = `Bearer ${token}`;
  const productValue = await requestJson(
    fetcher,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    { method: "POST", headers: { authorization }, body: buildProductUsageQuery(environment, days) },
  );
  const webValue = await requestJson(fetcher, "https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(webRequest),
  });
  let product;
  let web;
  try {
    product = aggregateProduct(parseProductRows(productValue));
    web = parseWebAnalytics(webValue);
  } catch {
    throw new Error("Cloudflare analytics response is invalid");
  }
  return {
    schema: "hereisit-product-analytics-report@1",
    environment,
    interval: { start: webRequest.variables.start, end: webRequest.variables.end, days },
    web,
    product,
  };
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError("analytics report arguments are invalid");
    if (key === "--environment") parsed.environment = value;
    else if (key === "--days") parsed.days = Number(value);
    else throw new TypeError("analytics report arguments are invalid");
  }
  return parsed;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const report = await createProductAnalyticsReport({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone CLI is not a cached Turbo task.
      token: process.env.CLOUDFLARE_ANALYTICS_READ_TOKEN,
      environment: args.environment,
      days: args.days,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write("Analytics report failed.\n");
    process.exitCode = 1;
  }
}
