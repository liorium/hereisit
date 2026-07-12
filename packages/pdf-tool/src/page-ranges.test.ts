import { describe, expect, it } from "vitest";
import { parseOrderedPageSelection, parsePageSelection } from "./page-ranges";

describe("parsePageSelection", () => {
  it("normalizes ranges, whitespace, and duplicates", () => {
    expect(parsePageSelection(" 3, 1-2, 2, 8-10 ")).toEqual({
      ok: true,
      pages: [1, 2, 3, 8, 9, 10],
    });
  });

  it.each([
    "",
    "0",
    "4-2",
    "one",
    "1--3",
    "999999999999999999999999",
  ])("rejects an invalid selection: %s", (value) => {
    expect(parsePageSelection(value).ok).toBe(false);
  });

  it("rejects pages outside the known document", () => {
    expect(parsePageSelection("1-6", 5)).toEqual({
      ok: false,
      message: "이 PDF는 5페이지까지 있어요.",
    });
  });
});

describe("parseOrderedPageSelection", () => {
  it("preserves source selection order while expanding ranges and removing duplicates", () => {
    expect(parseOrderedPageSelection(" 2, 1, 2-3, 1 ")).toEqual({
      ok: true,
      pages: [2, 1, 3],
    });
  });

  it("keeps the existing corrective copy for invalid grammar", () => {
    expect(parseOrderedPageSelection("2-")).toEqual({
      ok: false,
      message: "예: 1-3, 5, 8-10 형식으로 입력해 주세요.",
    });
  });

  it("keeps the existing corrective copy for a page outside the document", () => {
    expect(parseOrderedPageSelection("3", 2)).toEqual({
      ok: false,
      message: "이 PDF는 2페이지까지 있어요.",
    });
  });

  it("keeps the existing 500-page range limit", () => {
    expect(parseOrderedPageSelection("1-501")).toEqual({
      ok: false,
      message: "한 번에 최대 500페이지까지 선택할 수 있어요.",
    });
  });
});
