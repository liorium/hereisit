import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  calculateBundleMeasurement,
  findForbiddenProcessorMarkers,
  validateBundleMeasurement,
} from "../scripts/verify-discovery-bundles.mjs";

const execFileAsync = promisify(execFile);

describe("discovery bundle verifier", () => {
  it("separates framework, discovery-shared, and route-owned gzip costs", () => {
    const discoveryRoutes = {
      "/": ["framework.js", "shared.js", "home.js"],
      "/tools": ["framework.js", "shared.js", "tools.js"],
      "/my-tools": ["framework.js", "shared.js", "personal.js"],
      "/workflows": ["framework.js", "workflow.js"],
    };
    const allBuiltRoutes = [...Object.values(discoveryRoutes), ["framework.js", "processor.js"]];

    expect(
      calculateBundleMeasurement(discoveryRoutes, allBuiltRoutes, {
        "framework.js": 1_000,
        "shared.js": 500,
        "home.js": 100,
        "tools.js": 200,
        "personal.js": 300,
        "workflow.js": 0,
        "processor.js": 9_000,
      }),
    ).toEqual({
      schemaVersion: 1,
      routes: { "/": 100, "/tools": 200, "/my-tools": 300, "/workflows": 0 },
      discoveryShared: 500,
      frameworkSharedReported: 1_000,
    });
  });

  it("enforces absolute and baseline growth limits exactly", () => {
    const baseline = {
      schemaVersion: 1 as const,
      routes: { "/": 100, "/tools": 20_000, "/my-tools": 0, "/workflows": 0 },
      discoveryShared: 100,
      frameworkSharedReported: 1_000,
    };

    expect(() =>
      validateBundleMeasurement(
        {
          ...baseline,
          routes: { "/": 110, "/tools": 22_000, "/my-tools": 0, "/workflows": 0 },
          discoveryShared: 110,
        },
        baseline,
      ),
    ).not.toThrow();
    expect(() =>
      validateBundleMeasurement(
        {
          ...baseline,
          routes: { "/": 111, "/tools": 22_001, "/my-tools": 0, "/workflows": 0 },
          discoveryShared: 111,
        },
        baseline,
      ),
    ).toThrow(/baseline growth/i);
    expect(() =>
      validateBundleMeasurement({
        ...baseline,
        routes: { "/": 76_801, "/tools": 20_000, "/my-tools": 0, "/workflows": 0 },
      }),
    ).toThrow(/absolute limit/i);
    expect(() => validateBundleMeasurement({ ...baseline, discoveryShared: 122_881 })).toThrow(
      /absolute limit/i,
    );
  });

  it("rejects a forbidden processor marker even in a tiny discovery chunk", () => {
    expect(
      findForbiddenProcessorMarkers(
        {
          "/": ["tiny-worker.js", "tiny-runtime.js", "tiny-wasm.js"],
          "/tools": [],
          "/my-tools": [],
          "/workflows": [],
        },
        {
          "tiny-worker.js": "const worker = 'hereisit-image-worker'",
          "tiny-runtime.js": "const runtime = '@hereisit/browser-runtime'",
          "tiny-wasm.js": "const module = 'processor.wasm'",
        },
      ),
    ).toEqual([
      { route: "/", marker: "hereisit-image-worker" },
      { route: "/", marker: "@hereisit/browser-runtime" },
      { route: "/", marker: ".wasm" },
    ]);
  });

  it("rejects malformed baseline data instead of silently resetting it", () => {
    expect(() =>
      validateBundleMeasurement(
        {
          schemaVersion: 1,
          routes: { "/": 0, "/tools": 0, "/my-tools": 0, "/workflows": 0 },
          discoveryShared: 0,
          frameworkSharedReported: 0,
        },
        {
          schemaVersion: 2,
          routes: { "/": 0, "/tools": 0, "/my-tools": 0, "/workflows": 0 },
          discoveryShared: 0,
          frameworkSharedReported: 0,
        },
      ),
    ).toThrow(/schema version/i);
  });

  it("fails closed on unknown CLI arguments before reporting measurements", async () => {
    await expect(
      execFileAsync(process.execPath, ["scripts/verify-discovery-bundles.mjs", "--unexpected"]),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/unknown.+argument/i) });
  });
});
