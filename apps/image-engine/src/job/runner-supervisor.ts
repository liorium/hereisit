import {
  type EngineCreateJobRequest,
  type EngineJobStatus,
  engineJobStatusSchema,
} from "@hereisit/server-contracts";
import type { LinuxResourceObservation } from "./resource-monitor";

export type RunnerControlRecord =
  | { readonly type: "process-group:add"; readonly pgid: number }
  | { readonly type: "process-group:remove"; readonly pgid: number };

export type RunnerRecord = RunnerControlRecord | EngineJobStatus;

export function parseRunnerRecord(line: string): RunnerRecord {
  const value: unknown = JSON.parse(line);
  if (typeof value === "object" && value !== null && "type" in value) {
    const keys = Object.keys(value);
    const type = Reflect.get(value, "type");
    const pgid = Reflect.get(value, "pgid");
    if (
      keys.length !== 2 ||
      (type !== "process-group:add" && type !== "process-group:remove") ||
      !Number.isSafeInteger(pgid) ||
      (pgid as number) < 1
    ) {
      throw new TypeError("runner control record is invalid");
    }
    return { type, pgid: pgid as number };
  }
  return engineJobStatusSchema.parse(value) as EngineJobStatus;
}

export function startResourceSupervisor(input: {
  readonly sample: () => Promise<LinuxResourceObservation>;
  readonly onProcessGroup: (pgid: number) => void;
  readonly acceptObservation?: (
    observation: LinuxResourceObservation,
  ) => boolean | Promise<boolean>;
  readonly schedule?: (callback: () => void, milliseconds: number) => unknown;
  readonly clear?: (handle: unknown) => void;
}) {
  const schedule =
    input.schedule ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clear = input.clear ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let settled = false;
  let sampling = false;
  let stopped = false;
  let currentSample: Promise<void> = Promise.resolve();
  let latestObservation: LinuxResourceObservation | null = null;
  let consecutiveMeasurementFailures = 0;
  let resolveCompletion!: (observation: LinuxResourceObservation) => void;
  const completion = new Promise<LinuxResourceObservation>((resolve) => {
    resolveCompletion = resolve;
  });
  const tick = () => {
    if (settled || sampling) return;
    sampling = true;
    currentSample = input
      .sample()
      .then(async (observation) => {
        if ((await input.acceptObservation?.(observation)) === false) return;
        if (observation.exceeded?.exceeded === "measurement") {
          consecutiveMeasurementFailures += 1;
          if (consecutiveMeasurementFailures < 2) return;
        } else {
          consecutiveMeasurementFailures = 0;
        }
        latestObservation = observation;
        for (const pgid of observation.processGroups) input.onProcessGroup(pgid);
        if (observation.exceeded !== null && !settled) {
          settled = true;
          resolveCompletion(observation);
        }
      })
      .catch(async () => {
        const observation: LinuxResourceObservation = {
          exceeded: { exceeded: "measurement" },
          sample: { measurementFailed: true },
          memoryByteMilliseconds: 0,
          peakMemoryBytes: 0,
          processGroups: [],
        };
        if ((await input.acceptObservation?.(observation)) === false) return;
        consecutiveMeasurementFailures += 1;
        if (consecutiveMeasurementFailures < 2) return;
        if (settled) return;
        latestObservation = observation;
        settled = true;
        resolveCompletion(observation);
      })
      .finally(() => {
        sampling = false;
      });
  };
  const handle = schedule(tick, 250);
  tick();
  return {
    completion,
    async stop(): Promise<LinuxResourceObservation | null> {
      if (!stopped) {
        stopped = true;
        settled = true;
        clear(handle);
      }
      await currentSample;
      return latestObservation;
    },
  };
}

function rounded(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

export function resourceFailureStatus(
  request: EngineCreateJobRequest,
  observation: LinuxResourceObservation,
  sequence = 2,
): EngineJobStatus {
  const exceeded = observation.exceeded?.exceeded ?? "measurement";
  const code =
    exceeded === "memory"
      ? "ENGINE_OOM"
      : exceeded === "cpu" || exceeded === "wall-time"
        ? "ENGINE_TIMEOUT"
        : "ENGINE_CRASH";
  return {
    protocol: 1,
    jobId: request.jobId,
    state: "failed",
    phase: null,
    fraction: null,
    sequence,
    measurements: {
      processedInputBytes: request.input.byteLength,
      processedPixels: 0,
      cpuMs: rounded(observation.sample.cpuMs),
      memoryByteMilliseconds: rounded(observation.memoryByteMilliseconds),
      peakMemoryBytes: rounded(observation.peakMemoryBytes),
      testedCandidates: 0,
      processingMs: rounded(observation.sample.elapsedMs),
    },
    inspection: null,
    error: {
      code,
      retryable: code === "ENGINE_OOM" && request.resourceClass === "image-standard-v1",
    },
  };
}

export function finalizeRunnerStatus(
  request: EngineCreateJobRequest,
  status: EngineJobStatus,
  observation: LinuxResourceObservation | null,
): EngineJobStatus {
  if (!("measurements" in status)) throw new TypeError("runner terminal status is required");
  const unmeasured =
    observation === null ||
    !Number.isFinite(observation.peakMemoryBytes) ||
    observation.peakMemoryBytes <= 0;
  if (unmeasured && status.state !== "succeeded") return status;
  if (unmeasured || observation.exceeded !== null) {
    return resourceFailureStatus(
      request,
      observation ?? {
        exceeded: { exceeded: "measurement" },
        sample: { measurementFailed: true },
        memoryByteMilliseconds: 0,
        peakMemoryBytes: 0,
        processGroups: [],
      },
      status.sequence + 1,
    );
  }
  return {
    ...status,
    measurements: {
      ...status.measurements,
      cpuMs: rounded(observation.sample.cpuMs),
      memoryByteMilliseconds: rounded(observation.memoryByteMilliseconds),
      peakMemoryBytes: rounded(observation.peakMemoryBytes),
      processingMs: Math.max(
        status.measurements.processingMs,
        rounded(observation.sample.elapsedMs),
      ),
    },
  };
}
