import { describe, expect, it } from "vitest";
import { planFileRecommendations } from "./file-recommendations";
import type { FileDetectionItem } from "./file-selection-detection";

function detectedFile(
  name: string,
  detectedKind: FileDetectionItem["detectedKind"],
): FileDetectionItem {
  return {
    file: new File([Uint8Array.of(1)], name),
    detectedKind,
  };
}

function recommendationIds(items: readonly FileDetectionItem[]): readonly string[] {
  const plan = planFileRecommendations(items);
  return plan.groups.flatMap((group) => [
    group.primaryRecommendation.tool.id,
    ...group.alternateRecommendations.map(({ tool }) => tool.id),
  ]);
}

describe("planFileRecommendations", () => {
  it("offers mixed-compatible image tools for a JPEG and PNG as one complete group", () => {
    const jpeg = detectedFile("photo.jpg", "image/jpeg");
    const png = detectedFile("graphic.png", "image/png");

    const plan = planFileRecommendations([jpeg, png]);

    expect(plan).toMatchObject({
      state: "complete",
      unknownCount: 0,
      groups: [
        {
          kind: "mixed",
          items: [jpeg, png],
          primaryRecommendation: {
            tool: { id: "image.upscale" },
          },
        },
      ],
    });
    expect(plan.groups[0]?.alternateRecommendations.map(({ tool }) => tool.id)).toEqual([
      "pdf.image-to-pdf",
      "image.compress",
      "image.remove-background",
      "image.crop",
      "image.rotate",
      "image.watermark",
      "image.resize",
      "image.convert",
      "image.convert-to-jpg",
    ]);
    expect(recommendationIds([jpeg, png])).toEqual([
      "image.upscale",
      "pdf.image-to-pdf",
      "image.compress",
      "image.remove-background",
      "image.crop",
      "image.rotate",
      "image.watermark",
      "image.resize",
      "image.convert",
      "image.convert-to-jpg",
    ]);
  });

  it("falls back to PNG and PDF groups in first-seen order when no tool accepts both", () => {
    const png = detectedFile("graphic.png", "image/png");
    const pdf = detectedFile("document.pdf", "application/pdf");

    const plan = planFileRecommendations([png, pdf]);

    expect(plan).toMatchObject({
      state: "grouped",
      unknownCount: 0,
      groups: [
        { kind: "image/png", items: [png] },
        { kind: "application/pdf", items: [pdf] },
      ],
    });
    expect(plan.groups[0]?.primaryRecommendation).toBeDefined();
    expect(plan.groups[1]?.primaryRecommendation).toBeDefined();
  });

  it("keeps a JPEG plus an unknown file grouped instead of calling the selection complete", () => {
    const jpeg = detectedFile("photo.jpg", "image/jpeg");
    const unknown = detectedFile("unknown.bin", null);

    expect(planFileRecommendations([jpeg, unknown])).toMatchObject({
      state: "grouped",
      unknownCount: 1,
      groups: [{ kind: "image/jpeg", items: [jpeg] }],
    });
  });

  it("reports an all-unknown selection as unsupported", () => {
    expect(
      planFileRecommendations([detectedFile("first.bin", null), detectedFile("second.bin", null)]),
    ).toEqual({ state: "unsupported", unknownCount: 2, groups: [] });
  });

  it("does not recommend source-preserving compression for a detected HEIC image", () => {
    const ids = recommendationIds([detectedFile("phone.jpg", "image/heic")]);

    expect(ids).not.toContain("image.compress");
    expect(ids).toContain("image.convert");
  });

  it("reports that PDF merge needs one more file for a single PDF", () => {
    const plan = planFileRecommendations([detectedFile("document.pdf", "application/pdf")]);

    expect(plan.state).toBe("complete");
    expect(
      [
        plan.groups[0]?.primaryRecommendation,
        ...(plan.groups[0]?.alternateRecommendations ?? []),
      ].find((recommendation) => recommendation?.tool.id === "pdf.merge"),
    ).toMatchObject({
      readiness: "needs-more",
      missingFiles: 1,
      maximumFiles: 20,
      matchedIndexes: [0],
    });
  });

  it("keeps one primary recommendation and puts every other match behind disclosure", () => {
    const plan = planFileRecommendations([detectedFile("document.pdf", "application/pdf")]);
    const group = plan.groups[0];

    expect(group?.primaryRecommendation.tool.id).toBe("pdf.compress-scanned");
    expect(group?.alternateRecommendations.map(({ tool }) => tool.id)).toEqual([
      "pdf.split",
      "pdf.organize",
      "pdf.to-image",
      "pdf.watermark",
      "pdf.merge",
    ]);
  });

  it("reports PDF merge as too-many for 21 PDFs", () => {
    const pdfs = Array.from({ length: 21 }, (_, index) =>
      detectedFile(`document-${index}.pdf`, "application/pdf"),
    );
    const plan = planFileRecommendations(pdfs);

    expect(plan.state).toBe("complete");
    expect(
      [
        plan.groups[0]?.primaryRecommendation,
        ...(plan.groups[0]?.alternateRecommendations ?? []),
      ].find((recommendation) => recommendation?.tool.id === "pdf.merge"),
    ).toMatchObject({
      readiness: "too-many",
      missingFiles: 0,
      maximumFiles: 20,
      matchedIndexes: Array.from({ length: 21 }, (_, index) => index),
    });
  });

  it("never recommends a planned tool and drops known groups with no available match", () => {
    const plan = planFileRecommendations([detectedFile("clip.mp4", "video/mp4")]);

    expect(plan).toEqual({ state: "unsupported", unknownCount: 0, groups: [] });
    expect(recommendationIds([detectedFile("photo.jpg", "image/jpeg")])).not.toContain(
      "media.video-compress",
    );
  });
});
