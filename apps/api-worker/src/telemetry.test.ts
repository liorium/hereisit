import { describe, expect, it, vi } from "vitest";
import { emitSafeProcessingEvent, safeProcessingEventSchema } from "./telemetry";

const safeEvent = {
  event: "job-terminal",
  jobId: "550e8400-e29b-41d4-a716-446655440000",
  sessionHashPrefix: "0123456789ab",
  contractId: "image.optimize@1",
  inputBytes: 1_000,
  outputBytes: 600,
  pixels: 10_000,
  reservedUnits: 20_000_000,
  actualUnits: 12_000_000,
} as const;

describe("safe processing telemetry", () => {
  it("accepts only the closed normalized event shape", () => {
    expect(safeProcessingEventSchema.parse(safeEvent)).toEqual(safeEvent);
    expect(() =>
      safeProcessingEventSchema.parse({ ...safeEvent, filename: "private.png" }),
    ).toThrow();
  });

  it("requires exactly a twelve-character lowercase hash prefix", () => {
    expect(() =>
      safeProcessingEventSchema.parse({ ...safeEvent, sessionHashPrefix: "a".repeat(64) }),
    ).toThrow();
    expect(() =>
      safeProcessingEventSchema.parse({ ...safeEvent, sessionHashPrefix: "ABCDEF012345" }),
    ).toThrow();
  });

  it("emits only a parsed event and does not serialize arbitrary errors", () => {
    const write = vi.fn();
    emitSafeProcessingEvent(safeEvent, write);
    expect(write).toHaveBeenCalledWith(safeEvent);
  });
});
