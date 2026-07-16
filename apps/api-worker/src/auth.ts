const textEncoder = new TextEncoder();
const TOKEN_BYTES = 32;
const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IPV4_PREFIX_BYTES = 3;
const IPV6_PREFIX_BYTES = 7;
const NETWORK_HMAC_DOMAIN = textEncoder.encode("hereisit.network-bucket.v1");

export interface TimingSafeEqualDependency {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

export interface VerifyJobTokenInput {
  token: string;
  loadExpectedHash: () => Promise<string | null>;
  recordResult: (result: { matched: boolean }) => void;
  comparator?: TimingSafeEqualDependency;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url32(value: string, label: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an unpadded 32-byte base64url value.`);
  }
  let binary: string;
  try {
    binary = atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`);
  } catch {
    throw new TypeError(`${label} must be an unpadded 32-byte base64url value.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== TOKEN_BYTES || bytesToBase64Url(bytes) !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} must be an unpadded 32-byte base64url value.`);
  }
  return bytes;
}

function hexToFixedBytes(value: string): { bytes: Uint8Array; valid: boolean } {
  const bytes = new Uint8Array(TOKEN_BYTES);
  if (!HASH_HEX_PATTERN.test(value)) {
    return { bytes, valid: false };
  }
  for (let index = 0; index < TOKEN_BYTES; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    bytes[index] = Number.parseInt(pair, 16);
  }
  return { bytes, valid: true };
}

function fixedLengthByteLoop(left: ArrayBufferView, right: ArrayBufferView): boolean {
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function timingSafeEqual(
  left: Uint8Array,
  right: Uint8Array,
  dependency?: TimingSafeEqualDependency,
): boolean {
  if (dependency !== undefined) {
    return dependency.timingSafeEqual(left, right);
  }
  const subtleWithOptionalComparator: SubtleCrypto & {
    timingSafeEqual?: TimingSafeEqualDependency["timingSafeEqual"];
  } = crypto.subtle;
  if (typeof subtleWithOptionalComparator.timingSafeEqual === "function") {
    return subtleWithOptionalComparator.timingSafeEqual(left, right);
  }
  return fixedLengthByteLoop(left, right);
}

async function digestBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const input = Uint8Array.from(bytes);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  } finally {
    input.fill(0);
  }
}

export async function hashAnonymousSessionId(sessionId: string): Promise<string> {
  const digest = await digestBytes(textEncoder.encode(sessionId));
  return bytesToHex(digest);
}

export async function hashJobToken(token: string): Promise<string> {
  const decoded = decodeBase64Url32(token, "Job token");
  try {
    return bytesToHex(await digestBytes(decoded));
  } finally {
    decoded.fill(0);
  }
}

export async function jobTokenMatches(
  token: string,
  expectedHash: string,
  comparator?: TimingSafeEqualDependency,
): Promise<boolean> {
  const actualHash = await hashJobToken(token);
  const actual = hexToFixedBytes(actualHash);
  const expected = hexToFixedBytes(expectedHash);
  try {
    const equal = timingSafeEqual(actual.bytes, expected.bytes, comparator);
    return expected.valid && equal;
  } finally {
    actual.bytes.fill(0);
    expected.bytes.fill(0);
  }
}

export async function verifyJobToken(input: VerifyJobTokenInput): Promise<boolean> {
  const actualHash = await hashJobToken(input.token);
  const expectedHash = await input.loadExpectedHash();
  const actual = hexToFixedBytes(actualHash);
  const expected = hexToFixedBytes(expectedHash ?? "");
  let matched = false;
  try {
    matched =
      expectedHash !== null &&
      expected.valid &&
      timingSafeEqual(actual.bytes, expected.bytes, input.comparator);
  } finally {
    actual.bytes.fill(0);
    expected.bytes.fill(0);
  }
  input.recordResult({ matched });
  return matched;
}

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const values: number[] = [];
  for (const part of parts) {
    if (part === undefined || !/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    values.push(value);
  }
  return Uint8Array.from(values);
}

