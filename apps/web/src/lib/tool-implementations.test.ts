import { readFileSync } from "node:fs";
import { type AvailableToolId, availableToolEntries } from "@hereisit/tool-registry/catalog";
import { describe, expect, it } from "vitest";
import {
  getToolImplementation,
  isPdfEditingIntent,
  type ToolBundleProfile,
  toolImplementationConfig,
} from "./tool-implementations";

const expectedImplementationMapping = {
  "data.json-format": { intent: "json-format", bundleProfile: "json-quick" },
  "image.blur-face": { intent: "blur-face", bundleProfile: "image-extra" },
  "image.compress": { intent: "compress", bundleProfile: "image-compression-server" },
  "image.resize": { intent: "resize", bundleProfile: "image" },
  "image.crop": { intent: "crop", bundleProfile: "image" },
  "image.convert": { intent: "convert", bundleProfile: "image" },
  "image.convert-from-jpg": { intent: "convert-from-jpg", bundleProfile: "image-extra" },
  "image.convert-to-jpg": { intent: "convert-to-jpg", bundleProfile: "image-extra" },
  "image.editor": { intent: "editor", bundleProfile: "image-extra" },
  "image.html-to-image": { intent: "html-to-image", bundleProfile: "image-extra" },
  "image.meme": { intent: "meme", bundleProfile: "image-extra" },
  "image.remove-background": { intent: "remove-background", bundleProfile: "image-extra" },
  "image.rotate": { intent: "rotate", bundleProfile: "image" },
  "image.upscale": { intent: "upscale", bundleProfile: "image-extra" },
  "image.watermark": { intent: "watermark", bundleProfile: "image-watermark" },
  "pdf.merge": { intent: "merge", bundleProfile: "pdf-editing" },
  "pdf.split": { intent: "split", bundleProfile: "pdf-editing" },
  "pdf.organize": { intent: "organize", bundleProfile: "pdf-organize" },
  "pdf.watermark": { intent: "watermark", bundleProfile: "pdf-editing" },
  "pdf.image-to-pdf": { intent: "image-to-pdf", bundleProfile: "pdf-editing" },
  "pdf.to-image": { intent: "to-image", bundleProfile: "pdf-to-images" },
  "pdf.compress-scanned": {
    intent: "compress",
    bundleProfile: "pdf-compress-scanned",
  },
} as const satisfies Record<AvailableToolId, { intent: string; bundleProfile: ToolBundleProfile }>;

const exactLiteralImplementationMapping = toolImplementationConfig satisfies {
  readonly [Id in AvailableToolId]: {
    readonly intent: (typeof expectedImplementationMapping)[Id]["intent"];
    readonly bundleProfile: (typeof expectedImplementationMapping)[Id]["bundleProfile"];
  };
};
void exactLiteralImplementationMapping;

const supportedBundleProfiles = [
  "json-quick",
  "image",
  "image-compression-server",
  "image-extra",
  "image-watermark",
  "pdf-editing",
  "pdf-organize",
  "pdf-to-images",
  "pdf-compress-scanned",
] as const satisfies readonly ToolBundleProfile[];

const smartPdfCompressionNotice =
  "텍스트와 링크는 유지하고, 이미지로만 된 스캔 PDF는 선택한 압축 수준으로 다시 만들어요. 전자서명은 무효가 될 수 있으며 원본 파일은 수정하지 않아요.";

