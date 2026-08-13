import { describe, expect, it } from "vitest";
import { imageCompressionProcessingManifest, pdfCompressionProcessingManifest } from "./processing";

const forbiddenMetadataTokenPattern = /import\(|function|\bclass\b|worker|credential|filename/i;

function expectJsonLikeMetadata(value: unknown, path = "manifest"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} must contain a finite number`).toBe(true);
    return;
  }

  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value), `${path} must use Array.prototype`).toBe(Array.prototype);

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    expect(lengthDescriptor).toHaveProperty("value");
    expect(lengthDescriptor?.enumerable, `${path}.length must not be enumerable`).toBe(false);

    const length: unknown = lengthDescriptor?.value;
    expect(typeof length, `${path}.length must be numeric`).toBe("number");
    if (typeof length !== "number") {
      return;
    }
    expect(Number.isSafeInteger(length), `${path}.length must be a safe integer`).toBe(true);
    expect(length, `${path}.length must not be negative`).toBeGreaterThanOrEqual(0);

    const ownKeys = Reflect.ownKeys(value);
    expect(ownKeys, `${path} must be a plain array`).toHaveLength(length + 1);

    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      expect(ownKeys[index], `${path} must contain every array index`).toBe(key);

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      expect(descriptor?.enumerable, `${path}[${index}] must be enumerable metadata`).toBe(true);
      expect(descriptor).toHaveProperty("value");
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      expectJsonLikeMetadata(descriptor.value, `${path}[${index}]`);
    }

    expect(ownKeys[length], `${path} must contain only array indices and length`).toBe("length");
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

function expectDeclarativeMetadata(value: unknown): void {
  expectJsonLikeMetadata(value);
  expect(JSON.stringify(value)).not.toMatch(forbiddenMetadataTokenPattern);
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
    expectDeclarativeMetadata(imageCompressionProcessingManifest);
  });

  it("freezes the manifest boundaries", () => {
    expect(Object.isFrozen(imageCompressionProcessingManifest)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.accepts)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.locations)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.limits)).toBe(true);
    expect(Object.isFrozen(imageCompressionProcessingManifest.retention)).toBe(true);
  });
});

describe("PDF compression processing manifest", () => {
  it("declares the PDF-only server fallback", () => {
    expect(pdfCompressionProcessingManifest).toEqual({
      toolId: "pdf.compress",
      contractId: "pdf.optimize@1",
      accepts: ["application/pdf"],
      emits: "application/pdf",
      locations: ["server-native", "browser"],
      limits: {
        maxFiles: 1,
        maxBytesPerFile: 50 * 1024 * 1024,
        maxPagesPerFile: 100,
        maxConcurrentPerAnonymousSession: 1,
      },
      resourceClass: "pdf-standard-v1",
      retention: {
        uploadDeadlineSeconds: 600,
        resultDeadlineSeconds: 1800,
        sweepSeconds: 300,
        resultDeletionSloSeconds: 2100,
        lifecycleExpirationDays: 1,
        hardMaximum: false,
      },
      verifier: "pdf.optimize@1",
      safeFallback: "browser.pdf-compress-scanned",
      rolloutFlag: "pdf-compress-server",
    });
  });

  it("contains immutable declarative metadata only", () => {
    expectDeclarativeMetadata(pdfCompressionProcessingManifest);
    expect(Object.isFrozen(pdfCompressionProcessingManifest)).toBe(true);
    expect(Object.isFrozen(pdfCompressionProcessingManifest.accepts)).toBe(true);
    expect(Object.isFrozen(pdfCompressionProcessingManifest.locations)).toBe(true);
    expect(Object.isFrozen(pdfCompressionProcessingManifest.limits)).toBe(true);
    expect(Object.isFrozen(pdfCompressionProcessingManifest.retention)).toBe(true);
  });
});

describe("processing manifest metadata guard", () => {
  it.each([
    "credentials",
    "workerUrl",
    "originalFilename",
    "functionName",
  ])("rejects forbidden token substrings in %s", (key) => {
    expect(() => expectDeclarativeMetadata({ [key]: "value" })).toThrow();
  });

  it("allows the required resourceClass key", () => {
    expect(() => expectDeclarativeMetadata({ resourceClass: "image-standard-v1" })).not.toThrow();
  });

  it("rejects array subclasses", () => {
    class MetadataArray extends Array<unknown> {}

    const candidate = new MetadataArray();
    candidate.push("value");

    expect(() => expectJsonLikeMetadata(candidate)).toThrow();
  });

  it.each([
    "map",
    "forEach",
  ] as const)("rejects an array subclass without invoking its overridden %s", (method) => {
    class MetadataArray extends Array<unknown> {}

    let callCount = 0;
    Object.defineProperty(MetadataArray.prototype, method, {
      value: () => {
        callCount += 1;
        throw new Error(`${method} invoked`);
      },
    });

    const candidate = new MetadataArray();
    candidate.push("value");

    let thrown: unknown;
    try {
      expectJsonLikeMetadata(candidate);
    } catch (error) {
      thrown = error;
    }

    expect(callCount).toBe(0);
    expect(thrown).toBeInstanceOf(Error);
  });

  it("rejects non-enumerable array elements", () => {
    const candidate: unknown[] = ["value"];
    Object.defineProperty(candidate, "0", { enumerable: false });

    expect(() => expectJsonLikeMetadata(candidate)).toThrow();
  });

  it("rejects accessor-backed array elements without invoking them", () => {
    const candidate: unknown[] = ["value"];
    let accessCount = 0;
    Object.defineProperty(candidate, "0", {
      enumerable: true,
      get: () => {
        accessCount += 1;
        return "value";
      },
    });

    let thrown: unknown;
    try {
      expectJsonLikeMetadata(candidate);
    } catch (error) {
      thrown = error;
    }

    expect(accessCount).toBe(0);
    expect(thrown).toBeInstanceOf(Error);
  });
});
