import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  type EngineCreateJobRequest,
  type EngineJobStatus,
  engineCreateJobRequestSchema,
  engineJobStatusSchema,
} from "@hereisit/server-contracts";
import {
  createJobWorkspace,
  hashExactInput,
  type JobWorkspace,
  removeJobWorkspace,
  writeExactInput,
  writeJsonAtomic,
} from "./workspace";

const EMPTY_MEASUREMENTS = {
  processedInputBytes: 0,
  processedPixels: 0,
  cpuMs: 0,
  memoryByteMilliseconds: 0,
  peakMemoryBytes: 0,
  testedCandidates: 0,
  processingMs: 0,
} as const;

function crashStatus(jobId: string, sequence: number): EngineJobStatus {
  return {
    protocol: 1,
    jobId,
    state: "failed",
    phase: null,
    fraction: null,
    sequence,
    measurements: EMPTY_MEASUREMENTS,
    inspection: null,
    error: { code: "ENGINE_CRASH", retryable: true },
  };
}

export interface RunnerStartInput {
  readonly request: EngineCreateJobRequest;
  readonly workspace: JobWorkspace;
  readonly onProcessGroup: (pgid: number) => void;
  readonly onProcessGroupRemoved: (pgid: number) => void;
  readonly onProgress: (status: Extract<EngineJobStatus, { state: "running" }>) => Promise<void>;
}

export interface RunnerHandle {
  readonly runnerPgid: number;
  readonly completion: Promise<EngineJobStatus>;
}

export interface EngineRunner {
  start(input: RunnerStartInput): RunnerHandle | Promise<RunnerHandle>;
}

interface JobRecord {
  readonly request: EngineCreateJobRequest;
  readonly identity: string;
  readonly workspace: JobWorkspace;
  status: EngineJobStatus;
  inputSha256: string | null;
  runnerPgid: number | null;
  readonly codecPgids: Set<number>;
}

export interface ProcessTerminationInput {
  readonly runnerPgid: number;
  readonly registeredCodecPgids: readonly number[];
  readonly enumerate: () => Promise<readonly number[]>;
  readonly signal: (pgid: number, signal: NodeJS.Signals) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly alive: (pgid: number) => Promise<boolean>;
}

async function bestEffortSignal(
  signal: ProcessTerminationInput["signal"],
  pgid: number,
  value: NodeJS.Signals,
): Promise<void> {
  await signal(pgid, value).catch(() => undefined);
}

export async function terminateProcessGroups(input: ProcessTerminationInput): Promise<void> {
  const known = new Set([...input.registeredCodecPgids, ...(await input.enumerate())]);
  known.delete(input.runnerPgid);
  for (const pgid of known) await bestEffortSignal(input.signal, pgid, "SIGTERM");
  await bestEffortSignal(input.signal, input.runnerPgid, "SIGTERM");
  await input.wait(500);
  try {
    for (const pgid of await input.enumerate()) known.add(pgid);
  } catch (error) {
    if (await input.alive(input.runnerPgid)) throw error;
  }
  const survivors = new Set(known);
  survivors.add(input.runnerPgid);
  for (const pgid of survivors) {
    if (await input.alive(pgid)) await bestEffortSignal(input.signal, pgid, "SIGKILL");
  }
  await input.wait(50);
  try {
    for (const pgid of await input.enumerate()) known.add(pgid);
  } catch (error) {
    if (await input.alive(input.runnerPgid)) throw error;
  }
  const remaining = new Set([...known, input.runnerPgid]);
  for (const pgid of remaining) {
    if (await input.alive(pgid)) throw new Error("process group cleanup failed");
  }
}

export interface ProcessTreeDependencies {
  readonly listPids: () => Promise<readonly number[]>;
  readonly readStat: (pid: number) => Promise<string>;
}

function parseProcessStat(value: string): {
  readonly parentPid: number;
  readonly processGroup: number;
} {
  const close = value.lastIndexOf(")");
  if (close < 2) throw new Error("process stat is invalid");
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroup)) {
    throw new Error("process stat is invalid");
  }
  return { parentPid, processGroup };
}

function isExitedProcess(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ESRCH";
}

