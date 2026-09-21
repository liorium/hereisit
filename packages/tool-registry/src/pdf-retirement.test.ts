import { expect, it } from "vitest";
import { findAvailableToolById } from "./tool-catalog";
import { recommendAvailableTools, searchAvailableTools, selectHomeTools } from "./tool-discovery";

it("does not offer retired PDF tools through search, uploads, or saved recent tools", () => {
  expect(searchAvailableTools("PDF")).toEqual([]);
  expect(recommendAvailableTools([{ index: 0, kind: "application/pdf" }])).toEqual([]);
  expect(findAvailableToolById("pdf.merge")).toBeUndefined();
  expect(
    selectHomeTools({ domain: "all", recentToolIds: ["pdf.merge", "image.compress"] })[0]?.id,
  ).toBe("image.compress");
  expect(searchAvailableTools("이미지 용량 줄이기")[0]?.route).toBe("/image/compress");
});
