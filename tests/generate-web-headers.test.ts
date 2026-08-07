import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateHeaders, writeGeneratedHeaders } from "../scripts/generate-web-headers.mjs";

describe("Cloudflare Pages header generation", () => {
  it("allows only the exact Cloudflare Web Analytics beacon", () => {
    const headers = generateHeaders({ processingApiOrigin: null });
    expect(headers).toContain(
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com/beacon.min.js",
    );
    expect(headers).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(headers).not.toContain("script-src *");
    expect(headers).not.toContain("connect-src *");
  });

  it("adds only one validated HTTPS processing origin", () => {
    expect(generateHeaders({ processingApiOrigin: "https://processing.example.com" })).toContain(
      "connect-src 'self' https://cloudflareinsights.com https://processing.example.com",
    );
    expect(generateHeaders({ processingApiOrigin: null })).toContain(
      "connect-src 'self' https://cloudflareinsights.com;",
    );
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
    ).toContain("connect-src 'self' https://cloudflareinsights.com http://localhost:8787");
  });

  it("creates the Pages public directory on a clean checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-headers-"));
    const target = join(root, "missing", "public", "_headers");
    try {
      await writeGeneratedHeaders({}, target);
      expect(await readFile(target, "utf8")).toContain("Content-Security-Policy:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