export async function listDescendantProcessGroups(
  rootPid: number,
  dependencies?: ProcessTreeDependencies,
): Promise<readonly number[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const source: ProcessTreeDependencies = dependencies ?? {
    listPids: async () =>
      (await readdir("/proc", { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => Number(entry.name)),
    readStat: async (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
  };
  const processes = new Map<number, ReturnType<typeof parseProcessStat>>();
  for (const pid of await source.listPids()) {
    try {
      processes.set(pid, parseProcessStat(await source.readStat(pid)));
    } catch (error) {
      if (pid === rootPid || !isExitedProcess(error)) throw error;
      // A process may exit between /proc enumeration and its stat read.
    }
  }
  if (!processes.has(rootPid)) throw new Error("runner process is not measurable");
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, process] of processes) {
      if (!descendants.has(pid) && descendants.has(process.parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  const groups = new Set<number>();
  for (const pid of descendants) {
    if (pid === rootPid) continue;
    const group = processes.get(pid)?.processGroup;
    if (group !== undefined && group !== rootPid) groups.add(group);
  }
  return [...groups].sort((left, right) => left - right);
}

function identity(request: EngineCreateJobRequest): string {
  return JSON.stringify(request);
}

export class JobController {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #pendingCreates = new Map<
    string,
    { readonly identity: string; readonly promise: Promise<EngineJobStatus> }
  >();
  readonly #workspaceRoot: string;
  readonly #runner: EngineRunner;
  #acceptingCreates = true;
  #activeJobId: string | null = null;
  readonly #idleWaiters = new Set<() => void>();

  constructor(input: { readonly workspaceRoot: string; readonly runner: EngineRunner }) {
    this.#workspaceRoot = input.workspaceRoot;
    this.#runner = input.runner;
  }

  async create(
    raw: unknown,
  ): Promise<{ readonly replay: boolean; readonly status: EngineJobStatus }> {
    if (!this.#acceptingCreates) throw new EngineUnavailableError();
    const request = engineCreateJobRequestSchema.parse(raw);
    const existing = this.#jobs.get(request.jobId);
    const requestIdentity = identity(request);
    if (existing !== undefined) {
      if (existing.identity !== requestIdentity) throw new JobConflictError();
      return { replay: true, status: existing.status };
    }
    const pending = this.#pendingCreates.get(request.jobId);
    if (pending !== undefined) {
      if (pending.identity !== requestIdentity) throw new JobConflictError();
      return { replay: true, status: await pending.promise };
    }
    const promise = (async (): Promise<EngineJobStatus> => {
      const workspace = await createJobWorkspace(this.#workspaceRoot, request.jobId);
      const status: EngineJobStatus = {
        protocol: 1,
        jobId: request.jobId,
        state: "created",
        phase: null,
        fraction: null,
        sequence: 0,
      };
      try {
        await writeJsonAtomic(workspace.request, request);
        await writeJsonAtomic(workspace.status, status);
        this.#jobs.set(request.jobId, {
          request,
          identity: requestIdentity,
          workspace,
          status,
          inputSha256: null,
          runnerPgid: null,
          codecPgids: new Set(),
        });
        return status;
      } catch (error) {
        await removeJobWorkspace(workspace).catch(() => undefined);
        throw error;
      }
    })();
    this.#pendingCreates.set(request.jobId, { identity: requestIdentity, promise });
    try {
      return { replay: false, status: await promise };
    } finally {
      if (this.#pendingCreates.get(request.jobId)?.promise === promise) {
        this.#pendingCreates.delete(request.jobId);
      }
    }
  }

  get(jobId: string): EngineJobStatus | null {
    return this.#jobs.get(jobId)?.status ?? null;
  }

  get activeJobId(): string | null {
    return this.#activeJobId;
  }

  stopAccepting(): void {
    this.#acceptingCreates = false;
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.#activeJobId === null) return true;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("idle timeout is invalid");
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.#idleWaiters.add(onIdle);
    });
  }

  #releaseActive(jobId: string): void {
    if (this.#activeJobId !== jobId) return;
    this.#activeJobId = null;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  expectedInput(jobId: string): EngineCreateJobRequest["input"] | null {
    return this.#jobs.get(jobId)?.request.input ?? null;
  }

  async upload(jobId: string, stream: Readable): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError();
    if (job.inputSha256 !== null) {
      const replaySha256 = await hashExactInput({
        stream,
        expectedBytes: job.request.input.byteLength,
      });
      if (replaySha256 !== job.inputSha256) throw new JobConflictError();
      return;
    }
    if (job.status.state !== "created") throw new JobConflictError();
    job.status = { ...job.status, state: "uploading", sequence: job.status.sequence + 1 };
    await writeJsonAtomic(job.workspace.status, job.status);
    try {
      job.inputSha256 = await writeExactInput({
        path: job.workspace.input,
        stream,
        expectedBytes: job.request.input.byteLength,
      });
      job.status = {
        protocol: 1,
        jobId,
        state: "ready",
        phase: null,
        fraction: null,
        sequence: job.status.sequence + 1,
      };
      await writeJsonAtomic(job.workspace.status, job.status);
    } catch (error) {
      job.status = {
        protocol: 1,
        jobId,
        state: "created",
        phase: null,
        fraction: null,
        sequence: job.status.sequence + 1,
      };
      await writeJsonAtomic(job.workspace.status, job.status);
      throw error;
    }
  }

  async run(jobId: string): Promise<boolean> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError();
    if (job.status.state === "running" || job.status.state === "succeeded") return true;
    if (job.status.state !== "ready") throw new JobConflictError();
    if (this.#activeJobId !== null && this.#activeJobId !== jobId) throw new EngineBusyError();
    this.#activeJobId = jobId;
    job.status = {
      protocol: 1,
      jobId,
      state: "running",
      phase: "validating",
      fraction: null,
      sequence: job.status.sequence + 1,
    };
    try {
      await writeJsonAtomic(job.workspace.status, job.status);
    } catch (error) {
      this.#releaseActive(jobId);
      throw error;
    }
    let handle: RunnerHandle;
    try {
      handle = await this.#runner.start({
        request: job.request,
        workspace: job.workspace,
        onProcessGroup: (pgid) => job.codecPgids.add(pgid),
        onProcessGroupRemoved: (pgid) => job.codecPgids.delete(pgid),
        onProgress: async (untrustedStatus) => {
          const parsed = engineJobStatusSchema.parse(untrustedStatus) as EngineJobStatus;
          if (
            parsed.state !== "running" ||
            parsed.jobId !== jobId ||
            parsed.sequence <= job.status.sequence ||
            this.#jobs.get(jobId) !== job
          ) {
            throw new Error("runner returned invalid progress");
          }
          await writeJsonAtomic(job.workspace.status, parsed);
          job.status = parsed;
        },
      });
    } catch (error) {
      job.status = crashStatus(jobId, job.status.sequence + 1);
      await writeJsonAtomic(job.workspace.status, job.status).catch(() => undefined);
      await removeJobWorkspace(job.workspace).catch(() => undefined);
      this.#releaseActive(jobId);
      throw error;
    }
    job.runnerPgid = handle.runnerPgid;
    void handle.completion
      .then(async (untrustedStatus) => {
        const status = engineJobStatusSchema.parse(untrustedStatus) as EngineJobStatus;
        if (
          status.jobId !== jobId ||
          !["succeeded", "failed", "cancelled"].includes(status.state) ||
          status.sequence <= job.status.sequence
        ) {
          throw new Error("runner returned an invalid terminal status");
        }
        if (this.#jobs.get(jobId) !== job) return;
        job.status = status;
        await writeJsonAtomic(job.workspace.status, status);
        if (
          status.state === "failed" ||
          status.state === "cancelled" ||
          (status.state === "succeeded" && status.result.kind === "original-retained")
        ) {
          await removeJobWorkspace(job.workspace);
        }
      })
      .catch(async () => {
        if (this.#jobs.get(jobId) !== job) return;
        job.status = crashStatus(jobId, job.status.sequence + 1);
        await writeJsonAtomic(job.workspace.status, job.status).catch(() => undefined);
        await removeJobWorkspace(job.workspace).catch(() => undefined);
      })
      .finally(() => {
        job.runnerPgid = null;
        this.#releaseActive(jobId);
      });
    return false;
  }

  async output(jobId: string): Promise<{
    readonly stream: Readable;
    readonly byteLength: number;
    readonly digest: string;
  } | null> {
    const job = this.#jobs.get(jobId);
    if (job?.status.state !== "succeeded" || job.status.result.kind !== "download") return null;
    const file = await open(job.workspace.output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const information = await file.stat();
      if (!information.isFile() || information.size !== job.status.result.byteLength) {
        throw new Error("verified output mismatch");
      }
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      return {
        stream: file.createReadStream({ autoClose: true, start: 0, end: information.size - 1 }),
        byteLength: information.size,
        digest: `sha-256=${hash.digest("base64")}`,
      };
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  async cancelActive(): Promise<void> {
    const jobId = this.#activeJobId;
    if (jobId !== null) await this.remove(jobId);
  }

  async remove(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    this.#jobs.delete(jobId);
    try {
      if (job.runnerPgid !== null) {
        await terminateProcessGroups({
          runnerPgid: job.runnerPgid,
          registeredCodecPgids: [...job.codecPgids],
          enumerate: () => listDescendantProcessGroups(job.runnerPgid as number),
          signal: async (pgid, value) => {
            process.kill(-pgid, value);
          },
          wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          alive: async (pgid) => {
            try {
              process.kill(-pgid, 0);
              return true;
            } catch {
              return false;
            }
          },
        });
      }
      await removeJobWorkspace(job.workspace);
    } finally {
      this.#releaseActive(jobId);
    }
  }
}

export class JobNotFoundError extends Error {}
export class JobConflictError extends Error {}
export class EngineBusyError extends Error {}
export class EngineUnavailableError extends Error {}
