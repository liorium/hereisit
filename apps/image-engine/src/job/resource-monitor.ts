import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ImageResourceClass } from "@hereisit/server-contracts";

export const resourcePolicies = {
  "image-standard-v1": {
    wallMs: 60_000,
    cpuMs: 45_000,
    workspaceBytes: 1024 ** 3,
    memoryDeltaBytes: 768 * 1024 ** 2,
    maxFileDescriptors: 64,
    maxProcesses: 8,
  },
  "image-large-v1": {
    wallMs: 90_000,
    cpuMs: 75_000,
    workspaceBytes: 2 * 1024 ** 3,
    memoryDeltaBytes: 1536 * 1024 ** 2,
    maxFileDescriptors: 64,
    maxProcesses: 8,
  },
} as const;

export type ResourceExceeded =
  | "memory"
  | "workspace"
  | "wall-time"
  | "cpu"
  | "file-descriptors"
  | "processes"
  | "threads"
  | "output"
  | "measurement";

export interface ResourceSample {
  readonly memoryBytes?: number;
  readonly workspaceBytes?: number;
  readonly elapsedMs?: number;
  readonly cpuMs?: number;
  readonly fileDescriptors?: number;
  readonly processes?: number;
  readonly cgroupPidsDelta?: number | undefined;
  readonly outputBytes?: number;
  readonly measurementFailed?: boolean;
}

export interface DescendantMetrics {
  readonly processes: number;
  readonly fileDescriptors: number;
  readonly memoryBytes: number;
  readonly cpuTicks: number;
  readonly processGroups: readonly number[];
}

export interface DescendantMetricDependencies {
  readonly listPids: () => Promise<readonly number[]>;
  readonly readStat: (pid: number) => Promise<string>;
  readonly countFileDescriptors: (pid: number) => Promise<number>;
  readonly readSmapsRollup: (pid: number) => Promise<string>;
}

interface ParsedProcStat {
  readonly parentPid: number;
  readonly processGroup: number;
  readonly cpuTicks: number;
}

function parseProcStat(value: string): ParsedProcStat {
  const close = value.lastIndexOf(")");
  if (close < 2) throw new Error("process stat is invalid");
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  if (
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(processGroup) ||
    !Number.isFinite(userTicks) ||
    userTicks < 0 ||
    !Number.isFinite(systemTicks) ||
    systemTicks < 0
  ) {
    throw new Error("process stat is invalid");
  }
  return { parentPid, processGroup, cpuTicks: userTicks + systemTicks };
}

function isProcessExitRace(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ESRCH";
}

function parseRssBytes(value: string): number {
  const match = /^Rss:\s+(\d+)\s+kB$/m.exec(value);
  if (match === null) throw new Error("process memory is not measurable");
  const kibibytes = Number(match[1]);
  const bytes = kibibytes * 1024;
  if (!Number.isSafeInteger(bytes)) throw new Error("process memory is invalid");
  return bytes;
}

