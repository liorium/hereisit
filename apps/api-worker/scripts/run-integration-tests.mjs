import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BOOTSTRAP_FAILURE = "Containers have not been enabled for this Durable Object class";

export function createWorkerTestOutputGuard() {
  const tails = { stdout: "", stderr: "" };
  let bootstrapFailed = false;
  return {
    observe(stream, chunk) {
      const output = tails[stream] + chunk.toString();
      bootstrapFailed ||= output.includes(BOOTSTRAP_FAILURE);
      tails[stream] = output.slice(1 - BOOTSTRAP_FAILURE.length);
    },
    failed() {
      return bootstrapFailed;
    },
  };
}

async function run() {
  const projectDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const vitestPath = fileURLToPath(
    new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")),
  );
  const guard = createWorkerTestOutputGuard();
  const child = spawn(
    process.execPath,
    [vitestPath, "run", "-c", "vitest.config.ts", ...process.argv.slice(2)],
    {
      cwd: projectDirectory,
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    guard.observe("stdout", chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    guard.observe("stderr", chunk);
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(1));
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  if (guard.failed()) {
    process.stderr.write("Worker integration bootstrap failed while Containers were disabled.\n");
    return 1;
  }
  return exitCode;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) process.exitCode = await run();
