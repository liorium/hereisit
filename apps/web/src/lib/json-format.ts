export const JSON_FORMAT_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxDepth: 100,
  maxOutputBytes: 4 * 1024 * 1024,
});

export type JsonFormatMode = "pretty" | "minify";
export type JsonFormatErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "INVALID_JSON"
  | "NESTING_TOO_DEEP"
  | "OUTPUT_TOO_LARGE";
export type JsonFormatResult =
  | { ok: true; output: string }
  | { ok: false; code: JsonFormatErrorCode };

const encoder = new TextEncoder();

function isJsonWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function isJsonWhitespaceOnly(source: string): boolean {
  for (const character of source) {
    if (!isJsonWhitespace(character)) return false;
  }
  return true;
}

function compactJson(source: string): JsonFormatResult {
  const chunks: string[] = [];
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) continue;

    if (inString) {
      chunks.push(character);
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      chunks.push(character);
      continue;
    }
    if (isJsonWhitespace(character)) continue;
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > JSON_FORMAT_LIMITS.maxDepth) {
        return { ok: false, code: "NESTING_TOO_DEEP" };
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
    chunks.push(character);
  }

  return { ok: true, output: chunks.join("") };
}

function prettyJson(compact: string): JsonFormatResult {
  const chunks: string[] = [];
  let outputLength = 0;
  let depth = 0;
  let escaped = false;
  let inString = false;

  function append(value: string): boolean {
    outputLength += value.length;
    if (outputLength > JSON_FORMAT_LIMITS.maxOutputBytes) return false;
    chunks.push(value);
    return true;
  }

  function appendLine(indentDepth: number): boolean {
    return append(`\n${"  ".repeat(indentDepth)}`);
  }

  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index];
    if (character === undefined) continue;

    if (inString) {
      if (!append(character)) return { ok: false, code: "OUTPUT_TOO_LARGE" };
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      if (!append(character)) return { ok: false, code: "OUTPUT_TOO_LARGE" };
      continue;
    }

    if (character === "{" || character === "[") {
      if (!append(character)) return { ok: false, code: "OUTPUT_TOO_LARGE" };
      depth += 1;
      const close = character === "{" ? "}" : "]";
      if (compact[index + 1] !== close && !appendLine(depth)) {
        return { ok: false, code: "OUTPUT_TOO_LARGE" };
      }
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;
      const open = character === "}" ? "{" : "[";
      if (compact[index - 1] !== open && !appendLine(depth)) {
        return { ok: false, code: "OUTPUT_TOO_LARGE" };
      }
      if (!append(character)) return { ok: false, code: "OUTPUT_TOO_LARGE" };
      continue;
    }

    if (character === ",") {
      if (!append(character) || !appendLine(depth)) {
        return { ok: false, code: "OUTPUT_TOO_LARGE" };
      }
      continue;
    }

    if (character === ":") {
      if (!append(": ")) return { ok: false, code: "OUTPUT_TOO_LARGE" };
      continue;
    }

    if (!append(character)) return { ok: false, code: "OUTPUT_TOO_LARGE" };
  }

  const output = chunks.join("");
  if (encoder.encode(output).byteLength > JSON_FORMAT_LIMITS.maxOutputBytes) {
    return { ok: false, code: "OUTPUT_TOO_LARGE" };
  }
  return { ok: true, output };
}

export function transformJsonText(source: string, mode: JsonFormatMode): JsonFormatResult {
  if (
    source.length > JSON_FORMAT_LIMITS.maxInputBytes ||
    encoder.encode(source).byteLength > JSON_FORMAT_LIMITS.maxInputBytes
  ) {
    return { ok: false, code: "INPUT_TOO_LARGE" };
  }
  if (isJsonWhitespaceOnly(source)) return { ok: false, code: "EMPTY_INPUT" };

  try {
    JSON.parse(source);
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }

  const compact = compactJson(source);
  if (!compact.ok || mode === "minify") return compact;
  return prettyJson(compact.output);
}