describe("tool implementation ownership", () => {
  it("defines the exact available ID set and literal implementation mapping", () => {
    expect(Object.keys(toolImplementationConfig).sort()).toEqual(
      Object.keys(expectedImplementationMapping).sort(),
    );
    expect(Object.keys(toolImplementationConfig).sort()).toEqual(
      availableToolEntries.map(({ id }) => id).sort(),
    );

    expect(
      Object.fromEntries(
        availableToolEntries.map(({ id }) => {
          const implementation = getToolImplementation(id);
          return [
            id,
            {
              intent: implementation.intent,
              bundleProfile: implementation.bundleProfile,
            },
          ];
        }),
      ),
    ).toEqual(expectedImplementationMapping);
  });

  it("exposes only the final implementation contract fields", () => {
    const sharedFields = [
      "bundleProfile",
      "defaultSummary",
      "eyebrow",
      "family",
      "intent",
      "notices",
    ];
    const fileFields = [...sharedFields, "sourceFileLimits"];
    const quickFields = [...sharedFields, "maxDepth", "maxOutputBytes", "sourceTextLimitBytes"];

    for (const tool of availableToolEntries) {
      const implementation = getToolImplementation(tool.id);
      const expectedFields =
        implementation.family === "data"
          ? quickFields
          : implementation.family === "pdf"
            ? [...fileFields, "intentClass"]
            : fileFields;

      expect(Object.keys(implementation).sort(), tool.id).toEqual(expectedFields.sort());
    }
  });

  it("keeps catalog launchers and implementation limits aligned with each execution path", () => {
    for (const tool of availableToolEntries) {
      expect(tool.execution).toBe(
        tool.id === "image.compress" || tool.id === "pdf.compress-scanned" ? "server" : "browser",
      );
      const implementation = getToolImplementation(tool.id);

      if (tool.id === "data.json-format") {
        expect(tool.launcherInput).toBeNull();
        expect(implementation).toMatchObject({
          family: "data",
          sourceTextLimitBytes: 1024 * 1024,
          maxDepth: 100,
          maxOutputBytes: 4 * 1024 * 1024,
        });
        continue;
      }

      if (tool.id === "image.html-to-image") {
        expect(tool.launcherInput).toBeNull();
        expect(implementation).toMatchObject({
          family: "image",
          sourceFileLimits: {
            minFiles: 0,
            maxFiles: 0,
            maxFileBytes: 0,
            maxTotalBytes: 0,
          },
        });
        expect(supportedBundleProfiles).toContain(implementation.bundleProfile);
        continue;
      }

      const launcherInput = tool.launcherInput;
      if (launcherInput === null) throw new Error("Missing launcher input");

      if (!("sourceFileLimits" in implementation)) {
        throw new Error("Missing file limits");
      }
      const { sourceFileLimits, bundleProfile } = implementation;
      const { minFiles, maxFiles, maxFileBytes, maxTotalBytes } = sourceFileLimits;

      expect(launcherInput).toMatchObject({ minFiles, maxFiles });
      expect([minFiles, maxFiles, maxFileBytes, maxTotalBytes]).toSatisfy((values: number[]) =>
        values.every((value) => Number.isInteger(value) && value > 0),
      );
      expect(minFiles).toBeLessThanOrEqual(maxFiles);
      expect(supportedBundleProfiles).toContain(bundleProfile);

      if ("constrainedMaxTotalBytes" in sourceFileLimits) {
        const { constrainedMaxTotalBytes } = sourceFileLimits;
        expect(Number.isInteger(constrainedMaxTotalBytes)).toBe(true);
        expect(constrainedMaxTotalBytes).toBeGreaterThanOrEqual(maxFileBytes);
        expect(constrainedMaxTotalBytes).toBeLessThanOrEqual(maxTotalBytes);
      }
    }
  });

  it("preserves the explicit PDF editing intent classification", () => {
    for (const intent of ["merge", "split", "organize", "watermark", "image-to-pdf"] as const) {
      expect(isPdfEditingIntent(intent)).toBe(true);
    }
    for (const intent of ["compress", "to-image"] as const) {
      expect(isPdfEditingIntent(intent)).toBe(false);
    }
  });

  it("owns the approved image watermark summary and exact PDF compression notice", () => {
    expect(getToolImplementation("image.compress")).toMatchObject({
      defaultSummary:
        "원본 형식과 크기를 유지한 채 프로덕션급 압축을 시도하고, 작아지지 않으면 원본을 그대로 유지해요.",
      notices: [],
    });

    const watermarkSummary = getToolImplementation("image.watermark").defaultSummary;
    for (const approvedCopy of ["© HereIsIt", "12%", "3%", "55%", "#111827", "품질 90"]) {
      expect(watermarkSummary).toContain(approvedCopy);
    }

    expect(
      getToolImplementation("pdf.compress-scanned").notices.filter(
        ({ tone }) => tone === "warning",
      ),
    ).toEqual([{ tone: "warning", text: smartPdfCompressionNotice }]);
    expect(getToolImplementation("pdf.compress-scanned").defaultSummary).toBe(
      "기본은 고성능 처리 서버에서 압축하고, 원하면 내 기기에서 처리할 수 있어요.",
    );
  });

  it("keeps related tool navigation client-only without automatic prefetch", () => {
    const source = readFileSync(new URL("../components/tool-card.tsx", import.meta.url), "utf8");

    expect(source).toContain('import Link from "next/link";');
    expect(source).toMatch(/<Link\b(?=[^>]*\bhref=)[^>]*\bprefetch=\{false\}[^>]*>/);
  });
});
