import { dedupeArchiveNames } from "@hereisit/image-tool";
import type { RemoteArchivePart, RemoteDownloadHandle } from "@hereisit/server-runtime";
import { Zip, ZipPassThrough } from "fflate";

export const REMOTE_ARCHIVE_DESKTOP_MAX_BYTES = 128 * 1024 * 1024;
export const REMOTE_ARCHIVE_CONSTRAINED_MAX_BYTES = 32 * 1024 * 1024;

export function remoteArchiveByteBudget(input: {
  readonly deviceMemoryGiB: number | null;
  readonly coarsePointer: boolean;
}): number {
  return input.coarsePointer || input.deviceMemoryGiB === null || input.deviceMemoryGiB <= 4
    ? REMOTE_ARCHIVE_CONSTRAINED_MAX_BYTES
    : REMOTE_ARCHIVE_DESKTOP_MAX_BYTES;
}

export type ImageArchiveEntry =
  | {
      readonly kind: "remote";
      readonly filename: string;
      readonly handle: RemoteDownloadHandle;
    }
  | {
      readonly kind: "local";
      readonly filename: string;
      readonly blob: Blob;
    };

export async function buildImageArchive(input: {
  readonly entries: readonly ImageArchiveEntry[];
  readonly byteBudget: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly blob: Blob;
  acknowledgeAfterHandoff(): Promise<void>;
  dispose(): void;
}> {
  if (!Number.isSafeInteger(input.byteBudget) || input.byteBudget < 0) {
    throw new RangeError("archive byte budget is invalid");
  }
  const total = input.entries.reduce(
    (sum, entry) =>
      sum + (entry.kind === "remote" ? entry.handle.descriptor.byteLength : entry.blob.size),
    0,
  );
  if (!Number.isSafeInteger(total) || total > input.byteBudget) {
    throw new RangeError("archive byte budget is too small");
  }
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const names = dedupeArchiveNames(input.entries.map((entry) => entry.filename));
  const outputChunks: Uint8Array<ArrayBuffer>[] = [];
  const acknowledgements: Array<() => Promise<void>> = [];
  let consumedBytes = 0;
  let currentPart: RemoteArchivePart | null = null;
  let zipError: Error | null = null;
  let resolveZip: (() => void) | undefined;
  let rejectZip: ((reason: unknown) => void) | undefined;
  const complete = new Promise<void>((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error !== null) {
      zipError = error;
      rejectZip?.(error);
      return;
    }
    outputChunks.push(Uint8Array.from(chunk));
    if (final) resolveZip?.();
  });

  try {
    for (const [index, source] of input.entries.entries()) {
      if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let part: RemoteArchivePart | null = null;
      let byteLength: number;
      let stream: ReadableStream<Uint8Array>;
      if (source.kind === "remote") {
        part = await source.handle.fetchForArchive({
          remainingByteBudget: input.byteBudget - consumedBytes,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        currentPart = part;
        byteLength = part.byteLength;
        stream = part.stream;
      } else {
        byteLength = source.blob.size;
        stream = source.blob.stream();
      }
      const entry = new ZipPassThrough(names[index] ?? `image-${index + 1}`);
      zip.add(entry);
      const reader = stream.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          entry.push(next.value, false);
          if (zipError !== null) throw zipError;
        }
        entry.push(new Uint8Array(), true);
      } finally {
        reader.releaseLock();
      }
      if (part !== null) acknowledgements.push(() => part.acknowledge());
      consumedBytes += byteLength;
      currentPart = null;
    }
    zip.end();
    await complete;
    const blob = new Blob(outputChunks, { type: "application/zip" });
    let acknowledged = false;
    return {
      blob,
      async acknowledgeAfterHandoff() {
        if (acknowledged) return;
        for (const acknowledge of acknowledgements) await acknowledge();
        acknowledged = true;
      },
      dispose() {
        outputChunks.length = 0;
        acknowledgements.length = 0;
      },
    };
  } catch (error) {
    await currentPart?.cancelStream().catch(() => undefined);
    zip.terminate();
    outputChunks.length = 0;
    acknowledgements.length = 0;
    throw error;
  }
}
