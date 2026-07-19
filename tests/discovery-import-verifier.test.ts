import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const verifier = "scripts/verify-discovery-imports.mjs";
const safeFixture = "scripts/fixtures/discovery-import-boundary/safe.ts";
const forbiddenFixture = "scripts/fixtures/discovery-import-boundary/forbidden.ts";

it("accepts an alternate runtime graph made only of safe imports", async () => {
  const result = await execFileAsync(
    process.execPath,
    [verifier, "--entrypoint", safeFixture, "--entrypoint", safeFixture],
    { cwd: process.cwd() },
  );

  expect(result.stderr).toBe("");
});

it("ignores type-only Worker references", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), "tests/.discovery-import-"));
  try {
    const entrypoint = path.join(fixtureRoot, "type-entry.ts");
    await writeFile(
      entrypoint,
      'type RuntimeCapability = Worker;\nexport const fixture = "safe";\n',
    );
    const result = await execFileAsync(
      process.execPath,
      [verifier, "--entrypoint", path.relative(process.cwd(), entrypoint)],
      { cwd: process.cwd() },
    );

    expect(result.stderr).toBe("");
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

it("rejects a forbidden workspace package without printing source content", async () => {
  await expect(
    execFileAsync(process.execPath, [verifier, "--entrypoint", forbiddenFixture], {
      cwd: process.cwd(),
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(`${forbiddenFixture} -> @hereisit/pdf-tool`),
  });

  try {
    await execFileAsync(process.execPath, [verifier, "--entrypoint", forbiddenFixture], {
      cwd: process.cwd(),
    });
  } catch (error) {
    expect(error).toMatchObject({
      stderr: expect.not.stringContaining('export const fixture = "forbidden"'),
    });
  }
});

it("rejects a Worker constructor even when its non-literal target has a neutral name", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), "tests/.discovery-import-"));
  try {
    const entrypoint = path.join(fixtureRoot, "entry.ts");
    await Promise.all([
      writeFile(
        entrypoint,
        [
          'const workerTarget = new URL("./executor.ts", import.meta.url);',
          "new Worker(workerTarget);",
        ].join("\n"),
        "utf8",
      ),
      writeFile(path.join(fixtureRoot, "executor.ts"), 'export const fixture = "safe";\n', "utf8"),
    ]);
    const relativeEntrypoint = path.relative(process.cwd(), entrypoint);

    await expect(
      execFileAsync(process.execPath, [verifier, "--entrypoint", relativeEntrypoint], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${relativeEntrypoint} -> Worker`),
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

it("rejects qualified and aliased Worker constructors", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), "tests/.discovery-import-"));
  try {
    const variants = {
      "qualified-a.ts": 'new globalThis.Worker(new URL("./executor.ts", import.meta.url));\n',
      "qualified-b.ts": 'new window.SharedWorker(new URL("./executor.ts", import.meta.url));\n',
      "element-entry.ts": 'new self["Worker"](new URL("./executor.ts", import.meta.url));\n',
      "alias-entry.ts": 'const RuntimeWorker = Worker;\nnew RuntimeWorker("./executor.ts");\n',
    };
    await Promise.all([
      writeFile(path.join(fixtureRoot, "executor.ts"), 'export const fixture = "safe";\n', "utf8"),
      ...Object.entries(variants).map(([filename, source]) =>
        writeFile(path.join(fixtureRoot, filename), source, "utf8"),
      ),
    ]);

    await Promise.all(
      Object.keys(variants).map(async (filename) => {
        const relativeEntrypoint = path.relative(process.cwd(), path.join(fixtureRoot, filename));
        await expect(
          execFileAsync(process.execPath, [verifier, "--entrypoint", relativeEntrypoint], {
            cwd: process.cwd(),
          }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(`${relativeEntrypoint} -> Worker`),
        });
      }),
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

it("fails closed on non-literal dynamic import and require calls", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), "tests/.discovery-import-"));
  try {
    const entrypoint = path.join(fixtureRoot, "entry.ts");
    await writeFile(
      entrypoint,
      [
        'const importTarget = "./executor.ts";',
        "void import(importTarget);",
        'const requireTarget = "benign-runtime";',
        "void require(requireTarget);",
      ].join("\n"),
      "utf8",
    );
    const relativeEntrypoint = path.relative(process.cwd(), entrypoint);

    await expect(
      execFileAsync(process.execPath, [verifier, "--entrypoint", relativeEntrypoint], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/import\(<non-literal>\).*require\(<non-literal>\)/s),
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

it("rejects an unknown bare runtime package instead of treating it as a framework terminal", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), "tests/.discovery-import-"));
  try {
    const entrypoint = path.join(fixtureRoot, "entry.ts");
    await writeFile(entrypoint, 'import "benign-runtime";\n', "utf8");
    const relativeEntrypoint = path.relative(process.cwd(), entrypoint);

    await expect(
      execFileAsync(process.execPath, [verifier, "--entrypoint", relativeEntrypoint], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${relativeEntrypoint} -> benign-runtime`),
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

it("does not echo an absolute entrypoint in diagnostics", async () => {
  const absoluteEntrypoint = path.join(process.cwd(), "apps/web/src/app/page.tsx");
  try {
    await execFileAsync(process.execPath, [verifier, "--entrypoint", absoluteEntrypoint], {
      cwd: process.cwd(),
    });
    throw new Error("Expected the absolute entrypoint to be rejected");
  } catch (error) {
    expect(error).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("<absolute-entrypoint>"),
    });
    expect(error).toMatchObject({ stderr: expect.not.stringContaining(process.cwd()) });
  }
});
