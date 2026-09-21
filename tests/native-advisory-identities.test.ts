import { expect, it } from "vitest";
import { nativeCpe } from "../scripts/native-advisory-identities.mjs";

it("does not invent identities for unreviewed sources", () => {
  for (const name of ["oxipng", "quantizr", "unknown", "toString"])
    expect(nativeCpe(name, "1.2.3")).toBeUndefined();
});
it.each(["*", "1.2.3:*", "1.2.3\n", ""])("rejects non-exact CPE version %j", (version) => {
  expect(() => nativeCpe("libwebp", version)).toThrow(/version/i);
});
