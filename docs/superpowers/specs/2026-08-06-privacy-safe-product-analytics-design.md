# Privacy-safe product analytics design

**Date:** 2026-08-06
**Status:** Approved for implementation

## Purpose

HereIsIt currently cannot distinguish real visits from development assumptions because the Pages site
has no browser analytics. Production server processing is measurable, but browser-local tools leave no
product-usage signal. Add enough anonymous analytics to answer which tools people visit, whether a run
starts and succeeds, whether a download is requested, and whether page performance is healthy without
tracking individuals or exposing file information.

The product rule remains “Simple is best.” Analytics must not add controls to tool flows, delay feedback,
or weaken the local-processing privacy boundary.

## Goals

- Measure aggregate visits, page views, paths, referrers, countries, device/browser classes, and Core Web
  Vitals with Cloudflare Web Analytics.
- Measure aggregate tool funnels: processing started, processing succeeded, processing failed, and
  download requested.
- Let the operator and Codex query product metrics with a read-only credential.
- Keep analytics failure completely independent from processing and download success.
- Make the collection boundary visible in a plain Korean privacy page before the browser can emit a
  product event.

## Non-goals

- Identifying a person, assigning an analytics user ID, or joining events into an individual journey.
- Retention, cohort, or per-user frequency analysis.
- Recording file names, contents, previews, byte counts, dimensions, output artifacts, detailed settings,
  IP addresses, session IDs, job IDs, request IDs, or URLs containing secrets.
- Proving that the browser finished saving a download. The measurable action is the download request.
- Adding an analytics administration UI, a data warehouse, Google Analytics, PostHog, a tag manager, or a
  new client dependency.
- Treating analytics as a billing source. Cloudflare billing and the existing sealed cost-accounting path
  remain authoritative for cost.

## Architecture

### Page and performance analytics

Enable Cloudflare Web Analytics for the `hereisit` Pages project. Cloudflare injects its beacon into the
next valid Pages deployment. It supplies aggregate visits, page views, path and referrer breakdowns,
country/device/browser dimensions, navigation types, page-load timings, and Core Web Vitals.

The generated Content Security Policy will allow only the Cloudflare beacon script origin and its exact
collection origin in addition to existing sources. The checked-in header generator remains the sole
source of the production CSP. No wildcard analytics origin is allowed.

Cloudflare documents six months of Web Analytics access. Unsampled beacon data is retained for seven days
and older data is aggregated. Dashboard and GraphQL results can be sampled, so reports must use the
reported sample interval and describe low-volume counts as estimates where applicable.

### Product funnel analytics

Add `POST /v1/analytics/events` to the existing processing API Worker. The route writes one data point to
a dedicated Analytics Engine dataset:

- staging: `hereisit_product_usage_staging`
- production: `hereisit_product_usage_production`

Use a separate `PRODUCT_ANALYTICS` binding rather than mixing two ordered schemas in the existing
processing-usage dataset. This is a new dataset, not a new service or dependency; Analytics Engine creates
it when the first data point is written.

The browser uses a small platform-only client based on `fetch` with `credentials: "omit"`,
`cache: "no-store"`, and `keepalive: true`. It never waits for the analytics response. There is no retry,
queue, cookie, analytics storage key, or service worker. A failed or blocked request is intentionally
dropped.

## Versioned event contract

The request body is UTF-8 JSON, at most 512 bytes, with no unknown keys:

```ts
type ProductUsageEventV1 =
  | {
      schema: "product-usage@1";
      toolId: AvailableToolId;
      event: "processing-started" | "download-requested";
    }
  | {
      schema: "product-usage@1";
      toolId: AvailableToolId;
      event: "processing-succeeded";
      duration: "lt-1s" | "1-3s" | "3-10s" | "10-30s" | "gte-30s";
    }
  | {
      schema: "product-usage@1";
      toolId: AvailableToolId;
      event: "processing-failed";
      duration: "lt-1s" | "1-3s" | "3-10s" | "10-30s" | "gte-30s";
      failure:
        | "invalid-input"
        | "unsupported"
        | "cancelled"
        | "resource-limit"
        | "processing-error";
    };
```

`AvailableToolId` is validated from the existing `@hereisit/tool-registry` available-tool catalog, which
is already a dependency of the API Worker. The browser does not provide environment, timestamp, release,
IP, or identity fields. The Worker derives environment and release identity from trusted bindings, while
Analytics Engine supplies the timestamp.

Every run emits at most one start and one terminal event. Each explicit result-download action emits one
download event. Batch tools count a run, not every source file. Retrying a run creates another aggregate
run, while repeated download clicks create repeated download requests; reports use those literal names and
do not call either value a unique user count.

The Analytics Engine row uses a fixed index, `${environment}:product-usage-v1`, and allowlisted blobs for
schema, environment, tool ID, event, duration/failure placeholders, Worker version, and release identity.
No input-derived identifier is an index or dimension. Queries use `SUM(_sample_interval)` rather than raw
row counts. Analytics Engine retains these events for three months.

## Request boundary and abuse controls

The route accepts only `POST` from the configured exact Pages origin. Existing CORS helpers remain
authoritative. It requires the JSON content type, applies the 512-byte bounded reader before parsing, and
strictly validates the tagged union. Response behavior is:

- `204`: accepted and written
- `400`: malformed or unsupported event
- `403`: unapproved origin
- `405`: unsupported method
- `413`: oversized body
- `429`: rate limit exceeded

