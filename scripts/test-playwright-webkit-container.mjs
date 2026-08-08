#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const playwrightVersion = manifest.devDependencies?.["@playwright/test"];
const forwardedArgs = process.argv[2] === "--" ? process.argv.slice(3) : process.argv.slice(2);

if (typeof playwrightVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(playwrightVersion)) {
  throw new Error("@playwright/test must use an exact version");
}

const dockerArgs = [
  "run",
  "--rm",
  "--init",
  "--ipc=host",
  "--mount",
  `type=bind,src=${repositoryRoot},dst=/work,readonly`,
  "--tmpfs",
  "/work/apps/web/.wrangler:rw,mode=1777",
  "--workdir",
  "/work",
  "--env",
  "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  "--env",
  "PLAYWRIGHT_WEBKIT=1",
  "--env",
  "PLAYWRIGHT_CONTAINER=1",
  "--env",
  "NODE_PATH=/work/node_modules/.pnpm/node_modules",
  ...(process.env.CI ? ["--env", "CI=1"] : []),
  `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`,
  "bash",
  "-lc",
  'exec node node_modules/@playwright/test/cli.js test "$@"',
  "webkit-container",
  "--project=webkit",
  "--project=mobile-webkit",
  "--workers=1",
  ...forwardedArgs,
  "--output=/tmp/test-results",
];

const result = spawnSync("docker", dockerArgs, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
