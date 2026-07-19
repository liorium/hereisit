import { describe, expect, it } from "vitest";
import { resolveRunnerModuleUrl } from "./runner-path";

describe("runner module path", () => {
  it("matches the nested esbuild output beside the bundled server", () => {
    expect(resolveRunnerModuleUrl("file:///app/dist/server.mjs").href).toBe(
      "file:///app/dist/job/job-runner.mjs",
    );
  });
});
