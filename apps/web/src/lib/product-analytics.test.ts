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

  it("rejects fields outside the versioned allowlist", () => {
    expect(
      productUsageEventSchema.parse({
        schema: "product-usage@1",
        toolId: "image.compress",
        event: "processing-started",
      }),
    ).toBeDefined();
    expect(() =>
      productUsageEventSchema.parse({
        schema: "product-usage@1",
        toolId: "image.compress",
        event: "processing-started",
        filename: "private.png",
      }),
    ).toThrow();
  });

  it.each([
    [0, "lt-1s"],
    [999, "lt-1s"],
    [1_000, "1-3s"],
    [3_000, "3-10s"],
    [10_000, "10-30s"],
    [30_000, "gte-30s"],
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

  it("emits one start and one terminal event", async () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "https://processing.example");
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
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

  it("returns immediately when the analytics request rejects", () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "https://processing.example");
    const fetcher = vi.fn(() => Promise.reject(new Error("offline")));
    expect(reportDownloadRequested("pdf.merge", { fetcher })).toBeUndefined();
  });

  it("does not send analytics from the privacy browser fixture", () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "http://127.0.0.1:4173");
    vi.stubEnv("NEXT_PUBLIC_PRODUCT_ANALYTICS_DISABLED", "1");
    const fetcher = vi.fn<typeof fetch>();

    reportDownloadRequested("pdf.merge", { fetcher });

    expect(fetcher).not.toHaveBeenCalled();
  });
});
