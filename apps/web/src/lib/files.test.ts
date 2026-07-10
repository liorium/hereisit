import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createZipArchive, formatDuration, formatSavings, isAbortError } from "./files";

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

describe("result metrics", () => {
  it("formats savings, growth, and processing time", () => {
    expect(formatSavings(1000, 400)).toBe("60% 절약");
    expect(formatSavings(1000, 1100)).toBe("10% 증가");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1250)).toBe("1.3초");
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
