# Privacy-safe Product Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add aggregate page-performance and tool-funnel analytics without recording identifiers or file information and without changing tool or download behavior.

**Architecture:** Cloudflare Web Analytics supplies page views and real-user performance. A tiny fire-and-forget browser client posts a versioned allowlisted event to the existing processing Worker, which validates, rate-limits, and writes it to a separate Analytics Engine dataset. One read-only operator script queries both Cloudflare RUM GraphQL and the product dataset.

**Tech Stack:** Next.js 16 static export, React 19, TypeScript 6, Cloudflare Workers, Analytics Engine, native Cloudflare Rate Limiting, Vitest, Playwright, pnpm 11.

## Global Constraints

- Files remain browser-local unless an existing server-processing disclosure explicitly says they are uploaded.
- Never send or log file names, contents, previews, byte counts, dimensions, settings, presigned URLs, IP addresses, IP hashes, session IDs, job IDs, or request IDs.
- The custom request body is UTF-8 JSON and at most 512 bytes; unknown keys are rejected.
- The event schema is exactly `product-usage@1`.
- Allowed events are `processing-started`, `processing-succeeded`, `processing-failed`, and `download-requested`.
- Duration buckets are exactly `lt-1s`, `1-3s`, `3-10s`, `10-30s`, and `gte-30s`.
- Failure classes are exactly `invalid-input`, `unsupported`, `cancelled`, `resource-limit`, and `processing-error`.
- Analytics is best effort: it has no retry, queue, cookie, storage key, service worker, or awaited UI dependency.
- Add no runtime dependency. Reuse Zod, `fetch`, the existing tool catalog, HMAC network buckets, and Cloudflare bindings.
- Web Analytics, privacy disclosure, Worker endpoint, CSP, and instrumentation ship in the same immutable release.
- Deploy only through the existing GitHub staging-to-production workflows; do not manually deploy application code with Wrangler.

---

### Task 1: Versioned contract and best-effort browser client

**Files:**
- Create: `packages/tool-contracts/src/product-usage.ts`
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/package.json`
- Create: `apps/web/src/lib/product-analytics.ts`
- Create: `apps/web/src/lib/product-analytics.test.ts`

**Interfaces:**
- Consumes: `AvailableToolId` from `@hereisit/tool-registry/catalog` and `readProcessingClientConfig(): { apiOrigin: string | null }` from `apps/web/src/lib/processing-config.ts`.
- Produces: `productUsageEventSchema`, `ProductUsageEventV1`, `ProductUsageFailure`, `ProductUsageDuration`, `startProductUsageRun(toolId)`, `reportDownloadRequested(toolId)`, and `classifyProductUsageFailure(code)`.

- [ ] **Step 1: Write the shared contract and browser-client tests**

Add strict schema tests through the browser helper test so the exact serialized shapes are executable:

```ts
import { productUsageEventSchema } from "@hereisit/tool-contracts/product-usage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProductUsageFailure,
  durationBucket,
  reportDownloadRequested,
  startProductUsageRun,
} from "./product-analytics";

