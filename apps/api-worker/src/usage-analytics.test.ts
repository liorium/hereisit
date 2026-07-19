import { describe, expect, it, vi } from "vitest";
import {
  classifyFetchRoute,
  classifyStatus,
  eventHourKey,
  trackUsageOperation,
  writeUsageAnalyticsPoint,
} from "./usage-analytics";

const versionId = "123e4567-e89b-42d3-a456-426614174000";
const releaseSha256 = "a".repeat(64);

describe("identifier-free usage analytics", () => {
  it("writes one fixed-layout point with the event-start hour", () => {
    const writeDataPoint = vi.fn();

    writeUsageAnalyticsPoint(
      { writeDataPoint },
      {
        environment: "staging",
        eventType: "fetch",
        entrypoint: "default",
        routeClass: "job-result",
        statusClass: "success",
        eventHourKey: 495_408,
        versionId,
        releaseSha256,
      },
    );

    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["staging:usage-v1"],
      doubles: [495_408],
      blobs: [
        "usage-v1",
        "staging",
        "fetch",
        "default",
        "job-result",
        "success",
        versionId,
        releaseSha256,
      ],
    });
  });

  it("maps opaque job URLs only to bounded route classes", () => {
    const opaqueId = crypto.randomUUID();

    expect(classifyFetchRoute(new URL(`https://api.example/v1/jobs/${opaqueId}/result`))).toBe(
      "job-result",
    );
    expect(classifyFetchRoute(new URL(`https://api.example/v1/jobs/${opaqueId}`))).toBe("job-read");
    expect(classifyFetchRoute(new URL("https://api.example/private-value"))).toBe("other");
    expect(
      JSON.stringify(classifyFetchRoute(new URL(`https://api.example/v1/jobs/${opaqueId}`))),
    ).not.toContain(opaqueId);
  });

  it.each([
    [200, "success"],
    [429, "client-error"],
    [503, "server-error"],
  ] as const)("classifies status %s without preserving the exact code", (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });

  it("pins a crossing invocation to its start-hour key", () => {
    expect(eventHourKey(3_599_999)).toBe(0);
    expect(eventHourKey(3_600_000)).toBe(1);
  });

  it("rejects malformed release identities before writing", () => {
    const writeDataPoint = vi.fn();

    expect(() =>
      writeUsageAnalyticsPoint(
        { writeDataPoint },
        {
          environment: "staging",
          eventType: "fetch",
          entrypoint: "default",
          routeClass: "other",
          statusClass: "exception",
          eventHourKey: 1,
          versionId: "not-a-version",
          releaseSha256,
        },
      ),
    ).toThrow(/version/i);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("writes the exception class in a finally boundary and preserves the rejection", async () => {
    const writeDataPoint = vi.fn();
    const failure = new Error("synthetic failure");

    await expect(
      trackUsageOperation(
        { writeDataPoint },
        {
          environment: "staging",
          eventType: "scheduled",
          entrypoint: "scheduled",
          routeClass: "other",
          eventHourKey: 1,
          versionId,
          releaseSha256,
        },
        async () => {
          throw failure;
        },
        () => "success",
      ),
    ).rejects.toBe(failure);
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({ blobs: expect.arrayContaining(["exception"]) }),
    );
  });
});