Add a dedicated native Cloudflare rate-limit binding for analytics so analytics traffic cannot consume job
or policy limits. The key reuses the existing daily HMAC network-bucket function. The raw connecting IP is
read only to derive the rate-limit key, then discarded; neither the raw IP nor its hash is written to logs,
D1, or Analytics Engine. Missing or invalid network information fails closed without an analytics write.

The route never logs the request body. Validation and dataset failures may emit only an allowlisted generic
operational event without request data. Dataset write failure must not affect any tool request because the
analytics request is a separate best-effort call.

## Browser instrumentation

Use one shared browser helper and the existing tool IDs. Workbenches call it only at already-established
state transitions:

- immediately after a valid run is accepted: `processing-started`
- after the complete result state exists: `processing-succeeded`
- after a terminal user-visible failure or cancellation: `processing-failed`
- immediately when an enabled download action is invoked: `download-requested`

Duration begins with the accepted run and is converted locally to one of five coarse buckets. Exact
duration is not transmitted. Validation errors before a run is accepted are not processing attempts and do
not emit a start/failure pair. Analytics code must not create a second state machine or infer success from
rendered copy; each workbench reports from its existing authoritative transition.

Web Analytics supplies page views and performance, so the custom endpoint does not duplicate page-open,
country, device, browser, referrer, or Core Web Vitals events.

## Privacy disclosure

Add a plain Korean `/privacy` page and a global footer link. The page states:

- browser-local files remain on the device unless a server-processing disclosure explicitly says upload;
- aggregate Web Analytics and product funnel events are sent to Cloudflare;
- the exact product-event fields and their purposes;
- file information and user identifiers are excluded;
- the three-month custom-event and six-month Web Analytics access periods;
- Cloudflare is the infrastructure/analytics provider;
- browser blockers and network failures can make counts incomplete;
- downloads measure the requested action, not confirmed disk completion.

The page is factual product disclosure, not a claim of external legal review. The privacy page, footer link,
event client, endpoint, and CSP changes ship as one immutable release. A browser cannot load that release's
analytics client without also receiving the disclosure link and available privacy page.

## Query access and reporting

Use one least-privilege account token with `Account Analytics Read`. Reuse an existing monitoring token if
it already has exactly the required account and permission; do not broaden a deployment token merely to
avoid another credential. Store the value outside Git and outside the application, mode `0600`, and never
print it in logs or command output.

The first operator queries report:

- daily aggregate visits and page views, excluding bots where the dataset supports it;
- page views by tool path, referrer, country, device, and browser;
- Core Web Vitals and page-load performance;
- starts, successes, failures, and download requests by tool;
- aggregate start-to-success and success-to-download-request ratios;
- failure category and duration-bucket distributions.

No query attempts to identify unique product-event users or reconstruct journeys. An administration UI is
deferred until manual SQL reporting is measurably burdensome.

## Verification

### Pure and Worker tests

- Contract validation accepts every permitted event shape and rejects missing, mismatched, oversized, and
  extra fields.
- Catalog-derived tool validation rejects planned and unknown tools.
- Duration and failure classification use one pure test table.
- Analytics rows have the exact fixed index and blob positions and never contain request-derived identity.
- Route tests cover method, origin, content type, body limit, rate limit, missing network information,
  invalid input, successful write, and dataset failure.

### Browser and privacy tests

- Representative image and PDF tools each emit one start and one terminal event for success and failure.
- Download actions emit one download request and still begin the normal browser download.
- An unavailable, rejected, or hanging analytics endpoint does not delay processing, result rendering, or
  download.
- The privacy observer permits only the exact Web Analytics and product endpoint traffic. It inspects the
  custom payload and fails on filenames, sentinels, bytes, session values, unknown fields, other external
  requests, or write requests to any other origin.
- CSP assertions require the exact Cloudflare script/collector and processing API origins and reject
  appended sources or wildcards.

### Production evidence

- `/privacy` loads and the global footer links to it on mobile and desktop.
- The deployed HTML contains the expected Cloudflare beacon and no other analytics provider.
- One generic production navigation appears in Web Analytics after provider delay.
- One synthetic tool flow produces the four expected aggregate events without a file-derived value.
- A read-only query returns those events using sampling-aware counts.
- Public processing policy remains unchanged by analytics deployment.

## Deployment order

1. Implement and verify the privacy page, footer, CSP, product-event contract, Worker endpoint, browser
   instrumentation, and query script as one release candidate.
2. Configure the staging Web Analytics site and deploy staging.
3. Run the full staging privacy and event evidence suite.
4. Prepare production Web Analytics so its beacon becomes active only with the reviewed production Pages
   deployment.
5. Deploy the immutable Worker and Pages release through the existing GitHub workflow.
6. Verify disclosure, CSP, Web Analytics, custom events, read-only queries, and unchanged public processing
   policy.

No manual Wrangler application deployment bypasses the GitHub release path.

## Cost and operational limits

Cloudflare currently does not bill Analytics Engine usage, while publishing a future Workers Paid
allowance of ten million writes and one million queries per month. HereIsIt starts far below those limits.
Web Analytics is free. The existing $5 budget alert remains unchanged. A future pricing change requires a
reviewed cost-model update before collection continues past the included allowance.

## Success criteria

- The operator can answer how many aggregate visits occurred, which tools were viewed and run, the
  aggregate success/failure/download-request funnel, and whether page performance is healthy.
- No stored event can identify a person or reveal a file, job, session, or network value.
- Blocking all analytics endpoints does not change any tool result or download behavior.
- The production disclosure and CSP match the collected data and allowed destinations.
- The assistant can query both analytics systems using a read-only credential without accessing deployment
  credentials.
