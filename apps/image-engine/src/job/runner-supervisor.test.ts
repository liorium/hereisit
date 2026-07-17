import type { EngineCreateJobRequest } from "@hereisit/server-contracts";
import { describe, expect, it, vi } from "vitest";
import type { LinuxResourceObservation } from "./resource-monitor";
import {
  parseRunnerRecord,
  resourceFailureStatus,
  startResourceSupervisor,
} from "./runner-supervisor";

const request: EngineCreateJobRequest = {
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

function observation(exceeded: LinuxResourceObservation["exceeded"]): LinuxResourceObservation {
  return {
    exceeded,
    sample: {
      memoryBytes: 20,
      workspaceBytes: 3,
      elapsedMs: 250,
      cpuMs: 4,
      fileDescriptors: 2,
      processes: 2,
      cgroupPidsDelta: 1,
      outputBytes: 0,
    },
    memoryByteMilliseconds: 5_000,
    peakMemoryBytes: 20,
    processGroups: [31],
  };
}

describe("runner protocol and resource supervisor", () => {
  it("accepts strict process-group controls and terminal statuses", () => {
    expect(parseRunnerRecord('{"type":"process-group:add","pgid":31}')).toEqual({
      type: "process-group:add",
      pgid: 31,
    });
    expect(parseRunnerRecord('{"type":"process-group:remove","pgid":31}')).toEqual({
      type: "process-group:remove",
      pgid: 31,
    });
    expect(() => parseRunnerRecord('{"type":"process-group:add","pgid":0}')).toThrow();
    expect(() => parseRunnerRecord('{"type":"unknown","pgid":31}')).toThrow();
  });

  it("samples at the scheduled interval, registers discovered groups, and resolves on breach", async () => {
    let tick: (() => void) | undefined;
    const clear = vi.fn();
    const onProcessGroup = vi.fn();
    const supervisor = startResourceSupervisor({
      sample: vi.fn().mockResolvedValue(observation({ exceeded: "memory" })),
      onProcessGroup,
      schedule: (callback, milliseconds) => {
        expect(milliseconds).toBe(250);
        tick = callback;
        return 7;
      },
      clear,
    });
    tick?.();
    await expect(supervisor.completion).resolves.toMatchObject({
      exceeded: { exceeded: "memory" },
    });
    expect(onProcessGroup).toHaveBeenCalledWith(31);
    supervisor.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });

  it("turns sampler crashes into a terminal measurement breach", async () => {
    let tick: (() => void) | undefined;
    const supervisor = startResourceSupervisor({
      sample: async () => {
        throw new Error("proc unavailable");
      },
      onProcessGroup: vi.fn(),
      schedule: (callback) => {
        tick = callback;
        return 1;
      },
      clear: vi.fn(),
    });
    tick?.();
    await expect(supervisor.completion).resolves.toMatchObject({
      exceeded: { exceeded: "measurement" },
      sample: { measurementFailed: true },
    });
    supervisor.stop();
  });

  it.each([
    ["memory", "ENGINE_OOM", true],
    ["cpu", "ENGINE_TIMEOUT", false],
    ["wall-time", "ENGINE_TIMEOUT", false],
    ["workspace", "ENGINE_CRASH", false],
    ["measurement", "ENGINE_CRASH", false],
  ] as const)("maps %s breaches to a strict terminal failure", (exceeded, code, retryable) => {
    expect(resourceFailureStatus(request, observation({ exceeded }))).toMatchObject({
      protocol: 1,
      jobId: request.jobId,
      state: "failed",
      error: { code, retryable },
      measurements: {
        processedInputBytes: 3,
        cpuMs: 4,
        memoryByteMilliseconds: 5_000,
        peakMemoryBytes: 20,
        processingMs: 250,
      },
    });
  });

  it("places a supervisor failure after the latest runner sequence", () => {
    expect(resourceFailureStatus(request, observation({ exceeded: "memory" }), 9).sequence).toBe(9);
  });
});
