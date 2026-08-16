import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOrCreateAnonymousSessionId,
  isUnprovenInAppBrowser,
  readImageCompressionLocation,
  readPdfCompressionLocation,
  readProcessingClientConfig,
  writeImageCompressionLocation,
  writePdfCompressionLocation,
} from "./processing-config";

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("processing client configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to local execution when the public origin is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "");
    expect(readProcessingClientConfig()).toEqual({ apiOrigin: null });
  });

  it("uses the official API when an official production build omits the public origin", () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "");
    expect(readProcessingClientConfig("https://hereisit.app")).toEqual({
      apiOrigin: "https://api.hereisit.app",
    });
    expect(readProcessingClientConfig("https://hereisit.pages.dev")).toEqual({
      apiOrigin: "https://api.hereisit.app",
    });
    expect(readProcessingClientConfig("https://preview.example")).toEqual({ apiOrigin: null });
  });

  it("accepts an exact HTTPS origin and rejects paths or credentials", () => {
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "https://processing.example");
    expect(readProcessingClientConfig()).toEqual({ apiOrigin: "https://processing.example" });
    vi.stubEnv("NEXT_PUBLIC_PROCESSING_API_ORIGIN", "https://user@processing.example/v1");
    expect(() => readProcessingClientConfig()).toThrow("origin");
  });

  it("stores only one random v4 session ID", () => {
    const storage = new FakeStorage();
    const first = getOrCreateAnonymousSessionId(storage);
    expect(getOrCreateAnonymousSessionId(storage)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(storage.values).toEqual(new Map([["hereisit.processing-session.v1", first]]));
  });

  it("falls back to one module ID when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(getOrCreateAnonymousSessionId(broken)).toBe(getOrCreateAnonymousSessionId(broken));
  });
});

describe("download handoff capability", () => {
  it("recognizes common embedded webviews without misclassifying full mobile browsers", () => {
    expect(
      isUnprovenInAppBrowser(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 Version/4.0 Chrome/126 Mobile Safari/537.36",
      ),
    ).toBe(true);
    expect(
      isUnprovenInAppBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 KAKAOTALK 11.0",
      ),
    ).toBe(true);
    expect(
      isUnprovenInAppBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
    expect(
      isUnprovenInAppBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
  });
});

describe("image compression location", () => {
  it("defaults malformed or missing preferences to the server", () => {
    const storage = new FakeStorage();
    expect(readImageCompressionLocation(storage)).toBe("server");
    storage.setItem("hereisit.image-compression-location.v1", "remote");
    expect(readImageCompressionLocation(storage)).toBe("server");
  });

  it("persists an explicit local choice", () => {
    const storage = new FakeStorage();
    writeImageCompressionLocation("local", storage);
    expect(storage.getItem("hereisit.image-compression-location.v1")).toBe("local");
    expect(readImageCompressionLocation(storage)).toBe("local");
  });

  it("fails safely when preference storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readImageCompressionLocation(broken)).toBe("server");
    expect(() => writeImageCompressionLocation("local", broken)).not.toThrow();
  });

  it("fails safely when the browser denies access to localStorage itself", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage denied", "SecurityError");
      },
    });
    try {
      expect(readImageCompressionLocation()).toBe("server");
      expect(() => writeImageCompressionLocation("local")).not.toThrow();
    } finally {
      if (descriptor === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });
});

describe("PDF compression location", () => {
  it("defaults malformed or missing preferences to the server", () => {
    const storage = new FakeStorage();
    expect(readPdfCompressionLocation(storage)).toBe("server");
    storage.setItem("hereisit.pdf-compression-location.v1", "remote");
    expect(readPdfCompressionLocation(storage)).toBe("server");
  });

  it("persists an explicit local choice independently from images", () => {
    const storage = new FakeStorage();
    writeImageCompressionLocation("server", storage);
    writePdfCompressionLocation("local", storage);
    expect(storage.getItem("hereisit.pdf-compression-location.v1")).toBe("local");
    expect(readPdfCompressionLocation(storage)).toBe("local");
    expect(readImageCompressionLocation(storage)).toBe("server");
  });

  it("fails safely when preference storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readPdfCompressionLocation(broken)).toBe("server");
    expect(() => writePdfCompressionLocation("local", broken)).not.toThrow();
  });
});