describe("privacy-safe product analytics", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only the four versioned allowlisted event shapes", () => {
    expect(productUsageEventSchema.parse({
      schema: "product-usage@1",
      toolId: "image.compress",
      event: "processing-started",
    })).toBeDefined();
    expect(() => productUsageEventSchema.parse({
      schema: "product-usage@1",
      toolId: "image.compress",
      event: "processing-started",
      filename: "private.png",
    })).toThrow();
  });

  it.each([
    [0, "lt-1s"], [999, "lt-1s"], [1_000, "1-3s"], [3_000, "3-10s"],
    [10_000, "10-30s"], [30_000, "gte-30s"],
  ] as const)("buckets %dms as %s", (milliseconds, expected) => {
    expect(durationBucket(milliseconds)).toBe(expected);
  });

  it.each([
    ["INVALID_SPEC", "invalid-input"],
    ["UNSUPPORTED_INPUT", "unsupported"],
    ["MEMORY_LIMIT", "resource-limit"],
    ["WORKER_CRASH", "processing-error"],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(classifyProductUsageFailure(code)).toBe(expected);
  });

  it("emits one start, one terminal event, and ignores later terminal calls", async () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "https://processing.example");
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const run = startProductUsageRun("image.compress", { fetcher, now: () => 10 });
    run.succeeded(1_510);
    run.failed("WORKER_CRASH", 2_000);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { schema: "product-usage@1", toolId: "image.compress", event: "processing-started" },
      {
        schema: "product-usage@1",
        toolId: "image.compress",
        event: "processing-succeeded",
        duration: "1-3s",
      },
    ]);
  });

  it("returns immediately and swallows a rejected analytics request", () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "https://processing.example");
    const fetcher = vi.fn(() => Promise.reject(new Error("offline")));
    expect(reportDownloadRequested("pdf.merge", { fetcher })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run apps/web/src/lib/product-analytics.test.ts`

Expected: FAIL because the contract and browser helper do not exist.

- [ ] **Step 3: Add the strict contract**

Create `packages/tool-contracts/src/product-usage.ts` with three strict Zod variants and a discriminated union:

```ts
import { z } from "zod";

export const PRODUCT_USAGE_SCHEMA = "product-usage@1" as const;
export const productUsageDurationSchema = z.enum(["lt-1s", "1-3s", "3-10s", "10-30s", "gte-30s"]);
export const productUsageFailureSchema = z.enum([
  "invalid-input", "unsupported", "cancelled", "resource-limit", "processing-error",
]);
const base = { schema: z.literal(PRODUCT_USAGE_SCHEMA), toolId: z.string().min(1).max(64) };

export const productUsageEventSchema = z.discriminatedUnion("event", [
  z.object({ ...base, event: z.enum(["processing-started", "download-requested"]) }).strict(),
  z.object({ ...base, event: z.literal("processing-succeeded"), duration: productUsageDurationSchema }).strict(),
  z.object({
    ...base,
    event: z.literal("processing-failed"),
    duration: productUsageDurationSchema,
    failure: productUsageFailureSchema,
  }).strict(),
]);

export type ProductUsageEventV1 = z.infer<typeof productUsageEventSchema>;
export type ProductUsageDuration = z.infer<typeof productUsageDurationSchema>;
export type ProductUsageFailure = z.infer<typeof productUsageFailureSchema>;
```

Export the module from `packages/tool-contracts/package.json` as `./product-usage` and re-export its public types/constants from `src/index.ts`.

- [ ] **Step 4: Add the fire-and-forget browser helper**

Implement `apps/web/src/lib/product-analytics.ts` with no storage and no returned promise:

```ts
import type {
  ProductUsageEventV1,
  ProductUsageFailure,
  ProductUsageDuration,
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

const invalidInputCodes = new Set(["CORRUPT_INPUT", "CORRUPT_PDF", "INVALID_REQUEST", "INVALID_SPEC", "PAGE_RANGE_INVALID"]);
const unsupportedCodes = new Set(["PASSWORD_PROTECTED", "PRIVATE", "UNSUPPORTED_BROWSER", "UNSUPPORTED_FEATURE", "UNSUPPORTED_INPUT"]);
const resourceLimitCodes = new Set(["INPUT_LIMIT_EXCEEDED", "MEMORY_LIMIT", "PAGE_LIMIT", "PIXEL_LIMIT_EXCEEDED", "QUOTA_EXCEEDED"]);

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
    // Analytics must never affect a tool action.
  }
}

export function startProductUsageRun(toolId: AvailableToolId, options: SendOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let settled = false;
  send({ schema: "product-usage@1", toolId, event: "processing-started" }, fetcher);
  const finish = (event: ProductUsageEventV1) => {
    if (settled) return;
    settled = true;
    send(event, fetcher);
  };
  return {
    succeeded: (endedAt = now()) => finish({
      schema: "product-usage@1", toolId, event: "processing-succeeded",
      duration: durationBucket(Math.max(0, endedAt - startedAt)),
    }),
    failed: (code?: string, endedAt = now()) => finish({
      schema: "product-usage@1", toolId, event: "processing-failed",
      duration: durationBucket(Math.max(0, endedAt - startedAt)),
      failure: classifyProductUsageFailure(code),
    }),
    cancelled: (endedAt = now()) => finish({
      schema: "product-usage@1", toolId, event: "processing-failed",
      duration: durationBucket(Math.max(0, endedAt - startedAt)), failure: "cancelled",
    }),
  };
}

