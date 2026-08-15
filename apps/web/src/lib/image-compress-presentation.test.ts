import { describe, expect, it } from "vitest";
import {
  deriveImageCompressScreen,
  resolveImageCompressionExecution,
  summarizeImageCompression,
} from "./image-compress-presentation";

describe("image compression presentation", () => {
  it("shows exactly one screen from existing workbench state", () => {
    expect(
      deriveImageCompressScreen({ processing: false, archiving: false, completedCount: 0 }),
    ).toBe("setup");
    expect(
      deriveImageCompressScreen({ processing: true, archiving: false, completedCount: 1 }),
    ).toBe("processing");
    expect(
      deriveImageCompressScreen({ processing: false, archiving: true, completedCount: 2 }),
    ).toBe("processing");
    expect(
      deriveImageCompressScreen({ processing: false, archiving: false, completedCount: 1 }),
    ).toBe("result");
  });

  it("respects an explicit local choice and otherwise follows server availability", () => {
    expect(resolveImageCompressionExecution("local", "checking")).toBe("local");
    expect(resolveImageCompressionExecution("local", "server")).toBe("local");
    expect(resolveImageCompressionExecution("server", "server")).toBe("server");
    expect(resolveImageCompressionExecution("server", "local")).toBe("local");
    expect(resolveImageCompressionExecution("server", "checking")).toBe("checking");
  });

  it("aggregates only completed result byte pairs", () => {
    expect(
      summarizeImageCompression([
        { inputBytes: 437_125, outputBytes: 171_532 },
        { inputBytes: 1_000, outputBytes: 1_000 },
      ]),
    ).toEqual({
      count: 2,
      inputBytes: 438_125,
      outputBytes: 172_532,
      reductionPercent: 60.6,
    });
  });

  it("returns no summary for an empty set and never reports negative reduction", () => {
    expect(summarizeImageCompression([])).toBeNull();
    expect(summarizeImageCompression([{ inputBytes: 100, outputBytes: 120 }])).toEqual({
      count: 1,
      inputBytes: 100,
      outputBytes: 120,
      reductionPercent: 0,
    });
  });
});
