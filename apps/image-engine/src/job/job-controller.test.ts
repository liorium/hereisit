import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { EngineCreateJobRequest, EngineJobStatus } from "@hereisit/server-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineBusyError,
  type EngineRunner,
  EngineUnavailableError,
  JobController,
  listDescendantProcessGroups,
  terminateProcessGroups,
} from "./job-controller";

const baseRequest: EngineCreateJobRequest = {
  protocol: 1,
  jobId: "123e4567-e89b-42d3-a456-426614174001",
  attempt: 1,
  tool: "image.optimize",
  toolVersion: 1,
  spec: {
    version: 1,
    mode: "smart",
    preset: "balanced",
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  },
  specHash: "a".repeat(64),
  input: { byteLength: 3, etag: "opaque-r2-version", mimeHint: "image/jpeg" },
  resourceClass: "image-standard-v1",
};

function terminalFailure(jobId: string): EngineJobStatus {
  return {
    protocol: 1,
    jobId,
    state: "failed",
    phase: null,
    fraction: null,
    sequence: 4,
    measurements: {
      processedInputBytes: 3,
      processedPixels: 1,
      cpuMs: 1,
      memoryByteMilliseconds: 1,
      peakMemoryBytes: 1,
      testedCandidates: 1,
      processingMs: 1,
    },
    inspection: null,
    error: { code: "ENGINE_CRASH", retryable: true },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ready(controller: JobController, request: EngineCreateJobRequest): Promise<void> {
  await controller.create(request);
  await controller.upload(request.jobId, Readable.from([Uint8Array.of(1, 2, 3)]));
}

describe("detached process-group cleanup", () => {
  it("terminates codec groups before the runner and kills every survivor after re-enumeration", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const dead = new Set([31]);
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce([31, 32])
      .mockResolvedValueOnce([32, 40])
      .mockResolvedValueOnce([]);
    await terminateProcessGroups({
      runnerPgid: 20,
      registeredCodecPgids: [31, 32],
      enumerate,
      signal: async (pgid, value) => {
        signals.push([pgid, value]);
        if (value === "SIGKILL") dead.add(pgid);
      },
      wait: vi.fn().mockResolvedValue(undefined),
      alive: async (pgid) => !dead.has(pgid),
    });
    expect(signals).toEqual([
      [31, "SIGTERM"],
      [32, "SIGTERM"],
      [20, "SIGTERM"],
      [32, "SIGKILL"],
      [40, "SIGKILL"],
      [20, "SIGKILL"],
    ]);
  });

  it("verifies every known group even when the killed runner disappears from proc", async () => {
    const alive = new Set([20, 31]);
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce([31])
      .mockResolvedValueOnce([31])
      .mockRejectedValueOnce(new Error("runner process is not measurable"));
    await expect(
      terminateProcessGroups({
        runnerPgid: 20,
        registeredCodecPgids: [31],
        enumerate,
        signal: async (pgid, signal) => {
          if (signal === "SIGKILL") alive.delete(pgid);
        },
        wait: vi.fn().mockResolvedValue(undefined),
        alive: async (pgid) => alive.has(pgid),
      }),
    ).resolves.toBeUndefined();
  });

  it("parses a complete proc tree including names with spaces", async () => {
    const files = new Map([
      ["/proc/20/stat", "20 (runner process) S 1 20 20 0 0"],
      ["/proc/21/stat", "21 (codec one) S 20 21 20 0 0"],
      ["/proc/22/stat", "22 (helper) S 21 21 20 0 0"],
      ["/proc/30/stat", "30 (unrelated) S 1 30 30 0 0"],
    ]);
    await expect(
      listDescendantProcessGroups(20, {
        listPids: async () => [20, 21, 22, 30],
        readStat: async (pid) => files.get(`/proc/${pid}/stat`) ?? "",
      }),
    ).resolves.toEqual([21]);
  });

  it("fails closed when proc inspection fails for reasons other than an exit race", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      listDescendantProcessGroups(20, {
        listPids: async () => [20, 21],
        readStat: async (pid) => {
          if (pid === 21) throw denied;
          return "20 (runner) S 1 20 20 0 0";
        },
      }),
    ).rejects.toThrow("denied");
  });

  it("kills an actual stubborn detached runner, codec, and grandchild tree", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/stubborn-process-tree.mjs", import.meta.url));
    const child = spawn(process.execPath, [fixture, "runner"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (child.pid === undefined || child.stdout === null) throw new Error("fixture spawn failed");
    const runnerPgid = child.pid;
    const alive = async (pgid: number) => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signal = async (pgid: number, value: NodeJS.Signals) => {
      process.kill(-pgid, value);
    };
    const wait = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    const ready = new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    const discovered = new Set<number>();
    try {
      await ready;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        for (const pgid of await listDescendantProcessGroups(runnerPgid)) {
          discovered.add(pgid);
        }
        if (discovered.size >= 2) break;
        await wait(20);
      }
      expect(discovered.size).toBeGreaterThanOrEqual(2);
      await terminateProcessGroups({
        runnerPgid,
        registeredCodecPgids: [...discovered],
        enumerate: () => listDescendantProcessGroups(runnerPgid),
        signal,
        wait,
        alive,
      });
      await expect(alive(runnerPgid)).resolves.toBe(false);
      for (const pgid of discovered) await expect(alive(pgid)).resolves.toBe(false);
    } finally {
      for (const pgid of [...discovered, runnerPgid]) {
        await signal(pgid, "SIGKILL").catch(() => undefined);
      }
    }
  }, 10_000);
});

