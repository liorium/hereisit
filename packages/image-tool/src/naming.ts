import type { ImageOutput } from "@hereisit/tool-contracts";

const extensionByFormat: Record<ImageOutput["format"], string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

export function safeImageBaseName(inputName: string): string {
  const normalized = inputName.replaceAll("\\", "/");
  const filename = normalized.split("/").at(-1)?.trim() ?? "";
  const lastDot = filename.lastIndexOf(".");
  const stem = (lastDot > 0 ? filename.slice(0, lastDot) : filename)
    .replace(/[<>:"|?*]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  const withoutControls = Array.from(stem)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("");
  return Array.from(withoutControls || "image")
    .slice(0, 120)
    .join("");
}

export function suggestOutputName(inputName: string, format: ImageOutput["format"]): string {
  return `${safeImageBaseName(inputName)}-hereisit.${extensionByFormat[format]}`;
}
