import { describe, expect, it } from "vitest";

describe("Node runtime baseline", () => {
  it("provides the primitives used by shared pipeline code", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
    expect(globalThis.structuredClone).toBeTypeOf("function");
    expect(globalThis.ReadableStream).toBeTypeOf("function");
    expect(globalThis.TransformStream).toBeTypeOf("function");
  });
});
