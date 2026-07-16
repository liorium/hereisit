import { describe, expect, it } from "vitest";
import { imageCompressionProcessingManifest } from "./processing";

function expectJsonLikeMetadata(value: unknown, path = "manifest"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} must contain a finite number`).toBe(true);
    return;
  }

  if (Array.isArray(value)) {
    expect(Reflect.ownKeys(value), `${path} must be a plain array`).toEqual([
      ...value.map((_, index) => String(index)),
      "length",
    ]);
    value.forEach((entry, index) => {
      expectJsonLikeMetadata(entry, `${path}[${index}]`);
    });
    return;
  }

  expect(typeof value, `${path} must contain metadata only`).toBe("object");
  expect(Object.getPrototypeOf(value), `${path} must be a plain object`).toBe(Object.prototype);

  for (const key of Reflect.ownKeys(value as object)) {
    expect(typeof key, `${path} must use string metadata keys`).toBe("string");
    if (typeof key !== "string") {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor?.enumerable, `${path}.${key} must be enumerable metadata`).toBe(true);
    expect(descriptor).toHaveProperty("value");
    expectJsonLikeMetadata(descriptor?.value, `${path}.${key}`);
  }
}

describe("image compression processing manifest", () => {
  it("declares exact limits, retention, execution, and fallback", () => {
    expect(imageCompressionProcessingManifest).toEqual({
      toolId: "image.compress",
      contractId: "image.optimize@1",
      accepts: ["image/jpeg", "image/png", "image/webp"],
      emits: "same-format",
      locations: ["server-native", "browser"],
      limits: {
        maxFiles: 20,
        maxBytesPerFile: 30 * 1024 * 1024,
        maxPixelsPerFile: 40_000_000,
        maxConcurrentPerAnonymousSession: 1,
      },
      resourceClass: "image-standard-v1",
      retention: {
        uploadDeadlineSeconds: 600,
        resultDeadlineSeconds: 1800,
        sweepSeconds: 300,
        resultDeletionSloSeconds: 2100,
        lifecycleExpirationDays: 1,
        hardMaximum: false,
      },
      verifier: "image.optimize@1",
      safeFallback: "browser.same-format",
      rolloutFlag: "image-compress-server",
    });
  });

  it("contains metadata only", () => {
    expectJsonLikeMetadata(imageCompressionProcessingManifest);

    const serialized = JSON.stringify(imageCompressionProcessingManifest);
    expect(serialized).not.toMatch(
      /import\(|\bfunction\b|\bclass\b|\bworker\b|\bcredential\b|\bfilename\b/i,
    );
  });

  it("freezes the manifest boundaries", () => {
    expect(Object.isFrozen(imageCompressionProcessingManifest)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.accepts)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.locations)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.limits)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.retention)).toBe(true);
  });
});
