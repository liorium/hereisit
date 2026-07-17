import { describe, expect, it } from "vitest";
import { generateHeaders } from "../scripts/generate-web-headers.mjs";

describe("Cloudflare Pages header generation", () => {
  it("adds only one validated HTTPS processing origin", () => {
    expect(generateHeaders({ processingApiOrigin: "https://processing.example.com" })).toContain(
      "connect-src 'self' https://processing.example.com",
    );
    expect(generateHeaders({ processingApiOrigin: null })).toContain("connect-src 'self';");
  });

  it("rejects executable, credentialed, and path-bearing values", () => {
    for (const origin of [
      "javascript:alert(1)",
      "https://user@example.com",
      "https://example.com/v1",
    ]) {
      expect(() => generateHeaders({ processingApiOrigin: origin })).toThrow("origin");
    }
  });

  it("allows local HTTP only behind the explicit development flag", () => {
    expect(() => generateHeaders({ processingApiOrigin: "http://127.0.0.1:8787" })).toThrow(
      "origin",
    );
    expect(
      generateHeaders({
        processingApiOrigin: "http://localhost:8787",
        allowLocalProcessingOrigins: true,
      }),
    ).toContain("connect-src 'self' http://localhost:8787");
  });
});