export function reportDownloadRequested(toolId: AvailableToolId, options: SendOptions = {}): void {
  send({ schema: "product-usage@1", toolId, event: "download-requested" }, options.fetcher ?? fetch);
}
```

- [ ] **Step 5: Run focused tests and type checking**

Run: `pnpm vitest run apps/web/src/lib/product-analytics.test.ts && pnpm --filter @hereisit/tool-contracts typecheck && pnpm --filter @hereisit/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tool-contracts apps/web/src/lib/product-analytics.ts apps/web/src/lib/product-analytics.test.ts
git commit -m "feat: add privacy-safe product event client"
```

---

### Task 2: Worker ingestion boundary and identifier-free Analytics Engine row

**Files:**
- Create: `apps/api-worker/src/product-analytics.ts`
- Create: `apps/api-worker/src/product-analytics.test.ts`
- Create: `apps/api-worker/src/routes/product-analytics.ts`
- Create: `apps/api-worker/src/routes/product-analytics.test.ts`
- Modify: `apps/api-worker/src/router.ts`
- Modify: `apps/api-worker/src/env.ts`

**Interfaces:**
- Consumes: `productUsageEventSchema`, `availableToolEntries`, `hashNetworkBuckets()`, `readBoundedJson()`, `env.PRODUCT_ANALYTICS`, `env.PRODUCT_ANALYTICS_RATE_LIMITER`, `env.WORKER_VERSION.id`, and `env.RELEASE_REPORT_SHA256`.
- Produces: `writeProductUsagePoint(dataset, point): void`, `routeProductAnalyticsRequest(request, runtime): Promise<Response>`, and router support for `POST /v1/analytics/events`.

- [ ] **Step 1: Write the Analytics Engine row test**

```ts
it("writes one fixed identifier-free row", () => {
  const writeDataPoint = vi.fn();
  writeProductUsagePoint({ writeDataPoint }, {
    environment: "staging",
    toolId: "image.compress",
    event: "processing-failed",
    duration: "3-10s",
    failure: "resource-limit",
    versionId: "123e4567-e89b-42d3-a456-426614174000",
    releaseSha256: "a".repeat(64),
  });
  expect(writeDataPoint).toHaveBeenCalledWith({
    indexes: ["staging:product-usage-v1"],
    blobs: [
      "product-usage@1", "staging", "image.compress", "processing-failed",
      "3-10s", "resource-limit", "123e4567-e89b-42d3-a456-426614174000", "a".repeat(64),
    ],
  });
});
```

- [ ] **Step 2: Write route trust-boundary tests**

Cover exact outcomes with a runtime containing spies for `readJson`, `hashNetwork`, `rateLimiter.limit`, and `writePoint`:

```ts
it.each([
  ["GET", 405],
  ["POST", 400],
] as const)("rejects invalid %s requests", async (method, status) => {
  const request = new Request("https://api.example/v1/analytics/events", {
    method,
    headers: method === "POST" ? {
      origin: "https://hereisit.pages.dev",
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
    } : undefined,
    body: method === "POST" ? JSON.stringify({ schema: "product-usage@1" }) : undefined,
  });
  expect((await routeProductAnalyticsRequest(request, makeRuntime())).status).toBe(status);
});

it("rate-limits by the transient HMAC key and never writes it", async () => {
  const runtime = makeRuntime();
  runtime.hashNetwork = vi.fn(async () => "daily-hmac");
  const response = await routeProductAnalyticsRequest(validRequest(), runtime);
  expect(response.status).toBe(204);
  expect(runtime.rateLimiter.limit).toHaveBeenCalledWith({ key: "daily-hmac" });
  expect(runtime.writePoint).toHaveBeenCalledWith(expect.not.objectContaining({
    ip: expect.anything(), network: expect.anything(), session: expect.anything(),
  }));
});
```

Also assert: missing/invalid network returns `400` without a write, 513 streamed bytes returns `413`, unknown/extra fields and planned tool IDs return `400`, limiter denial returns `429` with `retry-after: 60`, dataset failure returns generic `503`, and a valid event returns `204`.

- [ ] **Step 3: Run the focused Worker tests and verify they fail**

Run: `pnpm vitest run apps/api-worker/src/product-analytics.test.ts apps/api-worker/src/routes/product-analytics.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement fixed-layout row writing**

In `apps/api-worker/src/product-analytics.ts`, validate environment, UUID, SHA-256, and event-dependent empty markers before calling:

```ts
dataset.writeDataPoint({
  indexes: [`${point.environment}:product-usage-v1`],
  blobs: [
    "product-usage@1",
    point.environment,
    point.toolId,
    point.event,
    point.duration ?? "",
    point.failure ?? "",
    point.versionId,
    point.releaseSha256,
  ],
});
```

No request-derived value may occupy the index, release, or identity positions.

- [ ] **Step 5: Implement the route with existing primitives**

Build an `availableToolIds` set once from `availableToolEntries`. In `routeProductAnalyticsRequest`:

