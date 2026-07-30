import type { RemoteDownloadHandle } from "@hereisit/server-runtime";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  buildImageArchive,
  REMOTE_ARCHIVE_CONSTRAINED_MAX_BYTES,
  REMOTE_ARCHIVE_DESKTOP_MAX_BYTES,
  remoteArchiveByteBudget,
} from "./remote-image-archive";

function handle(name: string, order: string[]): RemoteDownloadHandle {
  const bytes = new TextEncoder().encode(name);
  return {
    descriptor: {
      kind: "download",
      mime: "image/jpeg",
      byteLength: bytes.byteLength,
      width: 1,
      height: 1,
      engineBuildId: "engine",
      codecBuildId: "codec",
      warnings: [],
      timing: { queueMs: 0, processingMs: 0, totalMs: 0 },
      expiresAt: "2026-07-17T00:00:00.000Z",
    },
    download: vi.fn(),
    fetchForArchive: vi.fn(async () => {
      order.push(`fetch:${name}`);
      let sent = false;
      return {
        byteLength: bytes.byteLength,
        stream: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            sent = true;
            order.push(`chunk:${name}`);
            controller.enqueue(bytes);
          },
        }),
        acknowledge: vi.fn(async () => {
          order.push(`ack:${name}`);
        }),
        cancelStream: vi.fn(async () => {
          order.push(`cancel:${name}`);
        }),
      };
    }),
    dispose: vi.fn(),
  };
}

describe("remote image archive", () => {
  it("selects a conservative mobile/low-memory budget", () => {
    expect(remoteArchiveByteBudget({ deviceMemoryGiB: 4, coarsePointer: false })).toBe(
      REMOTE_ARCHIVE_CONSTRAINED_MAX_BYTES,
    );
    expect(remoteArchiveByteBudget({ deviceMemoryGiB: 16, coarsePointer: true })).toBe(
      REMOTE_ARCHIVE_CONSTRAINED_MAX_BYTES,
    );
    expect(remoteArchiveByteBudget({ deviceMemoryGiB: 16, coarsePointer: false })).toBe(
      REMOTE_ARCHIVE_DESKTOP_MAX_BYTES,
    );
  });

  it("refuses an over-budget archive before fetching", async () => {
    const remote = handle("one", []);
    await expect(
      buildImageArchive({
        entries: [{ kind: "remote", filename: "one.jpg", handle: remote }],
        byteBudget: 1,
      }),
    ).rejects.toThrow("budget");
    expect(remote.fetchForArchive).not.toHaveBeenCalled();
  });

  it("finishes each streamed entry before fetching the next and defers acknowledgement", async () => {
    const order: string[] = [];
    const first = handle("first", order);
    const second = handle("second", order);
    const archive = await buildImageArchive({
      entries: [
        { kind: "remote", filename: "same.jpg", handle: first },
        { kind: "remote", filename: "same.jpg", handle: second },
      ],
      byteBudget: 1_024,
    });
    expect(archive.blob.type).toBe("application/zip");
    expect(order).toEqual(["fetch:first", "chunk:first", "fetch:second", "chunk:second"]);
    await archive.acknowledgeAfterHandoff();
    expect(order.slice(-2)).toEqual(["ack:first", "ack:second"]);
    archive.dispose();
  });

  it("archives local and remote entries together and acknowledges only the remote result", async () => {
    const order: string[] = [];
    const remote = handle("remote", order);
    const archive = await buildImageArchive({
      entries: [
        { kind: "local", filename: "local.txt", blob: new Blob(["local"]) },
        { kind: "remote", filename: "remote.txt", handle: remote },
      ],
      byteBudget: 1_024,
    });
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    expect(new TextDecoder().decode(files["local.txt"])).toBe("local");
    expect(new TextDecoder().decode(files["remote.txt"])).toBe("remote");
    await archive.acknowledgeAfterHandoff();
    expect(order).toContain("ack:remote");
    archive.dispose();
  });
});
