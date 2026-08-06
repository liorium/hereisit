import { describe, expect, it, vi } from "vitest";
import {
  buildProductUsageQuery,
  buildWebAnalyticsRequest,
  createProductAnalyticsReport,
} from "../scripts/report-product-analytics.mjs";

const accountId = "a".repeat(32);
const token = "read-token-private-value";
const now = new Date("2026-08-06T12:00:00.000Z");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function webResponse() {
  const group = (dimension: Record<string, string>) => ({
    count: 2,
    dimensions: dimension,
    avg: { sampleInterval: 2 },
  });
  return {
    data: {
      viewer: {
        accounts: [
          {
            totals: [{ count: 10, sum: { visits: 4 }, avg: { sampleInterval: 2 } }],
            paths: [group({ requestPath: "/image/compress" })],
            referrers: [group({ refererHost: "example.com" })],
            countries: [group({ countryName: "KR" })],
            devices: [group({ deviceType: "mobile" })],
            browsers: [group({ userAgentBrowser: "Chrome" })],
            vitals: [
              {
                count: 5,
                avg: { sampleInterval: 2 },
                quantiles: {
                  largestContentfulPaintP75: 2_500_000,
                  interactionToNextPaintP75: 120_000,
                  cumulativeLayoutShiftP75: 0.05,
                },
              },
            ],
          },
        ],
      },
    },
  };
}

describe("aggregate product analytics report", () => {
  it("builds fixed environment and identifier-free provider queries", () => {
    const sql = buildProductUsageQuery("production", 7);
    expect(sql).toContain("FROM hereisit_product_usage_production");
    expect(sql).toContain("timestamp >= NOW() - INTERVAL '7' DAY");
    expect(sql).toContain("blob1 = 'product-usage@1'");
    expect(sql).toContain("blob2 = 'production'");
    expect(sql).toContain("SUM(_sample_interval) AS event_count");
    expect(sql).not.toMatch(/ip|session|job|request_id|filename/i);

    const request = buildWebAnalyticsRequest(accountId, "staging", 7, now);
    expect(request.query).toContain("rumPageloadEventsAdaptiveGroups");
    expect(request.query).toContain("rumWebVitalsEventsAdaptiveGroups");
    expect(request.query.match(/requestHost: \$host, bot: 0/g)).toHaveLength(7);
    expect(request.variables).toEqual({
      accountTag: accountId,
      start: "2026-07-30T12:00:00.000Z",
      end: "2026-08-06T12:00:00.000Z",
      host: "processing-staging.hereisit.pages.dev",
    });
  });

  it("returns only bounded aggregate estimates and funnel ratios", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: [
            {
              tool_id: "image.compress",
              event: "processing-started",
              duration: "",
              failure: "",
              event_count: 10,
            },
            {
              tool_id: "image.compress",
              event: "processing-succeeded",
              duration: "1-3s",
              failure: "",
              event_count: 8,
            },
            {
              tool_id: "image.compress",
              event: "download-requested",
              duration: "",
              failure: "",
              event_count: 4,
            },
            {
              tool_id: "image.compress",
              event: "processing-failed",
              duration: "3-10s",
              failure: "unsupported",
              event_count: 2,
            },
            {
              tool_id: "pdf.merge",
              event: "download-requested",
              duration: "",
              failure: "",
              event_count: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json(webResponse()));

    const report = await createProductAnalyticsReport({
      accountId,
      token,
      environment: "production",
      days: 7,
      now,
      fetcher,
    });

    expect(report.web).toMatchObject({
      estimates: true,
      sample_interval: 2,
      page_views: 20,
      visits: 8,
      top_paths: [{ path: "/image/compress", page_views: 4 }],
      web_vitals_p75: { lcp_ms: 2500, inp_ms: 120, cls: 0.05 },
    });
    expect(report.product.tools).toEqual([
      {
        tool_id: "image.compress",
        started: 10,
        succeeded: 8,
        failed: 2,
        download_requested: 4,
        start_to_success_ratio: 0.8,
        success_to_download_request_ratio: 0.5,
      },
      {
        tool_id: "pdf.merge",
        started: 0,
        succeeded: 0,
        failed: 0,
        download_requested: 1,
        start_to_success_ratio: null,
        success_to_download_request_ratio: null,
      },
    ]);
    expect(report.product.duration_buckets).toEqual({ "1-3s": 8, "3-10s": 2 });
    expect(report.product.failure_classes).toEqual({ unsupported: 2 });
    expect(JSON.stringify(report)).not.toContain(token);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("FORMAT JSON") }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.cloudflare.com/client/v4/graphql",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps provider failures and oversized responses out of diagnostics", async () => {
    const providerBody = `provider leaked ${token}`;
    const failed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(providerBody, { status: 500 }));
    await expect(
      createProductAnalyticsReport({
        accountId,
        token,
        environment: "production",
        days: 1,
        now,
        fetcher: failed,
      }),
    ).rejects.toThrow(/^Cloudflare analytics request failed$/);

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: "x".repeat(256 * 1024) }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createProductAnalyticsReport({
        accountId,
        token,
        environment: "production",
        days: 1,
        now,
        fetcher: oversized,
      }),
    ).rejects.toThrow(/^Cloudflare analytics response is invalid$/);
  });

  it("returns zero aggregates before the first event", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(
        json({
          data: {
            viewer: {
              accounts: [
                {
                  totals: [],
                  paths: [],
                  referrers: [],
                  countries: [],
                  devices: [],
                  browsers: [],
                  vitals: [],
                },
              ],
            },
          },
        }),
      );

    const report = await createProductAnalyticsReport({
      accountId,
      token,
      environment: "staging",
      days: 1,
      now,
      fetcher,
    });

    expect(report.web).toMatchObject({
      page_views: 0,
      visits: 0,
      web_vitals_p75: { lcp_ms: null, inp_ms: null, cls: null },
    });
    expect(report.product).toMatchObject({ tools: [], duration_buckets: {}, failure_classes: {} });
  });

  it("rejects unbounded arguments before fetching", async () => {
    expect(() => buildProductUsageQuery("preview", 7)).toThrow("environment");
    expect(() => buildProductUsageQuery("production", 0)).toThrow("days");
    expect(() => buildProductUsageQuery("production", 91)).toThrow("days");
  });
});
