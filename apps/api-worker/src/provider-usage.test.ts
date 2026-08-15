import { describe, expect, it, vi } from "vitest";
import { checkLogpushHour, queryAnalyticsHour } from "./provider-usage";

const accountId = "a".repeat(32);
const token = "provider-read-token";
const hourKey = 495_408;
const releaseReportSha256 = "b".repeat(64);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Cloudflare provider usage checks", () => {
  it("uses an exact GET-only Logpush status request and accepts a complete watermark", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 41,
          dataset: "workers_trace_events",
          enabled: true,
          last_complete: new Date((hourKey + 1) * 3_600_000).toISOString(),
          last_error: null,
          error_message: null,
        },
      }),
    );

    await expect(
      checkLogpushHour(fetcher, { accountId, token, jobId: 41, hourKey }),
    ).resolves.toEqual({ complete: true, lastCompleteMilliseconds: (hourKey + 1) * 3_600_000 });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/logpush/jobs/41`);
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("keeps a Logpush hour incomplete on provider error or a stale watermark", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: 41,
          dataset: "workers_trace_events",
          enabled: true,
          last_complete: new Date((hourKey + 1) * 3_600_000 - 1).toISOString(),
          last_error: "2026-07-19T10:00:00Z",
          error_message: "delivery failed",
        },
      }),
    );

    await expect(
      checkLogpushHour(fetcher, { accountId, token, jobId: 41, hourKey }),
    ).resolves.toMatchObject({ complete: false });
  });

  it("queries exact unsampled Analytics groups and returns their handler count", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        meta: [],
        data: [
          {
            event_type: "fetch",
            entrypoint: "default",
            version_id: "123e4567-e89b-42d3-a456-426614174000",
            release_report_sha256: releaseReportSha256,
            point_count: "3",
            minimum_sample_interval: 1,
            maximum_sample_interval: 1,
          },
        ],
        rows: 1,
      }),
    );

    await expect(
      queryAnalyticsHour(fetcher, {
        accountId,
        token,
        dataset: "hereisit_processing_usage_staging",
        environment: "staging",
        hourKey,
      }),
    ).resolves.toMatchObject({ handlerInvocationCount: 3, sampled: false });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(String(init?.body)).toContain("FORMAT JSON");
    expect(String(init?.body)).toContain("double1 = 495408");
    expect(String(init?.body)).toContain("blob8 AS release_report_sha256");
  });

  it("rejects Analytics results containing any sampled group", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        meta: [],
        data: [
          {
            event_type: "fetch",
            entrypoint: "default",
            version_id: "123e4567-e89b-42d3-a456-426614174000",
            release_report_sha256: releaseReportSha256,
            point_count: 2,
            minimum_sample_interval: 1,
            maximum_sample_interval: 2,
          },
        ],
        rows: 1,
      }),
    );

    await expect(
      queryAnalyticsHour(fetcher, {
        accountId,
        token,
        dataset: "hereisit_processing_usage_staging",
        environment: "staging",
        hourKey,
      }),
    ).rejects.toThrow(/sample/i);
  });

  it("rejects non-canonical or unsafe Analytics counts", async () => {
    for (const pointCount of ["03", "9007199254740992"]) {
      const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          meta: [],
          data: [
            {
              event_type: "fetch",
              entrypoint: "default",
              version_id: "123e4567-e89b-42d3-a456-426614174000",
              release_report_sha256: releaseReportSha256,
              point_count: pointCount,
              minimum_sample_interval: 1,
              maximum_sample_interval: 1,
            },
          ],
          rows: 1,
        }),
      );

      await expect(
        queryAnalyticsHour(fetcher, {
          accountId,
          token,
          dataset: "hereisit_processing_usage_staging",
          environment: "staging",
          hourKey,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects an Analytics event paired with the wrong Worker entrypoint", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        meta: [],
        data: [
          {
            event_type: "queue",
            entrypoint: "default",
            version_id: "123e4567-e89b-42d3-a456-426614174000",
            release_report_sha256: releaseReportSha256,
            point_count: 1,
            minimum_sample_interval: 1,
            maximum_sample_interval: 1,
          },
        ],
        rows: 1,
      }),
    );

    await expect(
      queryAnalyticsHour(fetcher, {
        accountId,
        token,
        dataset: "hereisit_processing_usage_staging",
        environment: "staging",
        hourKey,
      }),
    ).rejects.toThrow(/entrypoint/i);
  });
});
