import type { EngineCreateJobRequest, EngineJobStatus } from "@hereisit/server-contracts";
import { describe, expect, it, vi } from "vitest";
import type { LinuxResourceObservation } from "./resource-monitor";
import {
  finalizeRunnerStatus,
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

const succeededStatus: EngineJobStatus = {
  protocol: 1,
  jobId: request.jobId,
  state: "succeeded",
  phase: "preparing-output",
  fraction: 1,
  sequence: 8,
  result: {
    kind: "download",
    mime: "image/jpeg",
    byteLength: 2,
    width: 64,
    height: 64,
    testedCandidates: 2,
    engineBuildId: "engine-1",
    codecBuildId: "codec-1",
    warnings: [],
  },
  inspection: {
    verifiedInputMime: "image/jpeg",
    inputHasAlpha: false,
    contentClass: "photo",
  },
  measurements: {
    processedInputBytes: 3,
    processedPixels: 4_096,
    cpuMs: 0,
    memoryByteMilliseconds: 0,
    peakMemoryBytes: 0,
    testedCandidates: 2,
    processingMs: 100,
  },
};

const unsupportedStatus: EngineJobStatus = {
  protocol: 1,
  jobId: request.jobId,
  state: "failed",
  phase: null,
  fraction: null,
  sequence: 8,
  measurements: succeededStatus.measurements,
  inspection: null,
  error: { code: "UNSUPPORTED_INPUT", retryable: false },
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
    await supervisor.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });

  it("samples immediately so short jobs cannot finish without an observation", async () => {
    const sample = vi.fn().mockResolvedValue(observation(null));
    const supervisor = startResourceSupervisor({
      sample,
      onProcessGroup: vi.fn(),
      schedule: () => 1,
      clear: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sample).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  it("waits for a sample that started before terminal shutdown", async () => {
    let resolveSample!: (value: LinuxResourceObservation) => void;
    const sample = new Promise<LinuxResourceObservation>((resolve) => {
      resolveSample = resolve;
    });
    const acceptObservation = vi.fn();
    const supervisor = startResourceSupervisor({
      sample: () => sample,
      onProcessGroup: vi.fn(),
      acceptObservation,
      schedule: () => 1,
      clear: vi.fn(),
    });

    let stopped = false;
    const stopping = supervisor.stop().then((latestObservation) => {
      stopped = true;
      return latestObservation;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveSample(observation({ exceeded: "memory" }));
    await expect(stopping).resolves.toMatchObject({ exceeded: { exceeded: "memory" } });
    expect(acceptObservation).toHaveBeenCalledWith(
      expect.objectContaining({ exceeded: { exceeded: "memory" } }),
    );
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
    await new Promise((resolve) => setImmediate(resolve));
    tick?.();
    await expect(supervisor.completion).resolves.toMatchObject({
      exceeded: { exceeded: "measurement" },
      sample: { measurementFailed: true },
    });
    await supervisor.stop();
  });

  it("ignores a late measurement failure after the runner has reported terminal status", async () => {
    let tick: (() => void) | undefined;
    let acceptObservation = true;
    let resolveSample!: (value: LinuxResourceObservation) => void;
    const sample = new Promise<LinuxResourceObservation>((resolve) => {
      resolveSample = resolve;
    });
    const supervisor = startResourceSupervisor({
      sample: () => sample,
      onProcessGroup: vi.fn(),
      acceptObservation: () => acceptObservation,
      schedule: (callback) => {
        tick = callback;
        return 1;
      },
      clear: vi.fn(),
    });
    tick?.();
    acceptObservation = false;
    resolveSample(observation({ exceeded: "measurement" }));
    await Promise.resolve();
    await Promise.resolve();
    let settled = false;
    void supervisor.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await supervisor.stop();
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

  it("publishes observed CPU and memory without replacing runner-owned measurements", () => {
    expect(finalizeRunnerStatus(request, succeededStatus, observation(null))).toMatchObject({
      state: "succeeded",
      sequence: 8,
      result: succeededStatus.result,
      inspection: succeededStatus.inspection,
      measurements: {
        processedInputBytes: 3,
        processedPixels: 4_096,
        cpuMs: 4,
        memoryByteMilliseconds: 5_000,
        peakMemoryBytes: 20,
        testedCandidates: 2,
        processingMs: 250,
      },
    });
  });

  it("fails closed when a terminal runner status has no accepted observation", () => {
    expect(finalizeRunnerStatus(request, succeededStatus, null)).toMatchObject({
      state: "failed",
      sequence: 9,
      error: { code: "ENGINE_CRASH", retryable: false },
    });
  });

  it("preserves a concrete runner failure when no observation was measurable", () => {
    expect(finalizeRunnerStatus(request, unsupportedStatus, null)).toEqual(unsupportedStatus);
  });

  it("preserves a concrete runner failure when the final measurement failed", () => {
    expect(
      finalizeRunnerStatus(request, unsupportedStatus, observation({ exceeded: "measurement" })),
    ).toEqual(unsupportedStatus);
  });

  it("prioritizes a real resource breach over a runner failure", () => {
    expect(
      finalizeRunnerStatus(request, unsupportedStatus, observation({ exceeded: "memory" })),
    ).toMatchObject({ state: "failed", sequence: 9, error: { code: "ENGINE_OOM" } });
  });

  it("prioritizes a non-memory breach even when peak memory is zero", () => {
    expect(
      finalizeRunnerStatus(request, unsupportedStatus, {
        ...observation({ exceeded: "cpu" }),
        peakMemoryBytes: 0,
      }),
    ).toMatchObject({ state: "failed", sequence: 9, error: { code: "ENGINE_TIMEOUT" } });
  });

  it("fails closed when peak memory was not measured", () => {
    expect(
      finalizeRunnerStatus(request, succeededStatus, {
        ...observation(null),
        peakMemoryBytes: 0,
      }),
    ).toMatchObject({
      state: "failed",
      sequence: 9,
      error: { code: "ENGINE_CRASH", retryable: false },
    });
  });
});
