import type { ImageContentClass } from "@hereisit/server-contracts";
import type { ImageOptimizeSpecV1 } from "@hereisit/tool-contracts";
import type { ImageInspection } from "./inspect";

export interface OptimizationCandidatePlan {
  readonly id: string;
  readonly codec: "mozjpeg" | "oxipng" | "quantizr-oxipng" | "libwebp";
  readonly mode: string;
  readonly quality?: number;
  readonly chroma?: "420" | "444";
  readonly effort: number;
}

export interface OptimizationPlan {
  readonly contentClass: ImageContentClass;
  readonly candidates: readonly [OptimizationCandidatePlan, ...OptimizationCandidatePlan[]];
  readonly normalizeColorWithLcms: boolean;
  readonly requirePixelExact: boolean;
  readonly requireAlphaExact: boolean;
  readonly minimumSavingsPercent: number;
}

export type OptimizationPlanningResult =
  | { readonly kind: "plan"; readonly plan: OptimizationPlan }
  | {
      readonly kind: "unsupported";
      readonly code: "UNSUPPORTED_FEATURE";
      readonly reason: "UNSAFE_SOURCE_COLOR_MODEL";
    };

const unsupported: OptimizationPlanningResult = {
  kind: "unsupported",
  code: "UNSUPPORTED_FEATURE",
  reason: "UNSAFE_SOURCE_COLOR_MODEL",
};

function candidate(
  id: string,
  codec: OptimizationCandidatePlan["codec"],
  mode: string,
  effort: number,
  options: Pick<OptimizationCandidatePlan, "quality" | "chroma"> = {},
): OptimizationCandidatePlan {
  return { id, codec, mode, effort, ...options };
}

function finalize(
  contentClass: ImageContentClass,
  candidates: readonly OptimizationCandidatePlan[],
  spec: ImageOptimizeSpecV1,
  flags: Pick<
    OptimizationPlan,
    "normalizeColorWithLcms" | "requirePixelExact" | "requireAlphaExact"
  >,
): OptimizationPlanningResult {
  if (candidates.length < 1 || candidates.length > 3) {
    throw new RangeError("optimization candidate count must be between one and three");
  }
  return {
    kind: "plan",
    plan: {
      contentClass,
      candidates: candidates as [OptimizationCandidatePlan, ...OptimizationCandidatePlan[]],
      minimumSavingsPercent: spec.minimumSavingsPercent,
      ...flags,
    },
  };
}

function planJpeg(
  source: ImageInspection,
  contentClass: ImageContentClass,
  spec: ImageOptimizeSpecV1,
): OptimizationPlanningResult {
  if (spec.mode === "lossless") {
    const safeProfile =
      source.iccProfileKind === "none" || source.iccProfileKind === "srgb-compatible";
    const safeGray = source.sourceColorModel === "gray" && source.adobeTransform === null;
    const safeYcbcr = source.sourceColorModel === "ycbcr" && source.adobeTransform === null;
    if (!safeProfile || (!safeGray && !safeYcbcr)) return unsupported;
    return finalize(
      contentClass,
      [candidate("jpeg-lossless", "mozjpeg", "lossless-structural", 3)],
      spec,
      { normalizeColorWithLcms: false, requirePixelExact: true, requireAlphaExact: true },
    );
  }

  let normalizeColorWithLcms = false;
  if (source.sourceColorModel === "cmyk") {
    if (source.iccProfileKind !== "cmyk" && source.adobeTransform !== 0) return unsupported;
    normalizeColorWithLcms = true;
  } else if (source.sourceColorModel === "ycck") {
    if (source.adobeTransform !== 2) return unsupported;
    normalizeColorWithLcms = true;
  } else if (source.sourceColorModel === "rgb") {
    if (source.adobeTransform !== 0 && source.iccProfileKind === "none") return unsupported;
    normalizeColorWithLcms = source.hasIccProfile;
  } else if (source.sourceColorModel === "ycbcr" || source.sourceColorModel === "gray") {
    normalizeColorWithLcms = source.hasIccProfile && source.iccProfileKind !== "srgb-compatible";
  } else {
    return unsupported;
  }

  const chroma: "420" | "444" =
    contentClass === "photo" || contentClass === "noisy" || contentClass === "already-optimized"
      ? "420"
      : "444";
  const qualities = spec.preset === "balanced" ? [82, 78, 86] : [74, 68, 80];
  return finalize(
    contentClass,
    qualities.map((quality) =>
      candidate(`jpeg-q${quality}-${chroma}`, "mozjpeg", "lossy", 3, { quality, chroma }),
    ),
    spec,
    { normalizeColorWithLcms, requirePixelExact: false, requireAlphaExact: true },
  );
}

