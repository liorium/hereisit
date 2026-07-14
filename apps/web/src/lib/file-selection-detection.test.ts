import type { FileKind } from "@hereisit/tool-registry/catalog";
import { describe, expect, it, vi } from "vitest";
import {
  detectFileSelection,
  type FilePrefixLease,
  LauncherFileLimitError,
  MAX_DETECTION_CONCURRENCY,
  readFilePrefix,
} from "./file-selection-detection";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return {
    promise,
    resolve(value) {
      if (resolve === undefined) throw new Error("Deferred promise is not initialized");
      resolve(value);
    },
  };
}

function testFiles(count: number): File[] {
  return Array.from(
    { length: count },
    (_, index) => new File([Uint8Array.of(index)], `fixture-${index}.bin`),
  );
}

function trackedLease(bytes: Uint8Array, releaseCounts: number[], index: number): FilePrefixLease {
  return {
    bytes,
    release() {
      releaseCounts[index] = (releaseCounts[index] ?? 0) + 1;
    },
  };
}

describe("detectFileSelection", () => {
  it("limits prefix reads to two while preserving result order and releasing every lease", async () => {
    const files = testFiles(3);
    const prefixes = [
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      new TextEncoder().encode("%PDF-1.7"),
      new TextEncoder().encode("unknown"),
    ];
    const reads = files.map(() => deferred<FilePrefixLease>());
    const releaseCounts = [0, 0, 0];
    const progress: Array<{ completed: number; total: number }> = [];
    let concurrentReads = 0;
    let maximumConcurrentReads = 0;
    const readPrefix = vi.fn(async (file: File) => {
      const index = files.indexOf(file);
      const read = reads[index];
      if (read === undefined) throw new Error("Unexpected file");
      concurrentReads += 1;
      maximumConcurrentReads = Math.max(maximumConcurrentReads, concurrentReads);
      try {
        return await read.promise;
      } finally {
        concurrentReads -= 1;
      }
    });

    const resultPromise = detectFileSelection(files, {
      isCurrent: () => true,
      onProgress: (value) => progress.push(value),
      readPrefix,
    });

    expect(progress).toEqual([{ completed: 0, total: 3 }]);
    expect(readPrefix).toHaveBeenCalledTimes(MAX_DETECTION_CONCURRENCY);

    reads[0]?.resolve(trackedLease(prefixes[0] ?? new Uint8Array(), releaseCounts, 0));
    await vi.waitFor(() => expect(readPrefix).toHaveBeenCalledTimes(3));
    reads[1]?.resolve(trackedLease(prefixes[1] ?? new Uint8Array(), releaseCounts, 1));
    reads[2]?.resolve(trackedLease(prefixes[2] ?? new Uint8Array(), releaseCounts, 2));

    const results = await resultPromise;

    expect(maximumConcurrentReads).toBeLessThanOrEqual(2);
    expect(releaseCounts).toEqual([1, 1, 1]);
    expect(results?.map(({ detectedKind }) => detectedKind)).toEqual([
      "image/png",
      "application/pdf",
      null,
    ]);
  });

  it("rejects 101 files before reading a prefix", async () => {
    const readPrefix = vi.fn();
    const onProgress = vi.fn();

    const promise = detectFileSelection(testFiles(101), {
      isCurrent: () => true,
      onProgress,
      readPrefix,
    });

    await expect(promise).rejects.toMatchObject({
      maximum: 100,
    });
    await expect(promise).rejects.toBeInstanceOf(LauncherFileLimitError);
    expect(readPrefix).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("stops scheduling when the generation becomes stale and releases acquired leases", async () => {
    const files = testFiles(4);
    const reads = files.map(() => deferred<FilePrefixLease>());
    const releaseCounts = [0, 0, 0, 0];
    const progress: Array<{ completed: number; total: number }> = [];
    let current = true;
    const detect = vi.fn<(_prefix: Uint8Array, _file: File) => FileKind | undefined>();
    const readPrefix = vi.fn((file: File) => {
      const read = reads[files.indexOf(file)];
      if (read === undefined) return Promise.reject(new Error("Unexpected file"));
      return read.promise;
    });
    const resultPromise = detectFileSelection(files, {
      isCurrent: () => current,
      onProgress: (value) => progress.push(value),
      readPrefix,
      detect,
    });

    expect(readPrefix).toHaveBeenCalledTimes(2);
    current = false;
    reads[0]?.resolve(trackedLease(Uint8Array.of(1), releaseCounts, 0));
    reads[1]?.resolve(trackedLease(Uint8Array.of(2), releaseCounts, 1));

    await expect(resultPromise).resolves.toBeNull();
    expect(readPrefix).toHaveBeenCalledTimes(2);
    expect(detect).not.toHaveBeenCalled();
    expect(releaseCounts).toEqual([1, 1, 0, 0]);
    expect(progress).toEqual([{ completed: 0, total: 4 }]);
  });

  it("releases every acquired lease before rejecting a detector exception", async () => {
    const files = testFiles(3);
    const reads = files.map(() => deferred<FilePrefixLease>());
    const releaseCounts = [0, 0, 0];
    const failure = new Error("detection failed");
    const readPrefix = vi.fn((file: File) => {
      const read = reads[files.indexOf(file)];
      if (read === undefined) return Promise.reject(new Error("Unexpected file"));
      return read.promise;
    });
    const resultPromise = detectFileSelection(files, {
      isCurrent: () => true,
      onProgress: vi.fn(),
      readPrefix,
      detect: () => {
        throw failure;
      },
    });

    expect(readPrefix).toHaveBeenCalledTimes(2);
    reads[0]?.resolve(trackedLease(Uint8Array.of(1), releaseCounts, 0));
    reads[1]?.resolve(trackedLease(Uint8Array.of(2), releaseCounts, 1));

    await expect(resultPromise).rejects.toBe(failure);
    expect(readPrefix).toHaveBeenCalledTimes(2);
    expect(releaseCounts).toEqual([1, 1, 0]);
  });

  it("increments progress exactly once after each completed prefix", async () => {
    const files = testFiles(3);
    const releaseCounts = [0, 0, 0];
    const progress: Array<{ completed: number; total: number }> = [];

    await detectFileSelection(files, {
      isCurrent: () => true,
      onProgress(value) {
        progress.push(value);
        expect(releaseCounts.reduce((sum, count) => sum + count, 0)).toBe(value.completed);
      },
      readPrefix: async (file) => {
        const index = files.indexOf(file);
        return trackedLease(Uint8Array.of(index), releaseCounts, index);
      },
      detect: () => undefined,
    });

    expect(progress).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  it("reports zero progress and returns an empty result for an empty selection", async () => {
    const progress: Array<{ completed: number; total: number }> = [];
    const readPrefix = vi.fn();

    const result = await detectFileSelection([], {
      isCurrent: () => true,
      onProgress: (value) => progress.push(value),
      readPrefix,
    });

    expect(result).toEqual([]);
    expect(progress).toEqual([{ completed: 0, total: 0 }]);
    expect(readPrefix).not.toHaveBeenCalled();
  });
});

describe("readFilePrefix", () => {
  it("reads only the first 65,536 bytes and empties the lease on release", async () => {
    const prefix = Uint8Array.of(1, 2, 3);
    const arrayBuffer = vi.fn(async () => prefix.buffer);
    const slice = vi.fn(() => ({ arrayBuffer }));
    const file = { slice } as unknown as File;

    const lease = await readFilePrefix(file);

    expect(slice).toHaveBeenCalledWith(0, 65_536);
    expect(lease.bytes).toEqual(prefix);
    lease.release();
    expect(lease.bytes).toEqual(new Uint8Array());
  });
});