function parseIpv6(ip: string): Uint8Array | null {
  if (ip.includes(".") || ip.includes("%") || ip.split("::").length > 2) {
    return null;
  }
  const hasCompression = ip.includes("::");
  const [leftText = "", rightText = ""] = ip.split("::");
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  if (
    left.some((part) => !/^[0-9A-Fa-f]{1,4}$/.test(part)) ||
    right.some((part) => !/^[0-9A-Fa-f]{1,4}$/.test(part))
  ) {
    return null;
  }
  const explicitGroups = left.length + right.length;
  if ((hasCompression && explicitGroups >= 8) || (!hasCompression && explicitGroups !== 8)) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: 8 - explicitGroups }, () => "0"), ...right];
  if (groups.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index] ?? "0", 16);
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function parseUtcDay(utcDay: string): Date {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(utcDay)) {
    throw new TypeError("UTC day must use YYYY-MM-DD.");
  }
  const date = new Date(`${utcDay}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== utcDay) {
    throw new TypeError("UTC day must be a real calendar day.");
  }
  return date;
}

function previousUtcDay(utcDay: string): string {
  const date = parseUtcDay(utcDay);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function createNetworkPreimage(family: 4 | 6, prefix: Uint8Array, utcDay: string): Uint8Array {
  const dayBytes = textEncoder.encode(utcDay);
  const preimage = new Uint8Array(
    NETWORK_HMAC_DOMAIN.byteLength + 1 + 1 + prefix.byteLength + dayBytes.byteLength,
  );
  let offset = 0;
  preimage.set(NETWORK_HMAC_DOMAIN, offset);
  offset += NETWORK_HMAC_DOMAIN.byteLength;
  preimage[offset] = family;
  offset += 1;
  preimage[offset] = family === 4 ? 24 : 56;
  offset += 1;
  preimage.set(prefix, offset);
  offset += prefix.byteLength;
  preimage.set(dayBytes, offset);
  return preimage;
}

async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  const input = Uint8Array.from(secret);
  try {
    return await crypto.subtle.importKey(
      "raw",
      input.buffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } finally {
    input.fill(0);
  }
}

async function hmacHex(key: CryptoKey, preimage: Uint8Array): Promise<string> {
  const input = Uint8Array.from(preimage);
  try {
    return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, input.buffer)));
  } finally {
    input.fill(0);
  }
}

function deduplicate(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export async function hashNetworkBuckets(input: {
  ip: string;
  utcDay: string;
  currentSecret: string;
  previousSecret: string;
}): Promise<{
  writeHash: string;
  dailyQuotaHashes: readonly string[];
  pendingHashes: readonly string[];
}> {
  const currentSecretBytes = decodeBase64Url32(input.currentSecret, "Current abuse HMAC secret");
  let previousSecretBytes: Uint8Array | null = null;
  let parsedAddress: Uint8Array | null = null;
  let prefix: Uint8Array | null = null;
  let todayPreimage: Uint8Array | null = null;
  let yesterdayPreimage: Uint8Array | null = null;
  try {
    previousSecretBytes = decodeBase64Url32(input.previousSecret, "Previous abuse HMAC secret");
    const ipv4 = parseIpv4(input.ip);
    parsedAddress = ipv4 ?? parseIpv6(input.ip);
    if (parsedAddress === null) {
      throw new TypeError("Network address must be canonicalizable IPv4 or IPv6.");
    }
    const family = ipv4 === null ? 6 : 4;
    prefix = parsedAddress.slice(0, family === 4 ? IPV4_PREFIX_BYTES : IPV6_PREFIX_BYTES);
    todayPreimage = createNetworkPreimage(family, prefix, input.utcDay);
    yesterdayPreimage = createNetworkPreimage(family, prefix, previousUtcDay(input.utcDay));
    const [currentKey, previousKey] = await Promise.all([
      importHmacKey(currentSecretBytes),
      importHmacKey(previousSecretBytes),
    ]);
    const [currentToday, previousToday, currentYesterday, previousYesterday] = await Promise.all([
      hmacHex(currentKey, todayPreimage),
      hmacHex(previousKey, todayPreimage),
      hmacHex(currentKey, yesterdayPreimage),
      hmacHex(previousKey, yesterdayPreimage),
    ]);
    const dailyQuotaHashes = deduplicate([currentToday, previousToday]);
    return {
      writeHash: currentToday,
      dailyQuotaHashes,
      pendingHashes: deduplicate([...dailyQuotaHashes, currentYesterday, previousYesterday]),
    };
  } finally {
    currentSecretBytes.fill(0);
    previousSecretBytes?.fill(0);
    parsedAddress?.fill(0);
    prefix?.fill(0);
    todayPreimage?.fill(0);
    yesterdayPreimage?.fill(0);
  }
}

export async function sessionRolloutBucket(sessionId: string): Promise<number> {
  const digest = await digestBytes(textEncoder.encode(sessionId));
  const value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0);
  return value % 100;
}
