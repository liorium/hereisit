import { describe, expect, it } from "vitest";
import {
  createPdfPagePlan,
  MAX_PDF_PAGE_PLAN_ITEMS,
  movePdfPage,
  removePdfPage,
  rotatePdfPage,
} from "./page-plan";

describe("PDF page planning", () => {
  it("creates an identity plan with no rotation", () => {
    expect(createPdfPagePlan(3)).toEqual([
      { sourcePage: 1, rotateBy: 0 },
      { sourcePage: 2, rotateBy: 0 },
      { sourcePage: 3, rotateBy: 0 },
    ]);
  });

  it("accepts the maximum bounded page count", () => {
    const plan = createPdfPagePlan(MAX_PDF_PAGE_PLAN_ITEMS);

    expect(plan).toHaveLength(500);
    expect(plan.at(-1)).toEqual({ sourcePage: 500, rotateBy: 0 });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    501,
  ])("rejects an invalid page count: %s", (pageCount) => {
    expect(() => createPdfPagePlan(pageCount)).toThrow(RangeError);
  });

  it("moves pages one position without mutating the original plan", () => {
    const original = createPdfPagePlan(3);
    const movedUp = movePdfPage(original, 1, -1);
    const movedDown = movePdfPage(movedUp, 1, 1);

    expect(movedUp.map((item) => item.sourcePage)).toEqual([2, 1, 3]);
    expect(movedDown.map((item) => item.sourcePage)).toEqual([2, 3, 1]);
    expect(original.map((item) => item.sourcePage)).toEqual([1, 2, 3]);
  });

  it("keeps the same plan at movement boundaries", () => {
    const plan = createPdfPagePlan(2);

    expect(movePdfPage(plan, 0, -1)).toBe(plan);
    expect(movePdfPage(plan, 1, 1)).toBe(plan);
  });

  it("rotates clockwise and counterclockwise in 90-degree steps", () => {
    const original = createPdfPagePlan(1);
    const clockwise = rotatePdfPage(original, 0, 1);
    const fullTurn = rotatePdfPage(rotatePdfPage(rotatePdfPage(clockwise, 0, 1), 0, 1), 0, 1);
    const counterclockwise = rotatePdfPage(original, 0, -1);

    expect(clockwise[0]?.rotateBy).toBe(90);
    expect(fullTurn[0]?.rotateBy).toBe(0);
    expect(counterclockwise[0]?.rotateBy).toBe(270);
    expect(original[0]?.rotateBy).toBe(0);
  });

  it("removes one page without renumbering source pages or mutating the input", () => {
    const original = createPdfPagePlan(3);
    const next = removePdfPage(original, 1);

    expect(next).toEqual([
      { sourcePage: 1, rotateBy: 0 },
      { sourcePage: 3, rotateBy: 0 },
    ]);
    expect(original).toHaveLength(3);
  });

  it("does not allow the final page to be removed", () => {
    const plan = createPdfPagePlan(1);

    expect(removePdfPage(plan, 0)).toBe(plan);
  });

  it.each([-1, 3, 1.5, Number.NaN])("rejects an invalid plan index: %s", (index) => {
    const plan = createPdfPagePlan(3);

    expect(() => movePdfPage(plan, index, 1)).toThrow(RangeError);
    expect(() => rotatePdfPage(plan, index, 1)).toThrow(RangeError);
    expect(() => removePdfPage(plan, index)).toThrow(RangeError);
  });
});
