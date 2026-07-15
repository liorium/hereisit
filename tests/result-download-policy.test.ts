import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workbenches = [
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
  "저장·공유",
  "공유 메뉴",
] as const;

describe("download-only result delivery policy", () => {
  for (const filename of workbenches) {
    it(`${filename} contains no result-sharing policy`, async () => {
      const source = await readFile(filename, "utf8");
      for (const forbidden of forbiddenResultDeliveryText) {
        expect(source, `${filename} contains ${forbidden}`).not.toContain(forbidden);
      }
      expect(source).toContain("다운로드");
    });
  }
});
