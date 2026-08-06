import { describe, expect, it, vi } from "vitest";
import { writeProductUsagePoint } from "./product-analytics";

describe("product usage analytics rows", () => {
  it("writes one fixed identifier-free row", () => {
    const writeDataPoint = vi.fn();

    writeProductUsagePoint(
      { writeDataPoint },
      {
        environment: "staging",
        toolId: "image.compress",
        event: "processing-failed",
        duration: "3-10s",
        failure: "resource-limit",
        versionId: "123e4567-e89b-42d3-a456-426614174000",
        releaseSha256: "a".repeat(64),
      },
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["staging:product-usage-v1"],
      blobs: [
        "product-usage@1",
        "staging",
        "image.compress",
        "processing-failed",
        "3-10s",
        "resource-limit",
        "123e4567-e89b-42d3-a456-426614174000",
        "a".repeat(64),
      ],
    });
  });

  it("rejects event-dependent fields before writing", () => {
    const writeDataPoint = vi.fn();

    expect(() =>
      writeProductUsagePoint(
        { writeDataPoint },
        {
          environment: "production",
          toolId: "pdf.merge",
          event: "processing-succeeded",
          failure: "processing-error",
          versionId: "123e4567-e89b-42d3-a456-426614174000",
          releaseSha256: "b".repeat(64),
        },
      ),
    ).toThrow();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it.each([
    ["environment", { environment: "preview" }],
    ["version", { versionId: "not-a-version" }],
    ["release", { releaseSha256: "not-a-release" }],
  ])("rejects an invalid %s identity", (_label, override) => {
    const writeDataPoint = vi.fn();

    expect(() =>
      writeProductUsagePoint({ writeDataPoint }, {
        environment: "staging",
        toolId: "pdf.merge",
        event: "download-requested",
        versionId: "123e4567-e89b-42d3-a456-426614174000",
        releaseSha256: "b".repeat(64),
        ...override,
      } as Parameters<typeof writeProductUsagePoint>[1]),
    ).toThrow();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
});
