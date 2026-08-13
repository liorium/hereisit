import { isAbsolute, normalize } from "node:path";

export type PdfCandidate = "structural" | "balanced" | "minimum";

function safePath(path: string): string {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.startsWith("-") ||
    normalize(path) !== path ||
    path.includes("\\")
  ) {
    throw new TypeError("qpdf path is invalid");
  }
  return path;
}

export function qpdfArgs(
  candidate: PdfCandidate,
  source: string,
  output: string,
): readonly string[] {
  if (!(["structural", "balanced", "minimum"] as const).includes(candidate))
    throw new TypeError("PDF candidate is invalid");
  const image =
    candidate === "structural"
      ? []
      : ["--optimize-images", `--jpeg-quality=${candidate === "balanced" ? 82 : 65}`];
  return [
    "--object-streams=generate",
    "--compress-streams=y",
    "--decode-level=generalized",
    "--recompress-flate",
    "--compression-level=9",
    "--remove-unreferenced-resources=yes",
    ...image,
    "--",
    safePath(source),
    safePath(output),
  ];
}
