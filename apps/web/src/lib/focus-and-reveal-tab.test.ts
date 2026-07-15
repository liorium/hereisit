import { describe, expect, it, vi } from "vitest";
import { focusAndRevealTab } from "./focus-and-reveal-tab";

function createTarget({
  scrollportLeft = 10,
  scrollportRight = 110,
  tabLeft,
  tabRight,
}: {
  scrollportLeft?: number;
  scrollportRight?: number;
  tabLeft: number;
  tabRight: number;
}) {
  const order: string[] = [];
  const scrollBy = vi.fn(() => order.push("scroll"));
  const scrollIntoView = vi.fn(() => order.push("legacy-scroll"));
  const target = {
    focus: vi.fn(() => order.push("focus")),
    getBoundingClientRect: vi.fn(() => ({ left: tabLeft, right: tabRight })),
    parentElement: {
      getBoundingClientRect: vi.fn(() => ({ left: scrollportLeft, right: scrollportRight })),
      scrollBy,
    },
    scrollIntoView,
  };

  return { order, scrollBy, scrollIntoView, target };
}

describe("focusAndRevealTab", () => {
  it("focuses without implicit scrolling and reveals a tab hidden on the left", () => {
    const { order, scrollBy, scrollIntoView, target } = createTarget({
      tabLeft: -20,
      tabRight: 60,
    });

    focusAndRevealTab(target);

    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollBy).toHaveBeenCalledWith({ behavior: "auto", left: -30 });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(order).toEqual(["focus", "scroll"]);
  });

  it("reveals a tab hidden on the right with the nearest LTR delta", () => {
    const { scrollBy, scrollIntoView, target } = createTarget({ tabLeft: 80, tabRight: 140 });

    focusAndRevealTab(target);

    expect(scrollBy).toHaveBeenCalledWith({ behavior: "auto", left: 30 });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll an already visible tab", () => {
    const { order, scrollBy, scrollIntoView, target } = createTarget({
      tabLeft: 20,
      tabRight: 100,
    });

    focusAndRevealTab(target);

    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(order).toEqual(["focus"]);
  });

  it("does nothing when the ref is not mounted", () => {
    expect(() => focusAndRevealTab(null)).not.toThrow();
  });

  it("focuses but does not scroll when the target has no parent", () => {
    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    const target = {
      focus,
      getBoundingClientRect: vi.fn(() => ({ left: 0, right: 80 })),
      parentElement: null,
      scrollIntoView,
    };

    focusAndRevealTab(target);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