1. Reject non-POST with `405` and `Allow: POST, OPTIONS`.
2. Require `cf-connecting-ip`.
3. Derive only `hashNetworkBuckets(...).writeHash` for the current UTC date.
4. Await `PRODUCT_ANALYTICS_RATE_LIMITER.limit({ key })`; return `429` and `retry-after: 60` on denial.
5. Call `readBoundedJson(request, 512)` and preserve `RangeError` as `413`; map all other parse/header failures to `400`.
6. Parse with `productUsageEventSchema` and reject tool IDs absent from the available catalog.
7. Write the fixed row and return `204`; on dataset failure return generic `503` without logging the request or exception payload.

Keep the trust boundary explicit:

```ts
export interface ProductAnalyticsRouteRuntime {
  currentSecret: string;
  previousSecret: string;
  rateLimiter: Pick<RateLimit, "limit">;
  readJson: (request: Request, maximumBytes: number) => Promise<unknown>;
  writePoint: (point: ProductUsagePoint) => void;
  now: () => Date;
}

const connectingIp = request.headers.get("cf-connecting-ip");
if (connectingIp === null) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
```

- [ ] **Step 6: Wire the route through the existing CORS router**

Add route kind `analytics` with methods `POST, OPTIONS` to `routeRequestWithDependencies`. Add an `analytics` runtime to `RouterRouteRuntimes`, route `/v1/analytics/events`, and construct it in `routeRequest()` from the existing secrets/config plus the new dataset and limiter bindings. The router's existing exact-origin rejection and CORS response remain authoritative. Unlike read-only routes, analytics must reject a missing `Origin` header:

```ts
if (route.kind === "analytics" && origin === null) {
  return withCors(jsonError(403, "ORIGIN_NOT_ALLOWED"), null);
}
```

- [ ] **Step 7: Run Worker tests and type checking**

Run: `pnpm vitest run apps/api-worker/src/product-analytics.test.ts apps/api-worker/src/routes/product-analytics.test.ts apps/api-worker/src/routes/policy.test.ts && pnpm --filter @hereisit/api-worker typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api-worker/src/product-analytics.ts apps/api-worker/src/product-analytics.test.ts apps/api-worker/src/routes/product-analytics.ts apps/api-worker/src/routes/product-analytics.test.ts apps/api-worker/src/router.ts apps/api-worker/src/env.ts
git commit -m "feat: ingest anonymous product analytics"
```

---

### Task 3: Cloudflare bindings and immutable deployment configuration

**Files:**
- Modify: `scripts/generate-processing-wrangler.mjs`
- Modify: `tests/generate-processing-wrangler.test.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`
- Regenerate: `apps/api-worker/src/worker-configuration.d.ts`
- Modify: `.github/workflows/processing-staging.yml`
- Modify: `.github/workflows/processing-production.yml`
- Modify: `tests/processing-staging-workflow.test.ts`
- Modify: `tests/processing-production-workflow.test.ts`

**Interfaces:**
- Consumes: generator fields `productAnalyticsDatasetName` and `productAnalyticsRateLimitNamespaceId`.
- Produces: `PRODUCT_ANALYTICS: AnalyticsEngineDataset`, `PRODUCT_ANALYTICS_RATE_LIMITER: RateLimit`, and environment-specific datasets `hereisit_product_usage_staging` / `hereisit_product_usage_production`.

- [ ] **Step 1: Add failing generator assertions**

Extend `validInput()` and CLI arguments, then assert:

```ts
expect(config.analytics_engine_datasets).toContainEqual({
  binding: "PRODUCT_ANALYTICS",
  dataset: "hereisit_product_usage_staging",
});
expect(config.ratelimits).toContainEqual({
  name: "PRODUCT_ANALYTICS_RATE_LIMITER",
  namespace_id: "21007",
  simple: { limit: 120, period: 60 },
});
expect(() => generateProcessingWrangler({
  ...validInput(),
  productAnalyticsRateLimitNamespaceId: validInput().policyRateLimitNamespaceId,
})).toThrow(/unique/i);
```

- [ ] **Step 2: Run the generator test and verify it fails**

Run: `pnpm vitest run tests/generate-processing-wrangler.test.ts`

Expected: FAIL because the new fields and bindings are not generated.

- [ ] **Step 3: Extend the generator minimally**

Add both fields to `inputKeys`, expected environment names, namespace uniqueness, CLI scalar flags, Analytics Engine bindings, and rate-limit bindings. Use:

```js
["PRODUCT_ANALYTICS_RATE_LIMITER", value.productAnalyticsRateLimitNamespaceId, 120]
```

and:

```js
{ binding: "PRODUCT_ANALYTICS", dataset: value.productAnalyticsDatasetName }
```

The local config uses dataset `hereisit_product_usage_local`, namespace `11007`, and the same 120 requests/minute edge limit.

- [ ] **Step 4: Bind staging and production workflow values**

Add:

```yaml
PRODUCT_ANALYTICS_DATASET_NAME: hereisit_product_usage_staging
```

and generation flags:

```bash
--product-analytics-dataset-name "$PRODUCT_ANALYTICS_DATASET_NAME" \
--product-analytics-rate-limit-namespace-id 21007 \
```

Use `hereisit_product_usage_production` and namespace `22007` in production. Do not pass this dataset through the resource provisioner because Analytics Engine creates the table at first write and no separate resource mutation exists.

- [ ] **Step 5: Lock the workflow contract in tests**

Assert each workflow contains its exact dataset name, binding flag, and environment-specific namespace and that staging/production values differ.

- [ ] **Step 6: Regenerate Worker types and run focused checks**

Run:

```bash
pnpm --filter @hereisit/api-worker types
pnpm vitest run tests/generate-processing-wrangler.test.ts tests/processing-staging-workflow.test.ts tests/processing-production-workflow.test.ts
pnpm --filter @hereisit/api-worker typecheck
```

Expected: generated types expose both new bindings and all tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-processing-wrangler.mjs tests/generate-processing-wrangler.test.ts apps/api-worker/wrangler.local.jsonc apps/api-worker/src/worker-configuration.d.ts .github/workflows/processing-staging.yml .github/workflows/processing-production.yml tests/processing-staging-workflow.test.ts tests/processing-production-workflow.test.ts
git commit -m "chore: bind product analytics datasets"
```

---

### Task 4: Instrument every existing tool at authoritative state transitions

**Files:**
- Modify: `apps/web/src/components/image-compress-workbench.tsx`
- Modify: `apps/web/src/components/image-workbench.tsx`
- Modify: `apps/web/src/components/image-watermark-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Modify: representative existing E2E specs under `tests/e2e/`

**Interfaces:**
- Consumes: `startProductUsageRun(toolId)` and `reportDownloadRequested(toolId)` from Task 1.
- Produces: at most one start and terminal event per accepted run, plus one literal event for every enabled download action.

- [ ] **Step 1: Add intercepted-event assertions to one image and one PDF flow**

In `tests/e2e/image-compression.spec.ts` and the existing merge flow in `tests/e2e/pdf-tools.spec.ts`, intercept `**/v1/analytics/events`, collect parsed bodies, return `204`, then assert exact ordered events:

```ts
expect(events.map(({ event }) => event)).toEqual([
  "processing-started",
  "processing-succeeded",
  "download-requested",
]);
expect(events.every((event) => Object.keys(event).every((key) =>
  ["schema", "toolId", "event", "duration", "failure"].includes(key),
))).toBe(true);
```

Add a cancellation/failure case that expects one `processing-failed` event with `failure: "cancelled"` or the mapped error class.

- [ ] **Step 2: Run the two focused Playwright cases and verify they fail**

Run the exact test titles with:

```bash
pnpm test:e2e -- tests/e2e/image-compression.spec.ts tests/e2e/pdf-tools.spec.ts --grep "product analytics"
```

Expected: FAIL because no product events are emitted.

- [ ] **Step 3: Instrument `image-compress-workbench.tsx`**

Create a run tracker only after `processItems()` passes all guards and has actionable items. Store it in a ref so `cancelProcessing()` can call `cancelled()`. Settle it as success when at least one output is downloadable, cancellation when every unsettled result is cancelled, otherwise failure using the first rejected error code. Call `reportDownloadRequested(toolId)` after each valid single/ZIP download guard and before invoking the download handoff.

```ts
const productRunRef = useRef<ReturnType<typeof startProductUsageRun> | null>(null);

const run = startProductUsageRun(toolId);
productRunRef.current = run;
// Existing processing state remains authoritative.
if (completed.length > 0) run.succeeded();
else if (cancelled.length > 0) run.cancelled();
else run.failed(firstFailureCode);
if (productRunRef.current === run) productRunRef.current = null;
```

- [ ] **Step 4: Instrument generic image and watermark workbenches**

Apply the same ref pattern in `image-workbench.tsx` and `image-watermark-workbench.tsx`. For a batch:

```ts
if (results.some((result) => result.status === "fulfilled")) run.succeeded();
else if (results.some((result) => result.status === "cancelled")) run.cancelled();
else run.failed(results.find((result) => result.status === "rejected")?.error.code);
```

The helper's settlement guard prevents cancellation races from producing a second terminal event.

- [ ] **Step 5: Instrument generic and specialized PDF workbenches**

In `pdf-workbench.tsx`, `pdf-compress-workbench.tsx`, and `pdf-to-image-workbench.tsx`:

