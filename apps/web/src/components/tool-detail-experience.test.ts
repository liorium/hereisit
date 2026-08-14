import { describe, expect, it } from "vitest";
import { getToolWorkAreaPresentation } from "./tool-detail-experience";

describe("getToolWorkAreaPresentation", () => {
  it("maps every catalog experience to one honest work area", () => {
    expect(getToolWorkAreaPresentation("quick")).toEqual({
      label: "빠른 작업 영역",
      style: "quick",
    });
    expect(getToolWorkAreaPresentation("file")).toEqual({
      label: "파일 작업 영역",
      style: "file",
    });
    expect(getToolWorkAreaPresentation("workspace")).toEqual({
      label: "편집 작업 공간",
      style: "workspace",
    });
  });
});
