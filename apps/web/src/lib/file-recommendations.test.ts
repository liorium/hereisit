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
  it("does not launch a removed PDF tool for a PDF upload", () => {
    expect(planFileRecommendations([detectedFile("document.pdf", "application/pdf")])).toEqual({
      state: "unsupported",
      unknownCount: 0,
      groups: [],
    });
  });
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

  it("keeps the PNG group when the selection also contains an unsupported PDF", () => {
    const png = detectedFile("graphic.png", "image/png");
    const pdf = detectedFile("document.pdf", "application/pdf");

    const plan = planFileRecommendations([png, pdf]);

    expect(plan).toMatchObject({
      state: "grouped",
      unknownCount: 0,
      groups: [{ kind: "image/png", items: [png] }],
    });
    expect(plan.groups[0]?.primaryRecommendation).toBeDefined();
    expect(plan.groups).toHaveLength(1);
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

  it("never recommends a planned tool and drops known groups with no available match", () => {
    const plan = planFileRecommendations([detectedFile("clip.mp4", "video/mp4")]);

    expect(plan).toEqual({ state: "unsupported", unknownCount: 0, groups: [] });
    expect(recommendationIds([detectedFile("photo.jpg", "image/jpeg")])).not.toContain(
      "media.video-compress",
    );
  });
});
