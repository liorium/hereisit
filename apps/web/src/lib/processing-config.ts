export interface ProcessingClientConfig {
  readonly apiOrigin: string | null;
}

const SESSION_STORAGE_KEY = "hereisit.processing-session.v1";
const IMAGE_COMPRESSION_LOCATION_STORAGE_KEY = "hereisit.image-compression-location.v1";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let memorySessionId: string | null = null;

export type ImageCompressionLocation = "server" | "local";

function normalizePublicOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("processing API origin is invalid");
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("processing API origin is invalid");
  }
  return url.origin;
}

export function readProcessingClientConfig(): ProcessingClientConfig {
  return {
    apiOrigin: normalizePublicOrigin(process.env.NEXT_PUBLIC_PROCESSING_API_ORIGIN),
  };
}

function newSessionId(): string {
  const value = crypto.randomUUID();
  if (!UUID_V4_PATTERN.test(value)) throw new TypeError("secure session UUID is unavailable");
  return value;
}

export function getOrCreateAnonymousSessionId(storage?: Storage): string {
  let target = storage;
  if (target === undefined) {
    try {
      target = globalThis.localStorage;
    } catch {
      target = undefined;
    }
  }
  if (target !== undefined) {
    try {
      const existing = target.getItem(SESSION_STORAGE_KEY);
      if (existing !== null && UUID_V4_PATTERN.test(existing)) return existing;
      const created = newSessionId();
      target.setItem(SESSION_STORAGE_KEY, created);
      return created;
    } catch {
      // Privacy modes may deny localStorage; one in-memory ID remains sufficient.
    }
  }
  memorySessionId ??= newSessionId();
  return memorySessionId;
}

export function isUnprovenInAppBrowser(userAgent?: string): boolean {
  const value = userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  if (/\bwv\b|; wv\)|WebView|FBAN|FBAV|Instagram|KAKAOTALK|NAVER\(inapp|Line\//i.test(value)) {
    return true;
  }
  if (!/iPhone|iPad|iPod/i.test(value)) return false;
  return !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/i.test(value);
}

export function readImageCompressionLocation(
  storage: Storage = globalThis.localStorage,
): ImageCompressionLocation {
  try {
    return storage.getItem(IMAGE_COMPRESSION_LOCATION_STORAGE_KEY) === "local" ? "local" : "server";
  } catch {
    return "server";
  }
}

export function writeImageCompressionLocation(
  value: ImageCompressionLocation,
  storage: Storage = globalThis.localStorage,
): void {
  try {
    storage.setItem(IMAGE_COMPRESSION_LOCATION_STORAGE_KEY, value);
  } catch {
    // Privacy modes may deny localStorage; the current React state still applies.
  }
}