describe("engine admission and single-job lifecycle", () => {
  it("allows only one active runner and releases the slot after terminal completion", async () => {
    const completions = new Map<string, ReturnType<typeof deferred<EngineJobStatus>>>();
    const runner: EngineRunner = {
      start: ({ request }) => {
        const completion = deferred<EngineJobStatus>();
        completions.set(request.jobId, completion);
        return { runnerPgid: 999_999, completion: completion.promise };
      },
    };
    const root = await mkdtemp(join(tmpdir(), "hereisit-engine-controller-"));
    roots.push(root);
    const controller = new JobController({ workspaceRoot: root, runner });
    const second = {
      ...baseRequest,
      jobId: "123e4567-e89b-42d3-a456-426614174002",
      specHash: "b".repeat(64),
    } satisfies EngineCreateJobRequest;
    await ready(controller, baseRequest);
    await ready(controller, second);

    await controller.run(baseRequest.jobId);
    await expect(controller.run(second.jobId)).rejects.toBeInstanceOf(EngineBusyError);
    completions.get(baseRequest.jobId)?.resolve(terminalFailure(baseRequest.jobId));
    await expect.poll(() => controller.activeJobId).toBeNull();
    await expect(controller.run(second.jobId)).resolves.toBe(false);
    completions.get(second.jobId)?.resolve(terminalFailure(second.jobId));
  });

  it("rejects new creates during rollout shutdown and reports whether grace reached idle", async () => {
    const completion = deferred<EngineJobStatus>();
    const root = await mkdtemp(join(tmpdir(), "hereisit-engine-controller-"));
    roots.push(root);
    const controller = new JobController({
      workspaceRoot: root,
      runner: { start: () => ({ runnerPgid: 999_999, completion: completion.promise }) },
    });
    await ready(controller, baseRequest);
    await controller.run(baseRequest.jobId);

    controller.stopAccepting();
    await expect(
      controller.create({ ...baseRequest, jobId: "123e4567-e89b-42d3-a456-426614174003" }),
    ).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(controller.waitForIdle(1)).resolves.toBe(false);
    completion.resolve(terminalFailure(baseRequest.jobId));
    await expect(controller.waitForIdle(100)).resolves.toBe(true);
  });

  it("records a terminal failure and cleans the workspace when runner startup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-engine-controller-"));
    roots.push(root);
    const controller = new JobController({
      workspaceRoot: root,
      runner: {
        start: async () => {
          throw new Error("spawn failed");
        },
      },
    });
    await ready(controller, baseRequest);
    await expect(controller.run(baseRequest.jobId)).rejects.toThrow("spawn failed");
    expect(controller.get(baseRequest.jobId)).toMatchObject({
      state: "failed",
      error: { code: "ENGINE_CRASH", retryable: true },
    });
    expect(controller.activeJobId).toBeNull();
  });
});
