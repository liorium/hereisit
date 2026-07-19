import { describe, expect, it } from "vitest";
import { unionActivityMilliseconds } from "./container-activity";

describe("container activity union", () => {
  it("clips, sorts, and unions overlapping intervals within one UTC hour", () => {
    expect(
      unionActivityMilliseconds(
        [
          { startedAt: 3_590_000, billedUntilAt: 3_650_000 },
          { startedAt: 100_000, billedUntilAt: 180_000 },
          { startedAt: 150_000, billedUntilAt: 220_000 },
          { startedAt: 4_000_000, billedUntilAt: 4_060_000 },
        ],
        0,
        3_600_000,
      ),
    ).toBe(130_000);
  });

  it("rejects malformed or unsafe interval bounds", () => {
    expect(() =>
      unionActivityMilliseconds([{ startedAt: 2, billedUntilAt: 1 }], 0, 3_600_000),
    ).toThrow(RangeError);
    expect(() => unionActivityMilliseconds([], 1, 1)).toThrow(RangeError);
  });
});
