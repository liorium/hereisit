import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

const projectDirectory = resolve(import.meta.dirname, "../apps/api-worker");
const generatorPath = resolve(projectDirectory, "vitest-wrangler-config.ts");

describe("Worker Vitest Wrangler configuration", () => {
  it("derives a JSONC-compatible config without Container Durable Objects", async () => {
    expect(existsSync(generatorPath)).toBe(true);
    if (!existsSync(generatorPath)) return;

    const { createVitestWranglerConfig } = await import(generatorPath);
    const { rawConfig } = experimental_readRawConfig({
      config: resolve(projectDirectory, "wrangler.local.jsonc"),
    });
    const result = createVitestWranglerConfig(rawConfig);

    expect(result.containers).toBeUndefined();
    expect(result.durable_objects).toBeUndefined();
    expect(result.migrations).toBeUndefined();
    expect(result.main).toBe("src/index.ts");
    expect(result.vars).toEqual(rawConfig.vars);
  });

  it("preserves non-Container Durable Object migrations", async () => {
    expect(existsSync(generatorPath)).toBe(true);
    if (!existsSync(generatorPath)) return;

    const { createVitestWranglerConfig } = await import(generatorPath);
    const result = createVitestWranglerConfig({
      name: "test-worker",
      containers: [{ class_name: "ImageEngineContainer", image: "Dockerfile" }],
      durable_objects: {
        bindings: [
          { name: "IMAGE_ENGINE", class_name: "ImageEngineContainer" },
          { name: "COUNTER", class_name: "Counter" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["ImageEngineContainer"] },
        { tag: "v2", new_classes: ["ImageEngineContainer", "Counter"] },
        { tag: "v3", renamed_classes: [{ from: "OldCounter", to: "Counter" }] },
        { tag: "v4", deleted_classes: ["LegacyCounter"] },
      ],
    });

    expect(result).toEqual({
      name: "test-worker",
      durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
      migrations: [
        { tag: "v2", new_classes: ["Counter"] },
        { tag: "v3", renamed_classes: [{ from: "OldCounter", to: "Counter" }] },
        { tag: "v4", deleted_classes: ["LegacyCounter"] },
      ],
    });
  });
});
