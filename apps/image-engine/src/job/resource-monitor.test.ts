import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxResourceSampler,
  createResourceMonitor,
  readCgroupSnapshot,
  readDescendantMetrics,
  readWorkspaceBytes,
  resolveCgroupV2Directory,
  resourcePolicies,
} from "./resource-monitor";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("engine resource monitor", () => {
  it("publishes the exact standard and large policies", () => {
    expect(resourcePolicies["image-standard-v1"]).toMatchObject({
      wallMs: 60_000,
      cpuMs: 45_000,
      memoryDeltaBytes: 768 * 1024 ** 2,
    });
    expect(resourcePolicies["image-large-v1"]).toMatchObject({
      wallMs: 90_000,
      cpuMs: 75_000,
      memoryDeltaBytes: 1536 * 1024 ** 2,
    });
  });

  it.each([
    ["memory", { memoryBytes: 768 * 1024 ** 2 + 1 }],
    ["workspace", { workspaceBytes: 1024 ** 3 + 1 }],
    ["wall-time", { elapsedMs: 60_001 }],
    ["cpu", { cpuMs: 45_001 }],
    ["file-descriptors", { fileDescriptors: 65 }],
    ["processes", { processes: 9 }],
    ["threads", { cgroupPidsDelta: 129 }],
  ] as const)("fails closed on %s", (exceeded, sample) => {
    const monitor = createResourceMonitor("image-standard-v1");
    expect(monitor.sample(sample)).toEqual({ exceeded });
  });

  it("refuses output larger than its source and missing safety measurements", () => {
    const monitor = createResourceMonitor("image-standard-v1", { sourceBytes: 100 });
    expect(monitor.sample({ outputBytes: 101 })).toEqual({ exceeded: "output" });
    expect(monitor.sample({ measurementFailed: true })).toEqual({ exceeded: "measurement" });
  });

  it("resolves only a unified cgroup-v2 path beneath the mount root", () => {
    expect(resolveCgroupV2Directory("0::/containers/engine\n", "/sys/fs/cgroup")).toBe(
      "/sys/fs/cgroup/containers/engine",
    );
    expect(() => resolveCgroupV2Directory("7:cpu:/legacy\n", "/sys/fs/cgroup")).toThrow();
    expect(() => resolveCgroupV2Directory("0::/../../escape\n", "/sys/fs/cgroup")).toThrow();
  });

  it("walks workspace regular files without following symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-resource-workspace-"));
    roots.push(root);
    const external = join(tmpdir(), `hereisit-resource-external-${process.pid}`);
    await writeFile(join(root, "input.bin"), Buffer.alloc(3));
    await writeFile(external, Buffer.alloc(100));
    await symlink(external, join(root, "escape"));
    try {
      await expect(readWorkspaceBytes(root)).resolves.toBe(3);
    } finally {
      await rm(external, { force: true });
    }
  });

  it("measures every descendant process, file descriptor, memory, and CPU tick", async () => {
    const procStat = (
      pid: number,
      name: string,
      parentPid: number,
      processGroup: number,
      userTicks: number,
      systemTicks: number,
    ) =>
      `${pid} (${name}) S ${parentPid} ${processGroup} ${processGroup} 0 0 0 0 0 0 0 ${userTicks} ${systemTicks}`;
    const stats = new Map([
      [10, procStat(10, "runner", 1, 10, 7, 3)],
      [11, procStat(11, "codec with spaces", 10, 11, 5, 2)],
      [12, procStat(12, "helper", 11, 11, 2, 1)],
      [20, procStat(20, "unrelated", 1, 20, 99, 99)],
    ]);
    const metrics = await readDescendantMetrics(10, {
      listPids: async () => [10, 11, 12, 20],
      readStat: async (pid) => stats.get(pid) ?? "",
      countFileDescriptors: async (pid) => ({ 10: 2, 11: 3, 12: 4 })[pid] ?? 0,
      readSmapsRollup: async (pid) => `Rss: ${pid} kB\nPss: 1 kB\n`,
    });
    expect(metrics).toEqual({
      processes: 3,
      fileDescriptors: 9,
      memoryBytes: (10 + 11 + 12) * 1024,
      cpuTicks: 20,
      processGroups: [11],
    });
  });

  it("fails closed on proc inspection errors that are not process-exit races", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      readDescendantMetrics(10, {
        listPids: async () => [10, 11],
        readStat: async (pid) => {
          if (pid === 11) throw denied;
          return "10 (runner) S 1 10 10 0 0 0 0 0 0 0 1 1";
        },
        countFileDescriptors: async () => 1,
        readSmapsRollup: async () => "Rss: 1 kB\n",
      }),
    ).rejects.toThrow("denied");
  });

  it("parses cgroup-v2 memory, CPU, and thread-inclusive pids counters", async () => {
    const files = new Map([
      ["/group/memory.current", "1234\n"],
      ["/group/cpu.stat", "usage_usec 5678\nuser_usec 5000\nsystem_usec 678\n"],
      ["/group/pids.current", "9\n"],
    ]);
    await expect(
      readCgroupSnapshot("/group", async (path) => files.get(path) ?? ""),
    ).resolves.toEqual({ directory: "/group", memoryBytes: 1234, cpuUsec: 5678, pids: 9 });
  });

  it("samples cgroup deltas plus the complete process tree and accumulates memory time", async () => {
    const sampler = createLinuxResourceSampler({
      resourceClass: "image-standard-v1",
      runnerPid: 10,
      workspaceRoot: "/job",
      outputPath: "/job/output.bin",
      sourceBytes: 100,
      startNs: 0n,
      cgroupBaseline: { directory: "/group", memoryBytes: 100, cpuUsec: 1_000, pids: 2 },
      dependencies: {
        nowNs: () => 250_000_000n,
        readCgroup: async () => ({
          directory: "/group",
          memoryBytes: 200,
          cpuUsec: 2_000,
          pids: 4,
        }),
        readDescendants: async () => ({
          processes: 2,
          fileDescriptors: 3,
          memoryBytes: 999,
          cpuTicks: 99,
          processGroups: [11],
        }),
        readWorkspace: async () => 10,
        readOutput: async () => 5,
      },
    });
    await expect(sampler.sample()).resolves.toEqual({
      exceeded: null,
      sample: {
        memoryBytes: 100,
        workspaceBytes: 10,
        elapsedMs: 250,
        cpuMs: 1,
        fileDescriptors: 3,
        processes: 2,
        cgroupPidsDelta: 2,
        outputBytes: 5,
      },
      memoryByteMilliseconds: 25_000,
      peakMemoryBytes: 100,
      processGroups: [11],
    });
  });

  it("uses full proc memory and CPU fallback when cgroup counters disappear", async () => {
    const sampler = createLinuxResourceSampler({
      resourceClass: "image-standard-v1",
      runnerPid: 10,
      workspaceRoot: "/job",
      outputPath: "/job/output.bin",
      sourceBytes: 100,
      startNs: 0n,
      cgroupBaseline: { directory: "/group", memoryBytes: 100, cpuUsec: 1_000, pids: 2 },
      clockTicksPerSecond: 100,
      dependencies: {
        nowNs: () => 250_000_000n,
        readCgroup: async () => {
          throw new Error("cgroup removed");
        },
        readDescendants: async () => ({
          processes: 1,
          fileDescriptors: 2,
          memoryBytes: 512,
          cpuTicks: 20,
          processGroups: [],
        }),
        readWorkspace: async () => 3,
        readOutput: async () => 0,
      },
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      exceeded: null,
      sample: { memoryBytes: 512, cpuMs: 200, cgroupPidsDelta: undefined },
    });
  });
});
