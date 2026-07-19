import type { FileKind } from "@hereisit/tool-registry/catalog";
import {
  detectFileKindPrefix,
  MAX_FILE_KIND_PREFIX_BYTES,
} from "@hereisit/tool-registry/file-kind";

export const MAX_LAUNCHER_FILES = 100;
export const MAX_DETECTION_CONCURRENCY = 2;

export interface FilePrefixLease {
  readonly bytes: Uint8Array;
  release(): void;
}

export interface FileDetectionItem {
  file: File;
  detectedKind: FileKind | null;
}

export interface DetectionProgress {
  completed: number;
  total: number;
}

export interface DetectFileSelectionOptions {
  isCurrent(): boolean;
  onProgress(progress: DetectionProgress): void;
  readPrefix?(file: File): Promise<FilePrefixLease>;
  detect?(prefix: Uint8Array, file: File): FileKind | undefined;
}

export class LauncherFileLimitError extends Error {
  readonly maximum = MAX_LAUNCHER_FILES;

  constructor() {
    super(`Select at most ${MAX_LAUNCHER_FILES} files`);
    this.name = "LauncherFileLimitError";
  }
}

export async function readFilePrefix(file: File): Promise<FilePrefixLease> {
  let bytes = new Uint8Array(await file.slice(0, MAX_FILE_KIND_PREFIX_BYTES).arrayBuffer());
  return {
    get bytes() {
      return bytes;
    },
    release() {
      bytes = new Uint8Array();
    },
  };
}

function detectPrefix(prefix: Uint8Array, file: File): FileKind | undefined {
  const extension = /(?:\.[^.]+)?$/.exec(file.name)?.[0] ?? "";
  return detectFileKindPrefix(prefix, { mime: file.type, extension });
}

export async function detectFileSelection(
  files: readonly File[],
  {
    isCurrent,
    onProgress,
    readPrefix: read = readFilePrefix,
    detect = detectPrefix,
  }: DetectFileSelectionOptions,
): Promise<readonly FileDetectionItem[] | null> {
  if (files.length > MAX_LAUNCHER_FILES) throw new LauncherFileLimitError();

  onProgress({ completed: 0, total: files.length });
  if (files.length === 0) return Object.freeze([]);

  const results: FileDetectionItem[] = new Array(files.length);
  let nextIndex = 0;
  let completed = 0;
  let firstFailure: unknown;

  async function worker(): Promise<void> {
    while (isCurrent() && firstFailure === undefined) {
      const index = nextIndex;
      if (index >= files.length) return;
      nextIndex += 1;

      const file = files[index];
      if (file === undefined) return;

      let lease: FilePrefixLease | undefined;
      try {
        lease = await read(file);
        if (!isCurrent()) continue;

        const detectedKind = detect(lease.bytes, file) ?? null;
        if (isCurrent()) results[index] = { file, detectedKind };
      } catch (error) {
        firstFailure ??= error;
        throw error;
      } finally {
        lease?.release();
        completed += 1;
        if (isCurrent()) onProgress({ completed, total: files.length });
      }
    }
  }

  const settlements = await Promise.allSettled(
    Array.from({ length: Math.min(MAX_DETECTION_CONCURRENCY, files.length) }, worker),
  );
  const rejected = settlements.find(
    (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
  );
  if (rejected !== undefined) throw firstFailure ?? rejected.reason;

  return isCurrent() ? Object.freeze(results) : null;
}