- start after the current valid spec/preflight guard;
- call `succeeded()` only for `fulfilled` results;
- call `cancelled()` from both the terminal outcome and the explicit cancel action;
- call `failed(outcome.error.code)` for rejected results and `failed("WORKER_CRASH")` in startup catches;
- call `reportDownloadRequested(toolId)` only after the stale-result guard accepts the current result and before `downloadUrl()`.

Do not emit events during file inspection, validation errors before run acceptance, settings changes, reset, file removal, or result rendering.

- [ ] **Step 6: Run focused browser tests and component type checking**

Run:

```bash
pnpm --filter @hereisit/web typecheck
pnpm test:e2e -- tests/e2e/image-compression.spec.ts tests/e2e/pdf-tools.spec.ts --grep "product analytics"
```

Expected: exact event counts and payload allowlists pass while downloads still complete.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components tests/e2e
git commit -m "feat: measure aggregate tool funnels"
```

---

### Task 5: Plain Korean privacy disclosure, footer link, and exact CSP

**Files:**
- Create: `apps/web/src/app/privacy/page.tsx`
- Create: `apps/web/src/app/privacy/privacy.module.css`
- Modify: `apps/web/src/components/site-footer.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/sitemap.ts`
- Modify: `scripts/generate-web-headers.mjs`
- Modify: `tests/generate-web-headers.test.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`

**Interfaces:**
- Produces: public `/privacy`, a global `개인정보 보호` footer link, sitemap entry, and CSP permission for the exact Cloudflare beacon script URL.

- [ ] **Step 1: Write failing page, sitemap, and CSP assertions**

Assert the generated header contains:

```ts
expect(headers).toContain("script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com/beacon.min.js");
expect(headers).toContain("connect-src 'self'");
expect(headers).not.toContain("script-src *");
expect(headers).not.toContain("connect-src *");
```

Add an E2E assertion that `/privacy` has heading `개인정보 보호`, every page footer links to `/privacy`, and the sitemap contains `https://hereisit.pages.dev/privacy`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm vitest run tests/generate-web-headers.test.ts && pnpm test:e2e -- tests/e2e/tool-pages.spec.ts --grep "개인정보|privacy"`

Expected: FAIL because the page/link/CSP entry do not exist.

- [ ] **Step 3: Build the minimal privacy page**

Use `SiteHeader`, `SiteFooter`, and one readable article. The factual Korean copy must state:

- `파일은 기본적으로 이 기기에서 처리됩니다.`
- server upload happens only when a tool explicitly discloses server processing;
- Cloudflare receives aggregate page/performance and four product-funnel events;
- product fields are tool ID, event, coarse duration, failure category, environment, and release identity;
- file information and user/network identifiers are excluded;
- custom events are retained for three months and Web Analytics is accessible for six months;
- blockers/network failures make counts incomplete;
- download means requested, not confirmed saved to disk.

Keep the page to one column with short sections, a maximum readable width, and existing neutral colors. Add no consent modal because no identifier, cookie, or analytics storage is used.

```tsx
export default function PrivacyPage() {
  return (
    <>
      <SiteHeader activePath="/privacy" />
      <main className={styles.page}>
        <article>
          <p className={styles.eyebrow}>PRIVACY</p>
          <h1>개인정보 보호</h1>
          <p>파일은 기본적으로 이 기기에서 처리됩니다.</p>
          <section><h2>수집하는 정보</h2><p>방문·성능 통계와 도구 실행 결과를 집계합니다.</p></section>
          <section><h2>수집하지 않는 정보</h2><p>파일 내용과 이름, 사용자 식별자는 수집하지 않습니다.</p></section>
          <section><h2>보관과 한계</h2><p>통계는 집계되며 차단 도구나 네트워크 상태에 따라 빠질 수 있습니다.</p></section>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 4: Add the global footer link and sitemap entry**

Use Next `Link` in `SiteFooter` and add `/privacy` to the static sitemap. Keep the current footer message and add only one plainly labeled link.

- [ ] **Step 5: Allow only Cloudflare's automatically injected beacon**

Append `https://static.cloudflareinsights.com/beacon.min.js` to `script-src`. Keep `connect-src 'self'` because Pages automatic injection posts to the site's own `/cdn-cgi/rum`; retain the processing API origin when configured. Do not add `cloudflareinsights.com`, a wildcard, or a manual beacon snippet.

- [ ] **Step 6: Run focused tests and the static build**

Run:

```bash
pnpm vitest run tests/generate-web-headers.test.ts
pnpm --filter @hereisit/web build
pnpm verify:export
pnpm test:e2e -- tests/e2e/tool-pages.spec.ts --grep "개인정보|privacy"
```

