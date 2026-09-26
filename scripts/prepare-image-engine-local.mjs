import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { validateRuntimePackageInventory } from "./verify-image-engine-licenses.mjs";

export const BASE_ENGINE_IMAGE = "hereisit-image-engine:test";
export const LOCAL_ENGINE_IMAGE = "hereisit-image-engine:local-source";
const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

async function inspectBaseImage(image) {
  const { stdout } = await execute(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "/nodejs/bin/node",
      image,
      "-e",
      'const fs = require("node:fs"); process.stdout.write(JSON.stringify({ ...JSON.parse(fs.readFileSync("/build-metadata/debian-packages.json", "utf8")), sourceLock: JSON.parse(fs.readFileSync("/licenses/sources.lock.json", "utf8")) }))',
    ],
    { cwd: repositoryRoot, maxBuffer: 1024 * 1024, timeout: 10_000 },
  );
  return JSON.parse(stdout);
}

async function runCommand(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

export async function prepareLocalImageEngine({
  inspect = inspectBaseImage,
  run = runCommand,
} = {}) {
  const sourceLock = JSON.parse(
    await readFile(resolve(repositoryRoot, "apps/image-engine/native/sources.lock.json"), "utf8"),
  );
  let hasBaseImage = true;
  try {
    const inventory = await inspect(BASE_ENGINE_IMAGE);
    validateRuntimePackageInventory(inventory);
    if (!isDeepStrictEqual(inventory.sourceLock, sourceLock)) {
      throw new Error("native source lock does not match the local checkout");
    }
  } catch {
    hasBaseImage = false;
  }

  if (!hasBaseImage) {
    await run("docker", [
      "build",
      "--file",
      "apps/image-engine/Dockerfile",
      "--target",
      "production",
      "--tag",
      BASE_ENGINE_IMAGE,
      ".",
    ]);
  }
  await run("pnpm", ["--filter", "@hereisit/image-engine", "build"]);
  await run("docker", [
    "build",
    "--file",
    "apps/image-engine/Dockerfile.local-reuse",
    "--tag",
    LOCAL_ENGINE_IMAGE,
    "apps/image-engine",
  ]);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await prepareLocalImageEngine();
}