export async function readDescendantMetrics(
  rootPid: number,
  dependencies?: DescendantMetricDependencies,
): Promise<DescendantMetrics> {
  const source: DescendantMetricDependencies = dependencies ?? {
    listPids: async () =>
      (await readdir("/proc", { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => Number(entry.name)),
    readStat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
    countFileDescriptors: async (pid) => (await readdir(`/proc/${pid}/fd`)).length,
    readSmapsRollup: (pid) => readFile(`/proc/${pid}/smaps_rollup`, "utf8"),
  };
  const processes = new Map<number, ParsedProcStat>();
  for (const pid of await source.listPids()) {
    try {
      processes.set(pid, parseProcStat(await source.readStat(pid)));
    } catch (error) {
      if (pid === rootPid || !isProcessExitRace(error)) throw error;
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
  let fileDescriptors = 0;
  let memoryBytes = 0;
  let cpuTicks = 0;
  const processGroups = new Set<number>();
  for (const pid of descendants) {
    try {
      const process = processes.get(pid);
      if (process === undefined) throw new Error("process tree changed unexpectedly");
      fileDescriptors += await source.countFileDescriptors(pid);
      memoryBytes += parseRssBytes(await source.readSmapsRollup(pid));
      cpuTicks += process.cpuTicks;
      if (pid !== rootPid && process.processGroup !== rootPid) {
        processGroups.add(process.processGroup);
      }
    } catch (error) {
      if (!isProcessExitRace(error)) throw error;
    }
  }
  if (
    !Number.isSafeInteger(fileDescriptors) ||
    !Number.isSafeInteger(memoryBytes) ||
    !Number.isFinite(cpuTicks)
  ) {
    throw new Error("process metrics are invalid");
  }
  return {
    processes: descendants.size,
    fileDescriptors,
    memoryBytes,
    cpuTicks,
    processGroups: [...processGroups].sort((left, right) => left - right),
  };
}

export async function readWorkspaceBytes(root: string): Promise<number> {
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    const information = await lstat(path);
    if (information.isSymbolicLink()) return;
    if (information.isFile()) {
      bytes += information.size;
      if (!Number.isSafeInteger(bytes)) throw new Error("workspace size is invalid");
      return;
    }
    if (!information.isDirectory()) return;
    for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(resolve(root));
  return bytes;
}

export function resolveCgroupV2Directory(procSelfCgroup: string, mountRoot: string): string {
  const unified = procSelfCgroup.split(/\r?\n/).find((line) => line.startsWith("0::"));
  if (unified === undefined) throw new Error("unified cgroup-v2 is unavailable");
  const cgroupPath = unified.slice(3);
  if (!cgroupPath.startsWith("/") || cgroupPath.includes("\0")) {
    throw new Error("cgroup-v2 path is invalid");
  }
  const root = resolve(mountRoot);
  const directory = resolve(root, `.${cgroupPath}`);
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new Error("cgroup-v2 path escapes its mount");
  }
  return directory;
}

export interface CgroupSnapshot {
  readonly directory: string;
  readonly memoryBytes: number;
  readonly cpuUsec: number;
  readonly pids: number;
}

function parseCounter(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

export async function readCgroupSnapshot(
  directory: string,
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<CgroupSnapshot> {
  const [memory, cpu, pids] = await Promise.all([
    readText(join(directory, "memory.current")),
    readText(join(directory, "cpu.stat")),
    readText(join(directory, "pids.current")),
  ]);
  const usage = /^usage_usec\s+(\d+)$/m.exec(cpu)?.[1];
  if (usage === undefined) throw new Error("cgroup CPU usage is unavailable");
  return {
    directory,
    memoryBytes: parseCounter(memory, "cgroup memory"),
    cpuUsec: parseCounter(usage, "cgroup CPU"),
    pids: parseCounter(pids, "cgroup pids"),
  };
}

export async function captureCgroupBaseline(
  mountRoot = "/sys/fs/cgroup",
): Promise<CgroupSnapshot | null> {
  try {
    const membership = await readFile("/proc/self/cgroup", "utf8");
    return await readCgroupSnapshot(resolveCgroupV2Directory(membership, mountRoot));
  } catch {
    return null;
  }
}

export interface LinuxResourceSamplerDependencies {
  readonly nowNs: () => bigint;
  readonly readCgroup: (directory: string) => Promise<CgroupSnapshot>;
  readonly readDescendants: (rootPid: number) => Promise<DescendantMetrics>;
  readonly readWorkspace: (root: string) => Promise<number>;
  readonly readOutput: (path: string) => Promise<number>;
}

export interface LinuxResourceObservation {
  readonly exceeded: { readonly exceeded: ResourceExceeded } | null;
  readonly sample: ResourceSample;
  readonly memoryByteMilliseconds: number;
  readonly peakMemoryBytes: number;
  readonly processGroups: readonly number[];
}

async function readOutputBytes(path: string): Promise<number> {
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new Error("output is not a regular file");
    }
    return information.size;
  } catch (error) {
    if (isProcessExitRace(error)) return 0;
    throw error;
  }
}

export function createLinuxResourceSampler(input: {
  readonly resourceClass: ImageResourceClass;
  readonly runnerPid: number;
  readonly workspaceRoot: string;
  readonly outputPath: string;
  readonly sourceBytes: number;
  readonly startNs?: bigint;
  readonly cgroupBaseline: CgroupSnapshot | null;
  readonly clockTicksPerSecond?: number;
  readonly dependencies?: Partial<LinuxResourceSamplerDependencies>;
}) {
  const dependencies: LinuxResourceSamplerDependencies = {
    nowNs: input.dependencies?.nowNs ?? (() => process.hrtime.bigint()),
    readCgroup: input.dependencies?.readCgroup ?? readCgroupSnapshot,
    readDescendants: input.dependencies?.readDescendants ?? readDescendantMetrics,
    readWorkspace: input.dependencies?.readWorkspace ?? readWorkspaceBytes,
    readOutput: input.dependencies?.readOutput ?? readOutputBytes,
  };
  const startNs = input.startNs ?? dependencies.nowNs();
  let previousNs = startNs;
  let memoryByteMilliseconds = 0;
  let peakMemoryBytes = 0;
  const clockTicksPerSecond = input.clockTicksPerSecond ?? 100;
  if (!Number.isFinite(clockTicksPerSecond) || clockTicksPerSecond <= 0) {
    throw new RangeError("clock tick frequency is invalid");
  }
  const monitor = createResourceMonitor(input.resourceClass, { sourceBytes: input.sourceBytes });

  return {
    async sample(): Promise<LinuxResourceObservation> {
      const nowNs = dependencies.nowNs();
      if (nowNs < previousNs || nowNs < startNs) throw new Error("monotonic clock moved backwards");
      try {
        const [descendants, workspaceBytes, outputBytes] = await Promise.all([
          dependencies.readDescendants(input.runnerPid),
          dependencies.readWorkspace(input.workspaceRoot),
          dependencies.readOutput(input.outputPath),
        ]);
        let memoryBytes = descendants.memoryBytes;
        let cpuMs = (descendants.cpuTicks * 1000) / clockTicksPerSecond;
        let cgroupPidsDelta: number | undefined;
        if (input.cgroupBaseline !== null) {
          try {
            const current = await dependencies.readCgroup(input.cgroupBaseline.directory);
            const memoryDelta = current.memoryBytes - input.cgroupBaseline.memoryBytes;
            const cpuDelta = current.cpuUsec - input.cgroupBaseline.cpuUsec;
            const pidsDelta = current.pids - input.cgroupBaseline.pids;
            if (memoryDelta < 0 || cpuDelta < 0 || pidsDelta < 0) {
              throw new Error("cgroup counters moved backwards");
            }
            memoryBytes = memoryDelta;
            cpuMs = cpuDelta / 1000;
            cgroupPidsDelta = pidsDelta;
          } catch {
            // The complete /proc tree above remains the fail-closed memory/CPU fallback.
          }
        }
        const elapsedMs = Number(nowNs - startNs) / 1_000_000;
        const intervalMs = Number(nowNs - previousNs) / 1_000_000;
        memoryByteMilliseconds += memoryBytes * intervalMs;
        peakMemoryBytes = Math.max(peakMemoryBytes, memoryBytes);
        if (
          !Number.isFinite(memoryByteMilliseconds) ||
          !Number.isSafeInteger(Math.ceil(memoryByteMilliseconds))
        ) {
          throw new Error("memory time is invalid");
        }
        previousNs = nowNs;
        const sample: ResourceSample = {
          memoryBytes,
          workspaceBytes,
          elapsedMs,
          cpuMs,
          fileDescriptors: descendants.fileDescriptors,
          processes: descendants.processes,
          cgroupPidsDelta,
          outputBytes,
        };
        return {
          exceeded: monitor.sample(sample),
          sample,
          memoryByteMilliseconds,
          peakMemoryBytes,
          processGroups: descendants.processGroups,
        };
      } catch {
        const sample: ResourceSample = { measurementFailed: true };
        return {
          exceeded: monitor.sample(sample),
          sample,
          memoryByteMilliseconds,
          peakMemoryBytes,
          processGroups: [],
        };
      }
    },
  };
}

function exceeded(value: number | undefined, limit: number): boolean {
  return value !== undefined && (!Number.isFinite(value) || value < 0 || value > limit);
}

export function createResourceMonitor(
  resourceClass: ImageResourceClass,
  options: { readonly sourceBytes?: number } = {},
) {
  const policy = resourcePolicies[resourceClass];
  return {
    sample(sample: ResourceSample): { readonly exceeded: ResourceExceeded } | null {
      if (sample.measurementFailed === true) return { exceeded: "measurement" };
      if (exceeded(sample.memoryBytes, policy.memoryDeltaBytes)) return { exceeded: "memory" };
      if (exceeded(sample.workspaceBytes, policy.workspaceBytes)) return { exceeded: "workspace" };
      if (exceeded(sample.elapsedMs, policy.wallMs)) return { exceeded: "wall-time" };
      if (exceeded(sample.cpuMs, policy.cpuMs)) return { exceeded: "cpu" };
      if (exceeded(sample.fileDescriptors, policy.maxFileDescriptors)) {
        return { exceeded: "file-descriptors" };
      }
      if (exceeded(sample.processes, policy.maxProcesses)) return { exceeded: "processes" };
      if (exceeded(sample.cgroupPidsDelta, 128)) return { exceeded: "threads" };
      if (options.sourceBytes !== undefined && exceeded(sample.outputBytes, options.sourceBytes)) {
        return { exceeded: "output" };
      }
      return null;
    },
  };
}
