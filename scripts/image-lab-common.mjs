import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value) {
  return sha256Bytes(canonicalJson(value));
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

export function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function assertPositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

export function decimalUsdToMicrousd(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be an unsigned canonical decimal string`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    throw new RangeError(`${label} loses precision when converted to microusd`);
  }
  const micros = BigInt(whole) * 1_000_000n + BigInt(`${fraction.slice(0, 6)}000000`.slice(0, 6));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`${label} exceeds safe integer range`);
  return Number(micros);
}

export async function writeCanonicalJsonAtomic(path, value, { refuseOverwrite = false } = {}) {
  const bytes = canonicalJson(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { encoding: "utf8", flag: refuseOverwrite ? "wx" : "w" });
  try {
    if (refuseOverwrite) {
      await writeFile(path, bytes, { encoding: "utf8", flag: "wx" });
      await import("node:fs/promises").then(({ unlink }) => unlink(temporary));
    } else {
      await rename(temporary, path);
    }
  } catch (error) {
    await import("node:fs/promises").then(({ unlink }) => unlink(temporary).catch(() => undefined));
    throw error;
  }
  return sha256Bytes(bytes);
}

export function parseCliArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || value === undefined) {
      throw new TypeError("CLI arguments must be --name value pairs");
    }
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new TypeError(`duplicate CLI argument --${name}`);
    result[name] = value;
  }
  return result;
}
