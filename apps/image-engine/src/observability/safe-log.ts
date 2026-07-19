const ALLOWED_FIELDS = new Set([
  "jobId",
  "engineBuildId",
  "codecBuildId",
  "phase",
  "queueMs",
  "processingMs",
  "totalMs",
  "inputBytes",
  "outputBytes",
  "pixels",
  "cpuMs",
  "memoryByteMilliseconds",
  "peakMemoryBytes",
  "testedCandidates",
  "code",
  "level",
]);

type SafeLogValue = string | number | boolean | null;
type SafeLogRecord = Readonly<Record<string, SafeLogValue>>;

export function createSafeLogger(
  write: (line: string) => void = (line) => process.stdout.write(line),
) {
  const log = (level: "info" | "warn" | "error", fields: SafeLogRecord): void => {
    for (const [key, value] of Object.entries(fields)) {
      if (
        !ALLOWED_FIELDS.has(key) ||
        (!["string", "number", "boolean"].includes(typeof value) && value !== null)
      ) {
        throw new TypeError(`safe log field is not allowed: ${key}`);
      }
    }
    write(`${JSON.stringify({ level, ...fields })}\n`);
  };
  return {
    info: (fields: SafeLogRecord) => log("info", fields),
    warn: (fields: SafeLogRecord) => log("warn", fields),
    error: (fields: SafeLogRecord) => log("error", fields),
  };
}