Expected: `/privacy/index.html` is exported, linked, indexed, and covered by exact CSP.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/privacy apps/web/src/components/site-footer.tsx apps/web/src/app/globals.css apps/web/src/app/sitemap.ts scripts/generate-web-headers.mjs tests/generate-web-headers.test.ts tests/e2e/tool-pages.spec.ts
git commit -m "feat: disclose aggregate analytics"
```

---

### Task 6: Privacy observer and failure-isolation browser evidence

**Files:**
- Modify: `tests/e2e/support/privacy-observer.ts`
- Create: `tests/e2e/product-analytics.spec.ts`

**Interfaces:**
- Consumes: exact product endpoint origin from the test build and the five-key payload allowlist.
- Produces: privacy regression evidence that analytics cannot leak file data or block a tool/download.

- [ ] **Step 1: Add an explicit analytics allowance to the observer contract**

Extend `PrivacyObserverOptions` with:

```ts
productAnalyticsOrigin?: string;
```

When and only when a request is `POST ${productAnalyticsOrigin}/v1/analytics/events`, parse a body no larger than 512 UTF-8 bytes and require:

```ts
const allowedKeys = new Set(["schema", "toolId", "event", "duration", "failure"]);
```

Verify `schema === "product-usage@1"`, keys are allowlisted, and no configured sentinel occurs in URL or body. Continue treating every other cross-origin request, body, and write method as a violation. Record sanitized event names for assertions, never raw request bodies.

- [ ] **Step 2: Write the end-to-end privacy tests**

Cover these cases in `product-analytics.spec.ts`:

1. Successful image run + download emits start/success/download while a sentinel filename never appears in URL, body, console, storage, or history.
2. Successful PDF run emits the same event sequence.
3. A fulfilled-never analytics request does not delay the visible result or browser download.
4. An aborted analytics request does not create a page error or failed tool action.
5. No analytics cookie, localStorage, or sessionStorage write occurs.

Use route interception to return `204`, abort, or hold a promise; always release a held route in `finally` so teardown cannot hang.

- [ ] **Step 3: Run the focused privacy suite and fix only observed integration defects**

Run: `pnpm test:e2e -- tests/e2e/product-analytics.spec.ts`

Expected: PASS with exact event counts, zero sentinel leaks, and completed downloads under blocked analytics.

- [ ] **Step 4: Run existing privacy-sensitive image/PDF cases**

Run:

```bash
pnpm test:e2e -- tests/e2e/image-compression.spec.ts tests/e2e/pdf-compression.spec.ts tests/e2e/image-watermark.spec.ts
```

Expected: PASS; the observer's narrow exception does not weaken unrelated request checks.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/support/privacy-observer.ts tests/e2e/product-analytics.spec.ts
git commit -m "test: prove analytics privacy isolation"
```

---

### Task 7: Read-only aggregate reporting and deployment evidence

**Files:**
- Create: `scripts/report-product-analytics.mjs`
- Create: `tests/report-product-analytics.test.ts`
- Modify: `package.json`
- Create: `docs/deployment/product-analytics.md`

**Interfaces:**
- Consumes: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ANALYTICS_READ_TOKEN`, `--environment staging|production`, and `--days 1..90`.
- Produces: sanitized JSON containing aggregate page views/visits, top paths/referrers/countries/devices/browsers, p75 Web Vitals, product event counts, ratios, duration buckets, and failure classes.

- [ ] **Step 1: Write query-builder and response-bound tests**

Test that the Analytics Engine SQL:

```sql
SELECT blob3 AS tool_id,
       blob4 AS event,
       blob5 AS duration,
       blob6 AS failure,
       SUM(_sample_interval) AS event_count
FROM hereisit_product_usage_production
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND blob1 = 'product-usage@1'
  AND blob2 = 'production'
GROUP BY tool_id, event, duration, failure
ORDER BY tool_id, event, duration, failure
FORMAT JSON
```

contains no identifier dimension and that the GraphQL query filters the environment host (`processing-staging.hereisit.pages.dev` or `hereisit.pages.dev`), `bot: 0`, and the requested UTC interval. Mock both provider endpoints and assert output never includes the bearer token or provider error body. Reject responses over 256 KiB.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/report-product-analytics.test.ts`

Expected: FAIL because the report module is absent.

- [ ] **Step 3: Implement the no-dependency report script**

Use native `fetch`, strict argument validation, bounded JSON reads, and generic errors. POST the SQL returned by `buildProductUsageQuery()` in Step 1 to:

```text
https://api.cloudflare.com/client/v4/accounts/{accountId}/analytics_engine/sql
```

