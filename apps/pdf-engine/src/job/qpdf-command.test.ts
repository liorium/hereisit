import { describe, expect, it } from "vitest";
import { qpdfArgs } from "./qpdf-command";

describe("fixed qpdf candidate commands", () => {
  it("builds the structural candidate without lossy image options", () => {
    expect(qpdfArgs("structural", "/job/input.bin", "/job/candidate.pdf")).toEqual([
      "--object-streams=generate",
      "--compress-streams=y",
      "--decode-level=generalized",
      "--recompress-flate",
      "--compression-level=9",
      "--remove-unreferenced-resources=yes",
      "--",
      "/job/input.bin",
      "/job/candidate.pdf",
    ]);
  });

  it.each([
    ["balanced", "82"],
    ["minimum", "65"],
  ] as const)("pins the %s image quality", (preset, quality) => {
    expect(qpdfArgs(preset, "/job/input.bin", "/job/candidate.pdf")).toEqual([
      "--object-streams=generate",
      "--compress-streams=y",
      "--decode-level=generalized",
      "--recompress-flate",
      "--compression-level=9",
      "--remove-unreferenced-resources=yes",
      "--optimize-images",
      `--jpeg-quality=${quality}`,
      "--",
      "/job/input.bin",
      "/job/candidate.pdf",
    ]);
  });

  it.each([
    ["-unsafe", "/job/out.pdf"],
    ["relative.pdf", "/job/out.pdf"],
    ["/job/../input.pdf", "/job/out.pdf"],
    ["/job/input\0.pdf", "/job/out.pdf"],
    ["/job/input.pdf", "--output"],
  ])("rejects hostile paths", (source, output) => {
    expect(() => qpdfArgs("balanced", source, output)).toThrow();
  });

  it("rejects unknown presets", () => {
    expect(() => qpdfArgs("unknown" as never, "/job/input.pdf", "/job/out.pdf")).toThrow();
  });
});
