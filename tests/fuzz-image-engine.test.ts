import { describe, expect, it } from "vitest";
import {
  classifyFuzzTerminalStatus,
  createImageMutation,
  normalizeFuzzCaseId,
  selectFuzzSources,
} from "../scripts/fuzz-image-engine.mjs";

const source = Uint8Array.from({ length: 96 }, (_, index) => index);

describe("image engine fuzz harness", () => {
  it("creates deterministic bounded mutations without retaining the input reference", () => {
    const first = createImageMutation({
      bytes: source,
      format: "png",
      caseNumber: 17,
      seed: 20260716,
    });
    const second = createImageMutation({
      bytes: source,
      format: "png",
      caseNumber: 17,
      seed: 20260716,
    });

    expect(first).toEqual(second);
    expect(first.bytes).not.toBe(source);
    expect(first.bytes.byteLength).toBeLessThanOrEqual(source.byteLength);
    expect(first.bytes).not.toEqual(source);
    expect(first.id).toMatch(/^case-[0-9a-f]{16}$/);
  });

  it.each(["jpeg", "png", "webp"] as const)("covers every %s mutation family", (format) => {
    const mutations = new Set(
      Array.from(
        { length: 12 },
        (_, caseNumber) =>
          createImageMutation({ bytes: source, format, caseNumber, seed: 1 }).mutation,
      ),
    );

    expect(mutations).toEqual(
      new Set(["magic", "truncate", "length", "dimension", "metadata", "byte-flip"]),
    );
  });

  it("accepts only classified terminal outcomes", () => {
    expect(classifyFuzzTerminalStatus({ state: "succeeded" })).toBe("succeeded");
    expect(
      classifyFuzzTerminalStatus({
        state: "failed",
        error: { code: "UNSUPPORTED_INPUT" },
      }),
    ).toBe("rejected:UNSUPPORTED_INPUT");
    expect(() =>
      classifyFuzzTerminalStatus({ state: "failed", error: { code: "ENGINE_CRASH" } }),
    ).toThrow(/unsafe engine outcome/);
    expect(() => classifyFuzzTerminalStatus({ state: "running" })).toThrow(/not terminal/);
  });

  it("normalizes case identifiers before they can reach output", () => {
    expect(normalizeFuzzCaseId("case-0123456789abcdef")).toBe("case-0123456789abcdef");
    expect(() => normalizeFuzzCaseId("private-file.png")).toThrow(/case ID/);
  });

  it("selects bounded sources from the manifest without requiring an unrecorded byte field", () => {
    const entries = (["jpeg", "png", "webp"] as const).map((format) => ({
      id: `source-${format}`,
      relativePath: `public/source.${format}`,
      expected: { format, class: "photo", width: 640, height: 480 },
    }));

    expect(selectFuzzSources(entries)).toHaveLength(3);
    expect(
      selectFuzzSources([
        ...entries,
        {
          id: "too-large",
          relativePath: "public/large.png",
          expected: { format: "png", class: "photo", width: 4096, height: 4096 },
        },
      ]).map((entry) => entry.id),
    ).not.toContain("too-large");
  });
});
