import { describe, expect, it, vi } from "vitest";
import { type FocusAndRevealTarget, focusAndRevealTab } from "./focus-and-reveal-tab";

describe("focusAndRevealTab", () => {
  it("focuses without implicit scrolling and reveals only the nearest inline area", () => {
    const order: string[] = [];
    const target: FocusAndRevealTarget = {
      focus: vi.fn((options) => {
        order.push("focus");
        expect(options).toEqual({ preventScroll: true });
      }),
      scrollIntoView: vi.fn((options) => {
        order.push("scroll");
        expect(options).toEqual({ behavior: "auto", block: "nearest", inline: "nearest" });
      }),
    };

    focusAndRevealTab(target);

    expect(order).toEqual(["focus", "scroll"]);
  });

  it("does nothing when the ref is not mounted", () => {
    expect(() => focusAndRevealTab(null)).not.toThrow();
  });
});
