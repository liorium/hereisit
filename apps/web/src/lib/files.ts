import { zip } from "fflate";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export function formatSavings(inputBytes: number, outputBytes: number): string {
  if (inputBytes <= 0) return "절감률 계산 불가";
  const difference = inputBytes - outputBytes;
  if (difference === 0) return "용량 동일";
  const percentage = (Math.abs(difference) / inputBytes) * 100;
  const formatted = percentage >= 10 ? String(Math.round(percentage)) : percentage.toFixed(1);
  return difference > 0 ? `${formatted}% 절약` : `${formatted}% 증가`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}초`;
  return `${Math.round(milliseconds / 1000)}초`;
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

function safeArchiveName(requested: string): string {
  const filename = requested.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const cleaned = Array.from(filename.replace(/[<>:"|?*]/g, "-"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/^\.+/, "");
  return Array.from(cleaned || "image")
    .slice(0, 160)
    .join("");
}

function uniqueArchiveName(requested: string, names: Set<string>): string {
  const safe = safeArchiveName(requested);
  const lastDot = safe.lastIndexOf(".");
  const stem = lastDot > 0 ? safe.slice(0, lastDot) : safe;
  const extension = lastDot > 0 ? safe.slice(lastDot) : "";
  let candidate = safe;
  let suffix = 2;
  while (names.has(candidate)) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  names.add(candidate);
  return candidate;
}

export async function createZipArchive(
  files: readonly { name: string; bytes: ArrayBuffer }[],
): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  const names = new Set<string>();

  for (const file of files) {
    entries[uniqueArchiveName(file.name, names)] = new Uint8Array(file.bytes);
  }

  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 0 }, (error, result) => {
      if (error !== null) reject(error);
      else resolve(result);
    });
  });

  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}
