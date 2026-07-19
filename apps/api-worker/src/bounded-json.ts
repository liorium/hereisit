const DEFAULT_MAXIMUM_BYTES = 16_384;

function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("Content-Length must be a canonical non-negative integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError("Content-Length must be a safe integer.");
  }
  return parsed;
}

function validateHeaders(request: Request, maximumBytes: number): number | null {
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
    throw new TypeError("Content-Encoding must be identity.");
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new TypeError("Content-Type must be application/json.");
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > maximumBytes) {
    throw new RangeError("JSON body is too large.");
  }
  return contentLength;
}

export async function readBoundedJson(
  request: Request,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("Maximum JSON body bytes must be a positive safe integer.");
  }
  const declaredLength = validateHeaders(request, maximumBytes);
  if (request.body === null) {
    throw new TypeError("JSON request body is required.");
  }

  const reader = request.body.getReader();
  const buffer = new Uint8Array(maximumBytes);
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (byteLength + value.byteLength > maximumBytes) {
      await reader.cancel("JSON body is too large.");
      throw new RangeError("JSON body is too large.");
    }
    buffer.set(value, byteLength);
    byteLength += value.byteLength;
  }

  if (declaredLength !== null && declaredLength !== byteLength) {
    throw new TypeError("Content-Length does not match the streamed body.");
  }

  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, byteLength));
  } catch {
    throw new TypeError("JSON body must contain valid UTF-8.");
  } finally {
    buffer.fill(0);
  }

  try {
    return JSON.parse(serialized);
  } catch {
    throw new TypeError("JSON body must contain valid JSON.");
  }
}
