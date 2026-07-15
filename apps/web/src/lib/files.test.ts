import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createZipArchive,
  downloadUrl,
  formatDuration,
  formatSavings,
  resolveIfCurrent,
} from "./files";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installDownloadDocument(click: () => void = vi.fn()) {
  const anchor = {
    download: "",
    href: "",
    rel: "",
    click: vi.fn(click),
    remove: vi.fn(),
  };
  const append = vi.fn();
  vi.stubGlobal("document", {
    body: { append },
    createElement: vi.fn(() => anchor),
  });
  return { anchor, append };
}

describe("downloadUrl", () => {
  it("activates one named download and removes its temporary anchor", () => {
    const { anchor, append } = installDownloadDocument();

    downloadUrl("blob:result", "result.pdf");

    expect(anchor).toMatchObject({
      href: "blob:result",
      download: "result.pdf",
      rel: "noopener",
    });
    expect(append).toHaveBeenCalledOnce();
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });

  it("removes the anchor and rethrows when activation fails", () => {
    const failure = new Error("download activation failed");
    const { anchor } = installDownloadDocument(() => {
      throw failure;
    });

    expect(() => downloadUrl("blob:result", "result.pdf")).toThrow(failure);
    expect(anchor.remove).toHaveBeenCalledOnce();
  });
});

describe("createZipArchive", () => {
  it("keeps every duplicate name and strips archive paths", async () => {
    const byte = (value: number) => Uint8Array.of(value).buffer;
    const archive = await createZipArchive([
      { name: "foo.webp", bytes: byte(1) },
      { name: "foo.webp", bytes: byte(2) },
      { name: "foo-2.webp", bytes: byte(3) },
      { name: "../evil.webp", bytes: byte(4) },
    ]);
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      "evil.webp",
      "foo-2-2.webp",
      "foo-2.webp",
      "foo.webp",
    ]);
    expect(
      Object.values(entries)
        .map((bytes) => bytes[0])
        .sort(),
    ).toEqual([1, 2, 3, 4]);
  });
});

describe("resolveIfCurrent", () => {
  it("ignores a pending value after its generation is invalidated", async () => {
    let finishPending: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      finishPending = resolve;
    });
    let currentGeneration = 4;

    const settled = resolveIfCurrent(pending, currentGeneration, () => currentGeneration);
    currentGeneration += 1;
    finishPending?.("stale archive");

    await expect(settled).resolves.toBeUndefined();
  });

  it("returns a pending value for the current generation", async () => {
    await expect(resolveIfCurrent(Promise.resolve("current archive"), 7, () => 7)).resolves.toBe(
      "current archive",
    );
  });
});

describe("result metrics", () => {
  it("formats savings, growth, and processing time", () => {
    expect(formatSavings(1000, 400)).toBe("60% 절약");
    expect(formatSavings(1000, 1100)).toBe("10% 증가");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1250)).toBe("1.3초");
  });
});
