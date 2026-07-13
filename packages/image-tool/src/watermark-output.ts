import type { ImageWatermarkSpecV1 } from "@hereisit/tool-contracts";
import type { SupportedImageFormat } from "./file-format";
import { safeImageBaseName } from "./naming";

type ResolvedImageWatermarkOutput = {
  format: "jpeg" | "png" | "webp";
  mime: "image/jpeg" | "image/png" | "image/webp";
  quality?: number;
  matte?: "#ffffff";
  sourceFormatConverted: boolean;
};

export function resolveImageWatermarkOutput(
  sourceFormat: SupportedImageFormat,
  output: ImageWatermarkSpecV1["output"],
): ResolvedImageWatermarkOutput {
  if (output.format === "source") {
    if (sourceFormat === "png") {
      return {
        format: "png",
        mime: "image/png",
        sourceFormatConverted: false,
      };
    }
    if (sourceFormat === "webp") {
      return {
        format: "webp",
        mime: "image/webp",
        quality: output.quality,
        sourceFormatConverted: false,
      };
    }
    return {
      format: "jpeg",
      mime: "image/jpeg",
      quality: output.quality,
      matte: "#ffffff",
      sourceFormatConverted: sourceFormat === "heic",
    };
  }

  if (output.format === "png") {
    return {
      format: "png",
      mime: "image/png",
      sourceFormatConverted: false,
    };
  }
  if (output.format === "webp") {
    return {
      format: "webp",
      mime: "image/webp",
      quality: output.quality,
      sourceFormatConverted: false,
    };
  }
  return {
    format: "jpeg",
    mime: "image/jpeg",
    quality: output.quality,
    matte: "#ffffff",
    sourceFormatConverted: false,
  };
}

const extensionByFormat: Record<"jpeg" | "png" | "webp", string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

export function suggestWatermarkedImageName(
  inputName: string,
  format: "jpeg" | "png" | "webp",
): string {
  return `${safeImageBaseName(inputName)}-watermarked-hereisit.${extensionByFormat[format]}`;
}

function splitFinalExtension(name: string): { stem: string; extension: string } {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) };
}

export function dedupeArchiveNames(names: readonly string[]): string[] {
  const reservedNames = new Set<string>();

  return names.map((name) => {
    if (!reservedNames.has(name.toLowerCase())) {
      reservedNames.add(name.toLowerCase());
      return name;
    }

    const { stem, extension } = splitFinalExtension(name);
    let suffix = 2;
    let candidate = `${stem}-${suffix}${extension}`;
    while (reservedNames.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${stem}-${suffix}${extension}`;
    }
    reservedNames.add(candidate.toLowerCase());
    return candidate;
  });
}
