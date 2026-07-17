import type { EngineJobStatus } from "@hereisit/server-contracts";

// Native codec execution is added in the next supply-chain and pipeline tasks. This entry exists now so
// the parent can spawn a stable, separately bundled boundary without importing codec adapters.
const jobIdArgument = process.argv.indexOf("--job-id");
const jobId = jobIdArgument === -1 ? undefined : process.argv[jobIdArgument + 1];
if (jobId !== undefined) {
  const status: EngineJobStatus = {
    protocol: 1,
    jobId,
    state: "failed",
    phase: null,
    fraction: null,
    sequence: 1,
    measurements: {
      processedInputBytes: 0,
      processedPixels: 0,
      cpuMs: 0,
      memoryByteMilliseconds: 0,
      peakMemoryBytes: 0,
      testedCandidates: 0,
      processingMs: 0,
    },
    inspection: null,
    error: { code: "ENGINE_CRASH", retryable: true },
  };
  process.stdout.write(`${JSON.stringify(status)}\n`);
}
