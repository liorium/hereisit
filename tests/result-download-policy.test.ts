import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workbenches = [
  "apps/web/src/components/image-compress-workbench.tsx",
  "apps/web/src/components/image-workbench.tsx",
  "apps/web/src/components/image-watermark-workbench.tsx",
  "apps/web/src/components/pdf-workbench.tsx",
  "apps/web/src/components/pdf-compress-workbench.tsx",
  "apps/web/src/components/pdf-to-image-workbench.tsx",
] as const;

const forbiddenResultDeliveryText = [
  "navigator.share",
  "navigator.canShare",
  "ShareData",
  "공유",
] as const;

function findForbiddenResultDeliveryText(source: string): readonly string[] {
  return forbiddenResultDeliveryText.filter((forbidden) => source.includes(forbidden));
}

describe("download-only result delivery policy", () => {
  it("rejects any Korean share label in result delivery copy", () => {
    expect(findForbiddenResultDeliveryText("<button>결과 공유</button>")).toContain("공유");
  });

  for (const filename of workbenches) {
    it(`${filename} contains no result-sharing policy`, async () => {
      const source = await readFile(filename, "utf8");
      expect(
        findForbiddenResultDeliveryText(source),
        `${filename} contains forbidden text`,
      ).toEqual([]);
      expect(source).toContain("다운로드");
    });
  }
});
