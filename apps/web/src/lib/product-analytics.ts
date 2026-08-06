import {
  PRODUCT_USAGE_SCHEMA,
  type ProductUsageDuration,
  type ProductUsageEventV1,
  type ProductUsageFailure,
} from "@hereisit/tool-contracts/product-usage";
import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import { readProcessingClientConfig } from "./processing-config";

type Fetcher = typeof fetch;
type SendOptions = { fetcher?: Fetcher; now?: () => number };

export function durationBucket(milliseconds: number): ProductUsageDuration {
  if (milliseconds < 1_000) return "lt-1s";
  if (milliseconds < 3_000) return "1-3s";
  if (milliseconds < 10_000) return "3-10s";
  if (milliseconds < 30_000) return "10-30s";
  return "gte-30s";
}

const invalidInputCodes = new Set([
  "CORRUPT_INPUT",
  "CORRUPT_PDF",
  "INVALID_REQUEST",
  "INVALID_SPEC",
  "PAGE_RANGE_INVALID",
]);
const unsupportedCodes = new Set([
  "PASSWORD_PROTECTED",
  "PRIVATE",
  "UNSUPPORTED_BROWSER",
  "UNSUPPORTED_FEATURE",
  "UNSUPPORTED_INPUT",
]);
const resourceLimitCodes = new Set([
  "INPUT_LIMIT_EXCEEDED",
  "MEMORY_LIMIT",
  "PAGE_LIMIT",
  "PIXEL_LIMIT_EXCEEDED",
  "QUOTA_EXCEEDED",
]);

export function classifyProductUsageFailure(code?: string): ProductUsageFailure {
  if (code !== undefined && invalidInputCodes.has(code)) return "invalid-input";
  if (code !== undefined && unsupportedCodes.has(code)) return "unsupported";
  if (code !== undefined && resourceLimitCodes.has(code)) return "resource-limit";
  return "processing-error";
}

function send(event: ProductUsageEventV1, fetcher: Fetcher): void {
  const { apiOrigin } = readProcessingClientConfig();
  if (apiOrigin === null) return;
  try {
    void fetcher(`${apiOrigin}/v1/analytics/events`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch(() => undefined);
  } catch {
    // Metrics must never interrupt a tool action.
  }
}

export function startProductUsageRun(toolId: AvailableToolId, options: SendOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let settled = false;
  send({ schema: PRODUCT_USAGE_SCHEMA, toolId, event: "processing-started" }, fetcher);

  const finish = (event: ProductUsageEventV1) => {
    if (settled) return;
    settled = true;
    send(event, fetcher);
  };

  return {
    succeeded: (endedAt = now()) =>
      finish({
        schema: PRODUCT_USAGE_SCHEMA,
        toolId,
        event: "processing-succeeded",
        duration: durationBucket(Math.max(0, endedAt - startedAt)),
      }),
    failed: (code?: string, endedAt = now()) =>
      finish({
        schema: PRODUCT_USAGE_SCHEMA,
        toolId,
        event: "processing-failed",
        duration: durationBucket(Math.max(0, endedAt - startedAt)),
        failure: classifyProductUsageFailure(code),
      }),
    cancelled: (endedAt = now()) =>
      finish({
        schema: PRODUCT_USAGE_SCHEMA,
        toolId,
        event: "processing-failed",
        duration: durationBucket(Math.max(0, endedAt - startedAt)),
        failure: "cancelled",
      }),
  };
}

export function reportDownloadRequested(toolId: AvailableToolId, options: SendOptions = {}): void {
  send(
    { schema: PRODUCT_USAGE_SCHEMA, toolId, event: "download-requested" },
    options.fetcher ?? fetch,
  );
}
