import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOrCreateAnonymousSessionId,
  isUnprovenInAppBrowser,
  readProcessingClientConfig,
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
