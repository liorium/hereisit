import { describe, expect, it } from "vitest";
import { JSON_FORMAT_LIMITS, transformJsonText } from "./json-format";

describe("transformJsonText", () => {
  it("pretty-prints structure while preserving every value token", () => {
    const source =
      '{"big":9007199254740993,"decimal":1.2300,"exponent":1e+09,"escaped":"\\u0061","dup":1,"dup":2,"nested":[true,null]}';

    expect(transformJsonText(source, "pretty")).toEqual({
      ok: true,
      output:
        '{\n  "big": 9007199254740993,\n  "decimal": 1.2300,\n  "exponent": 1e+09,\n  "escaped": "\\u0061",\n  "dup": 1,\n  "dup": 2,\n  "nested": [\n    true,\n    null\n  ]\n}',
    });
  });

  it("minifies only JSON whitespace outside strings", () => {
    expect(transformJsonText(' { "text" : "a b, { c }" , "array" : [ 1, 2 ] } ', "minify")).toEqual(
      { ok: true, output: '{"text":"a b, { c }","array":[1,2]}' },
    );
  });

  it.each([
    ["", "EMPTY_INPUT"],
    [" \t\r\n", "EMPTY_INPUT"],
    ["\u00a0", "INVALID_JSON"],
    ["{", "INVALID_JSON"],
    [`${"[".repeat(101)}0${"]".repeat(101)}`, "NESTING_TOO_DEEP"],
  ] as const)("rejects bounded invalid input %#", (source, code) => {
    expect(transformJsonText(source, "pretty")).toEqual({ ok: false, code });
  });

  it("enforces the exact UTF-8 input ceiling", () => {
    const exact = `"${"a".repeat(JSON_FORMAT_LIMITS.maxInputBytes - 2)}"`;

    expect(transformJsonText(exact, "minify").ok).toBe(true);
    expect(transformJsonText(`${exact} `, "minify")).toEqual({
      ok: false,
      code: "INPUT_TOO_LARGE",
    });
  });

  it("counts non-ASCII input bytes instead of UTF-16 code units", () => {
    const source = `"${"한".repeat(Math.floor(JSON_FORMAT_LIMITS.maxInputBytes / 3))}"`;

    expect(transformJsonText(source, "minify")).toEqual({
      ok: false,
      code: "INPUT_TOO_LARGE",
    });
  });

  it("stops pretty output before the four MiB ceiling", () => {
    const source = `${"[".repeat(100)}${Array.from({ length: 45_000 }, () => "0").join(",")}${"]".repeat(100)}`;

    expect(transformJsonText(source, "pretty")).toEqual({
      ok: false,
      code: "OUTPUT_TOO_LARGE",
    });
  });
});
