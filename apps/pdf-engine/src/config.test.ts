import { describe, expect, it } from "vitest";
import { readPdfEngineConfig } from "./config";

const valid = { ENGINE_BUILD_ID: "pdf-engine-test", QPDF_BUILD_ID: "qpdf-12.4.0" };

describe("PDF engine config", () => {
  it("uses private bounded defaults", () => {
    expect(readPdfEngineConfig(valid)).toMatchObject({
      port: 8080,
      workspaceRoot: "/tmp/hereisit-pdf-engine",
      shutdownGraceMs: 30_000,
      maxWallMs: 45_000,
      maxRssBytes: 768 * 1024 * 1024,
      maxWorkspaceBytes: 256 * 1024 * 1024,
    });
  });

  it.each([
    ["PORT", "0"],
    ["ROLLOUT_GRACE_MS", "120001"],
    ["PDF_MAX_WALL_MS", "0"],
    ["PDF_MAX_RSS_BYTES", "1.5"],
    ["PDF_MAX_WORKSPACE_BYTES", "not-a-number"],
  ])("rejects an invalid %s", (name, value) => {
    expect(() => readPdfEngineConfig({ ...valid, [name]: value })).toThrow();
  });

  it.each([
    "/",
    "/tmp",
    "relative",
    "/tmp/hereisit-pdf-engine-other",
    "/tmp/hereisit-pdf-engine/../outside",
  ])("rejects unsafe workspace root %s", (workspaceRoot) => {
    expect(() => readPdfEngineConfig({ ...valid, WORKSPACE_ROOT: workspaceRoot })).toThrow();
  });

  it("accepts only the fixed workspace root or its descendants", () => {
    expect(
      readPdfEngineConfig({ ...valid, WORKSPACE_ROOT: "/tmp/hereisit-pdf-engine/private" })
        .workspaceRoot,
    ).toBe("/tmp/hereisit-pdf-engine/private");
  });
});