function planPng(
  source: ImageInspection,
  contentClass: ImageContentClass,
  spec: ImageOptimizeSpecV1,
): OptimizationPlanningResult {
  const quantizationEligible =
    spec.mode === "smart" &&
    source.bitDepth === 8 &&
    !source.animated &&
    !source.wideGamut &&
    (source.iccProfileKind === "none" || source.iccProfileKind === "srgb-compatible");
  if (!quantizationEligible) {
    return finalize(contentClass, [candidate("png-lossless-o3", "oxipng", "lossless", 3)], spec, {
      normalizeColorWithLcms: false,
      requirePixelExact: true,
      requireAlphaExact: true,
    });
  }
  return finalize(
    contentClass,
    [
      candidate("png-quant-255-o3", "quantizr-oxipng", "quantized-255", 3, { quality: 255 }),
      candidate("png-quant-128-o3", "quantizr-oxipng", "quantized-128", 3, { quality: 128 }),
      candidate("png-lossless-o3", "oxipng", "lossless", 3),
    ],
    spec,
    { normalizeColorWithLcms: false, requirePixelExact: false, requireAlphaExact: true },
  );
}

function planWebp(
  contentClass: ImageContentClass,
  spec: ImageOptimizeSpecV1,
): OptimizationPlanningResult {
  if (spec.mode === "lossless") {
    return finalize(contentClass, [candidate("webp-lossless-m4", "libwebp", "lossless", 4)], spec, {
      normalizeColorWithLcms: false,
      requirePixelExact: true,
      requireAlphaExact: true,
    });
  }
  const flat = contentClass === "flat-graphic" || contentClass === "screenshot-text";
  const candidates =
    spec.preset === "balanced"
      ? flat
        ? [
            candidate("webp-near80-m4", "libwebp", "near-lossless", 4, { quality: 80 }),
            candidate("webp-q82-m4", "libwebp", "lossy", 4, { quality: 82 }),
          ]
        : [
            candidate("webp-q82-m4", "libwebp", "lossy", 4, { quality: 82 }),
            candidate("webp-q76-m4", "libwebp", "lossy", 4, { quality: 76 }),
          ]
      : flat
        ? [
            candidate("webp-near60-m5", "libwebp", "near-lossless", 5, { quality: 60 }),
            candidate("webp-q72-m5", "libwebp", "lossy", 5, { quality: 72 }),
            candidate("webp-q66-m5", "libwebp", "lossy", 5, { quality: 66 }),
          ]
        : [
            candidate("webp-q72-m5", "libwebp", "lossy", 5, { quality: 72 }),
            candidate("webp-q66-m5", "libwebp", "lossy", 5, { quality: 66 }),
            candidate("webp-q78-m5", "libwebp", "lossy", 5, { quality: 78 }),
          ];
  return finalize(contentClass, candidates, spec, {
    normalizeColorWithLcms: false,
    requirePixelExact: false,
    requireAlphaExact: true,
  });
}

export function planOptimization(
  source: ImageInspection,
  contentClass: ImageContentClass,
  spec: ImageOptimizeSpecV1,
): OptimizationPlanningResult {
  if (source.format === "jpeg") return planJpeg(source, contentClass, spec);
  if (source.format === "png") return planPng(source, contentClass, spec);
  return planWebp(contentClass, spec);
}
