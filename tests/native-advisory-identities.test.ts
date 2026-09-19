import { expect, it } from "vitest";
import { nativeCpe } from "../scripts/native-advisory-identities.mjs";

it.each([
  ["mozjpeg", "4.1.1", "cpe:2.3:a:mozilla:mozjpeg:4.1.1:*:*:*:*:*:*:*"],
  ["libwebp", "1.3.0", "cpe:2.3:a:webmproject:libwebp:1.3.0:*:*:*:*:*:*:*"],
  ["expat", "2.8.4", "cpe:2.3:a:libexpat_project:libexpat:2.8.4:*:*:*:*:*:*:*"],
  ["util-linux", "2.41.6", "cpe:2.3:a:kernel:util-linux:2.41.6:*:*:*:*:*:*:*"],
  ["libvips", "8.18.6", "cpe:2.3:a:libvips:libvips:8.18.6:*:*:*:*:*:*:*"],
  ["qpdf", "12.4.0", "cpe:2.3:a:qpdf_project:qpdf:12.4.0:*:*:*:*:*:*:*"],
])("uses the reviewed advisory identity for %s", (name, version, expected) => {
  expect(nativeCpe(name, version)).toBe(expected);
});

it("does not invent identities for unreviewed sources", () => {
  for (const name of ["oxipng", "quantizr", "unknown", "toString"])
    expect(nativeCpe(name, "1.2.3")).toBeUndefined();
});

it.each(["*", "1.2.3:*", "1.2.3\n", ""])("rejects non-exact CPE version %j", (version) => {
  expect(() => nativeCpe("libwebp", version)).toThrow(/version/i);
});