POST one GraphQL document to `https://api.cloudflare.com/client/v4/graphql` with account-scoped aliases for:

- `rumPageloadEventsAdaptiveGroups`: total count/visits and breakdowns by requestPath, refererHost, countryName, deviceType, and userAgentBrowser;
- `rumWebVitalsEventsAdaptiveGroups`: `largestContentfulPaintP75`, `interactionToNextPaintP75`, and `cumulativeLayoutShiftP75`.

Use this exact document, repeating the pageload node for each aggregate dimension:

```graphql
query HereIsItWebAnalytics($accountTag: String!, $start: Time!, $end: Time!, $host: String!) {
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
}
```

Use `avg.sampleInterval` in page-view output, convert LCP/INP microseconds to milliseconds, preserve CLS as unitless, and label sampled page metrics as estimates. Calculate aggregate `start_to_success_ratio` and `success_to_download_request_ratio` in JavaScript per tool; return `null` when the denominator is zero.

The CLI prints only the sanitized report JSON. Add:

```json
"analytics:report": "node scripts/report-product-analytics.mjs"
```

- [ ] **Step 4: Document credential and execution boundaries**

Document a read-only token with only `Account > Account Analytics > Read`, stored outside Git with mode `0600`. The command is:

```bash
test -n "$CLOUDFLARE_ACCOUNT_ID"
test -n "$CLOUDFLARE_ANALYTICS_READ_TOKEN"
pnpm analytics:report -- --environment production --days 7
```

State that the token must never be placed in Pages/Worker variables, GitHub deployment secrets, shell history, or command output. Web Analytics site setup is viewed in the Cloudflare dashboard and does not require broadening the deployment token.

- [ ] **Step 5: Run focused tests and full local verification**

Run:

```bash
pnpm vitest run tests/report-product-analytics.test.ts
pnpm verify
pnpm verify:all
```

Expected: all lint, types, unit, Worker integration, build, export, processing-stack, and browser tests pass. If container-backed checks cannot run because of local disk, preserve their exact failure and require the same checks to pass in CI before deployment.

- [ ] **Step 6: Commit**

```bash
git add scripts/report-product-analytics.mjs tests/report-product-analytics.test.ts package.json docs/deployment/product-analytics.md
git commit -m "feat: report aggregate product analytics"
```

- [ ] **Step 7: Enable and verify staging Web Analytics**

In Cloudflare: Workers & Pages → Pages project `hereisit` → Metrics → Web Analytics → Enable. Staging is the `processing-staging` branch of this same project. Enabling Web Analytics injects the beacon on the next Pages deployment. Do not paste a manual beacon snippet.

Push through the existing GitHub path, then verify on staging:

```bash
curl -fsS https://processing-staging.hereisit.pages.dev/privacy >/dev/null
curl -fsS https://processing-staging.hereisit.pages.dev/ | rg -F 'https://static.cloudflareinsights.com/beacon.min.js'
```

Run one synthetic image flow and the read-only report after Cloudflare's ingestion delay. Confirm the product dataset contains only the four allowed events and fixed dimensions.

- [ ] **Step 8: Promote and verify production through GitHub**

After staging evidence passes, allow the existing production workflow to deploy the identical commit. Verify:

```bash
curl -fsS https://hereisit.pages.dev/privacy >/dev/null
curl -fsS https://hereisit.pages.dev/ | rg -F 'https://static.cloudflareinsights.com/beacon.min.js'
test -n "$CLOUDFLARE_ACCOUNT_ID"
test -n "$CLOUDFLARE_ANALYTICS_READ_TOKEN"
pnpm analytics:report -- --environment production --days 1
```

Confirm public processing policy remains unchanged, analytics blocking does not affect results/downloads, and the existing $5 budget alert remains active.

---

## Final verification checklist

- [ ] `pnpm verify` passes.
- [ ] `pnpm verify:all` passes locally or in CI with the exact local resource failure documented.
- [ ] No dependency was added.
- [ ] `rg -n "filename|fileName|byteLength|sessionId|jobId|requestId|presigned" apps/web/src/lib/product-analytics.ts apps/api-worker/src/product-analytics.ts apps/api-worker/src/routes/product-analytics.ts` finds no transmitted/stored field.
- [ ] Staging and production use distinct product datasets and rate-limit namespaces.
- [ ] `/privacy` is available and linked before analytics evidence is accepted.
- [ ] Cloudflare beacon, product endpoint, and processing origin are the only newly allowed destinations.
- [ ] Report output contains aggregate metrics only and the read token is not printed.
- [ ] Deployment uses the reviewed GitHub workflow and exact source commit.
