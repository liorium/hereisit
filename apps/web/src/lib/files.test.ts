import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createZipArchive } from "./files";

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
