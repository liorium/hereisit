import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
process.on("SIGTERM", () => undefined);

if (role === "runner" || role === "codec") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), role === "runner" ? "codec" : "grandchild"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

if (role === "runner") process.stdout.write("ready\n");
setInterval(() => undefined, 1_000);
