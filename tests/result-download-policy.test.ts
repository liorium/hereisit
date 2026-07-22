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
  it("treats acknowledged remote image results as one-shot downloads", async () => {
    const source = await readFile("apps/web/src/components/image-compress-workbench.tsx", "utf8");
    expect(source).toContain('kind: "remote-consumed"');
    expect(source).toContain("다운로드 완료");
    expect(source).toContain("archive.acknowledgeAfterHandoff()");
    expect(source).not.toContain("필요하면 다시 다운로드할 수 있어요");
    expect(source).not.toContain("결과는 유지되니 다시 시도해 주세요");
    expect(source).not.toContain("개별 결과도 다시 받을 수 있어요");
  });

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
