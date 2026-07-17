import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedCommandError, runBoundedCommand } from "./command";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-command-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function eventuallyGone(pid: number): Promise<boolean> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }
  return false;
}

describe("runBoundedCommand", () => {
  it("preserves literal arguments, never invokes a shell, and bounds stderr", async () => {
    const cwd = await root();
    const forbidden = join(cwd, "forbidden");
    const result = await runBoundedCommand({
      command: process.execPath,
      args: [
        "-e",
        "if(process.argv[1]!=='; touch forbidden')process.exit(9);process.stderr.write('x'.repeat(12000))",
        "; touch forbidden",
      ],
      cwd,
      timeoutMs: 1_000,
      maxStderrBytes: 8_192,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(Buffer.byteLength(result.stderrTail)).toBe(8_192);
    expect(await exists(forbidden)).toBe(false);
  });

  it("registers and removes a distinct detached process group", async () => {
    const cwd = await root();
    const events: Array<{ action: "add" | "remove"; pgid: number }> = [];
    await expect(
      runBoundedCommand({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd,
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        onProcessGroup: (event) => events.push(event),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "add" });
    expect(events[1]).toEqual({ action: "remove", pgid: events[0]?.pgid });
    expect(events[0]?.pgid).not.toBe(process.pid);
  });

  it("kills a stubborn process tree on deadline without exposing its command", async () => {
    const cwd = await root();
    const childPidPath = join(cwd, "child.pid");
    const script = [
      "const{spawn}=require('node:child_process');",
      "process.on('SIGTERM',()=>{});",
      "const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
      "require('node:fs').writeFileSync(process.argv[1],String(c.pid));",
      "setInterval(()=>{},1000);",
    ].join("");

    let error: unknown;
    try {
      await runBoundedCommand({
        command: process.execPath,
        args: ["-e", script, childPidPath],
        cwd,
        timeoutMs: 100,
        signal: new AbortController().signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoundedCommandError);
    expect(error).toMatchObject({ reason: "timeout" });
    expect(String(error)).not.toContain(script);
    const childPid = Number(await readFile(childPidPath, "utf8"));
    expect(await eventuallyGone(childPid)).toBe(true);
  });

  it("kills the process group when its AbortSignal is cancelled", async () => {
    const cwd = await root();
    const controller = new AbortController();
    const promise = runBoundedCommand({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      cwd,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ reason: "aborted" });
  });
});
