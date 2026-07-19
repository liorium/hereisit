import { describe, expect, it } from "vitest";
import { summarizeSmokeRequests } from "../scripts/smoke-image-compress-server.mjs";
import {
  createEdgeForwardHeaders,
  dynamicWorkerConfig,
  redactProcessingStackOutput,
  shouldForwardEdgeResponseHeader,
} from "../scripts/test-processing-stack.mjs";

describe("processing stack harness", () => {
  it("redacts credentials and authenticated upload paths from child output", () => {
    const output = redactProcessingStackOutput(
      "Authorization: Bearer private /v1/jobs/123e4567-e89b-42d3-a456-426614174000/input x-download-lease=lease",
    );

    expect(output).not.toContain("private");
    expect(output).not.toContain("123e4567-e89b-42d3-a456-426614174000");
    expect(output).not.toContain("=lease");
    expect(output).toContain("[redacted]");
  });

  it("specializes an isolated Worker configuration for the random Pages origin", () => {
    const source = `{
      "name": "hereisit-api-worker-local",
      "vars": {
        "APP_ORIGINS": "[\\"http://127.0.0.1:4173\\"]",
        "UNCHANGED": "yes"
      }
    }`;
    const output = dynamicWorkerConfig(source, "http://127.0.0.1:49123", "test-run");

    expect(output).toContain('"name": "hereisit-stack-test-run"');
    expect(output).toContain("http://127.0.0.1:49123");
    expect(output).toContain('"UNCHANGED": "yes"');
    expect(output).not.toContain("http://127.0.0.1:4173");
  });

  it("reuses the prebuilt local engine image without compiling native codecs again", () => {
    const source = `{
      "name": "hereisit-api-worker-local",
      "compatibility_date": "2026-07-16",
      "containers": [{
        "image": "../image-engine/Dockerfile",
        "image_build_context": "../.."
      }],
      "vars": {
        "APP_ORIGINS": "[\\"http://127.0.0.1:4173\\"]"
      }
    }`;
    const output = dynamicWorkerConfig(source, "http://127.0.0.1:49123", "test-run", {
      reuseLocalEngineImage: true,
      localCompatibilityDate: "2026-07-15",
    });

    expect(output).toContain('"image": "../image-engine/Dockerfile.local-reuse"');
    expect(output).toContain('"image_build_context": "../image-engine"');
    expect(output).not.toContain('"image": "../image-engine/Dockerfile"');
    expect(output).toContain('"compatibility_date": "2026-07-15"');
  });

  it("reports only normalized browser request paths", () => {
    expect(
      summarizeSmokeRequests([
        "PUT http://127.0.0.1:8787/v1/jobs/123e4567-e89b-42d3-a456-426614174000/input",
      ]),
    ).toEqual(["PUT /v1/jobs/[job]/input"]);
  });

  it("emulates only the Cloudflare-managed connecting address at the local edge", () => {
    const headers = createEdgeForwardHeaders({
      host: "untrusted.example",
      connection: "keep-alive",
      origin: "http://127.0.0.1:4173",
    });

    expect(headers.get("cf-connecting-ip")).toBe("203.0.113.10");
    expect(headers.get("origin")).toBe("http://127.0.0.1:4173");
    expect(headers.has("host")).toBe(false);
    expect(headers.has("connection")).toBe(false);
  });

  it("drops response framing invalidated by the local edge fetch decompressor", () => {
    expect(shouldForwardEdgeResponseHeader("content-encoding")).toBe(false);
    expect(shouldForwardEdgeResponseHeader("content-length")).toBe(false);
    expect(shouldForwardEdgeResponseHeader("content-type")).toBe(true);
  });
});
