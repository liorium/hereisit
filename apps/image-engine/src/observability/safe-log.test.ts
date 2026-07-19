import { describe, expect, it, vi } from "vitest";
import { createSafeLogger } from "./safe-log";

describe("safe engine logging", () => {
  it("allows only content-free operational fields", () => {
    const write = vi.fn();
    const logger = createSafeLogger(write);
    logger.info({
      jobId: "123e4567-e89b-42d3-a456-426614174001",
      phase: "optimizing",
      inputBytes: 3,
      code: "OK",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toMatchObject({
      phase: "optimizing",
      inputBytes: 3,
    });
  });

  it.each([
    "filename",
    "path",
    "url",
    "token",
    "metadata",
    "stderr",
    "unknown",
  ])("rejects %s", (field) => {
    const logger = createSafeLogger(vi.fn());
    expect(() => logger.info({ [field]: "private" })).toThrow("safe log");
  });
});
