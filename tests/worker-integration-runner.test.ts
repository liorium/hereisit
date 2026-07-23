import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectDirectory = resolve(import.meta.dirname, "../apps/api-worker");
const runnerPath = resolve(projectDirectory, "scripts/run-integration-tests.mjs");

describe("Worker integration test runner", () => {
  it("fails closed when a Container bootstrap error is split across output chunks", async () => {
    expect(existsSync(runnerPath)).toBe(true);
    if (!existsSync(runnerPath)) return;

    const { createWorkerTestOutputGuard } = await import(runnerPath);
    const guard = createWorkerTestOutputGuard();
    guard.observe("stderr", "Containers have not been enabled for this Durable Object ");
    guard.observe("stdout", "interleaved test progress");
    guard.observe("stderr", "class");

    expect(guard.failed()).toBe(true);
  });

  it("is the package-level integration command", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(projectDirectory, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["test:integration"]).toBe("node scripts/run-integration-tests.mjs");
  });
});
