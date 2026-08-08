import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, "scripts/test-playwright-webkit-container.mjs");

async function fakeDocker(exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), "hereisit-webkit-container-"));
  temporaryRoots.push(root);
  const capturePath = join(root, "docker-args.txt");
  const dockerPath = join(root, "docker");
  await writeFile(
    dockerPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$DOCKER_CAPTURE"\nexit "$DOCKER_EXIT_CODE"\n`,
  );
  await chmod(dockerPath, 0o755);
  return {
    capturePath,
    env: {
      ...process.env,
      DOCKER_CAPTURE: capturePath,
      DOCKER_EXIT_CODE: String(exitCode),
      PATH: `${root}:${process.env.PATH ?? ""}`,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("runs only WebKit projects in a disposable matching Playwright container", async () => {
  const fake = await fakeDocker();
  await execFileAsync(process.execPath, [scriptPath, "--", "--grep", "PDF"], {
    cwd: repositoryRoot,
    env: fake.env,
  });

  const args = (await readFile(fake.capturePath, "utf8")).trim().split("\n");
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const playwrightVersion = manifest.devDependencies["@playwright/test"];

  expect(manifest.scripts["verify:all"]).toContain("pnpm test:e2e:webkit");
  expect(args).toContain("run");
  expect(args).toContain("--rm");
  expect(args).toContain(`type=bind,src=${repositoryRoot},dst=/work,readonly`);
  expect(args).toContain("PLAYWRIGHT_WEBKIT=1");
  expect(args).toContain("PLAYWRIGHT_CONTAINER=1");
  expect(args).toContain("NODE_PATH=/work/node_modules/.pnpm/node_modules");
  expect(args).toContain(`mcr.microsoft.com/playwright:v${playwrightVersion}-noble`);
  expect(args).toContain("--project=webkit");
  expect(args).toContain("--project=mobile-webkit");
  expect(args).toContain("--output=/tmp/test-results");
  expect(args).not.toContain("--project=chromium");
  expect(args).not.toContain("--project=firefox");
  expect(args).not.toContain("--");
  expect(args).toContain("--grep");
  expect(args).toContain("PDF");
});

it("returns Docker's failure status", async () => {
  const fake = await fakeDocker(23);

  await expect(
    execFileAsync(process.execPath, [scriptPath], { cwd: repositoryRoot, env: fake.env }),
  ).rejects.toMatchObject({ code: 23 });
});
