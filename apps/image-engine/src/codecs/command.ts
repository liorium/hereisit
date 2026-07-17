import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number;
  readonly elapsedMs: number;
  readonly stderrTail: string;
  readonly stdoutTail?: string;
}

export type BoundedCommandFailureReason = "aborted" | "spawn" | "timeout";

export class BoundedCommandError extends Error {
  readonly reason: BoundedCommandFailureReason;

  constructor(reason: BoundedCommandFailureReason) {
    super(`bounded codec process failed: ${reason}`);
    this.name = "BoundedCommandError";
    this.reason = reason;
  }
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function appendTail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
  if (chunk.byteLength >= maximum) return Buffer.from(chunk.subarray(chunk.byteLength - maximum));
  const excess = current.byteLength + chunk.byteLength - maximum;
  return Buffer.concat([excess > 0 ? current.subarray(excess) : current, chunk]);
}

export function runBoundedCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStderrBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly signal: AbortSignal;
  readonly onProcessGroup?: (event: { action: "add" | "remove"; pgid: number }) => void;
}): Promise<CommandResult> {
  if (input.command.length === 0 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    return Promise.reject(new TypeError("bounded command input is invalid"));
  }
  const maximum = input.maxStderrBytes ?? 8_192;
  const maximumStdout = input.maxStdoutBytes ?? 8_192;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    !Number.isSafeInteger(maximumStdout) ||
    maximumStdout < 1
  ) {
    return Promise.reject(new TypeError("command output limit is invalid"));
  }
  if (input.signal.aborted) return Promise.reject(new BoundedCommandError("aborted"));

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new BoundedCommandError("spawn"));
      return;
    }
    const pgid = child.pid;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let failure: BoundedCommandFailureReason | null = null;
    let removed = false;
    let forceKill: NodeJS.Timeout | undefined;

    const removeGroup = () => {
      if (pgid === undefined || removed) return;
      removed = true;
      input.onProcessGroup?.({ action: "remove", pgid });
    };
    const terminate = (reason: "aborted" | "timeout") => {
      if (failure !== null) return;
      failure = reason;
      if (pgid === undefined) return;
      killProcessGroup(pgid, "SIGTERM");
      forceKill = setTimeout(() => killProcessGroup(pgid, "SIGKILL"), 250);
      forceKill.unref();
    };
    const onAbort = () => terminate("aborted");
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (pgid !== undefined) input.onProcessGroup?.({ action: "add", pgid });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk, maximum);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail = appendTail(stdoutTail, chunk, maximumStdout);
    });
    child.once("error", () => {
      failure ??= "spawn";
    });
    const deadline = setTimeout(() => terminate("timeout"), input.timeoutMs);
    deadline.unref();
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (forceKill !== undefined) clearTimeout(forceKill);
      input.signal.removeEventListener("abort", onAbort);
      if (pgid !== undefined) killProcessGroup(pgid, "SIGKILL");
      removeGroup();
      if (failure !== null) {
        reject(new BoundedCommandError(failure));
        return;
      }
      resolve({
        exitCode: typeof code === "number" ? code : 1,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        stderrTail: stderrTail.toString("utf8"),
        stdoutTail: stdoutTail.toString("utf8"),
      });
    });
  });
}
