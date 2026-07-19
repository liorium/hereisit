import { dirname } from "node:path";
import { type CommandResult, runBoundedCommand } from "./command";
import type { JpegTransform } from "./jpeg";

export interface JpegCoefficientVerification {
  readonly exact: boolean;
  readonly sourceSampling: string;
  readonly candidateSampling: string;
  readonly sourceBlocks: number;
  readonly candidateBlocks: number;
  readonly diagnostic?:
    | "coefficient-mismatch"
    | "component-layout-mismatch"
    | "dimension-mismatch"
    | "header-mismatch"
    | "quantization-mismatch";
}

export class JpegCoefficientVerifierError extends Error {
  constructor() {
    super("JPEG coefficient verification failed");
    this.name = "JpegCoefficientVerifierError";
  }
}

type CommandRunner = (input: Parameters<typeof runBoundedCommand>[0]) => Promise<CommandResult>;

const transforms = new Set<JpegTransform>([
  "identity",
  "flip-h",
  "rotate-180",
  "flip-v",
  "transpose",
  "rotate-90",
  "transverse",
  "rotate-270",
]);

function parseRecord(raw: string | undefined): JpegCoefficientVerification {
  if (raw === undefined) throw new JpegCoefficientVerifierError();
  const text = raw.trim();
  if (text.length === 0 || text.includes("\n") || text.length > 4_096) {
    throw new JpegCoefficientVerifierError();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JpegCoefficientVerifierError();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JpegCoefficientVerifierError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "candidateBlocks,candidateSampling,exact,sourceBlocks,sourceSampling") {
    throw new JpegCoefficientVerifierError();
  }
  const validSampling = (entry: unknown): entry is string =>
    typeof entry === "string" && /^[1-4]x[1-4](,[1-4]x[1-4]){0,3}$/.test(entry);
  const validBlocks = (entry: unknown): entry is number =>
    Number.isSafeInteger(entry) && (entry as number) >= 1 && (entry as number) <= 100_000_000;
  if (
    typeof record.exact !== "boolean" ||
    !validSampling(record.sourceSampling) ||
    !validSampling(record.candidateSampling) ||
    !validBlocks(record.sourceBlocks) ||
    !validBlocks(record.candidateBlocks)
  ) {
    throw new JpegCoefficientVerifierError();
  }
  return {
    exact: record.exact,
    sourceSampling: record.sourceSampling,
    candidateSampling: record.candidateSampling,
    sourceBlocks: record.sourceBlocks,
    candidateBlocks: record.candidateBlocks,
  };
}

export async function verifyJpegCoefficientTransform(input: {
  readonly sourcePath: string;
  readonly candidatePath: string;
  readonly transform: JpegTransform;
  readonly signal: AbortSignal;
  readonly run?: CommandRunner;
  readonly onProcessGroup?: (event: { action: "add" | "remove"; pgid: number }) => void;
}): Promise<JpegCoefficientVerification> {
  if (!transforms.has(input.transform)) throw new JpegCoefficientVerifierError();
  const result = await (input.run ?? runBoundedCommand)({
    command: "/usr/local/bin/jpeg-coeff-verify",
    args: [input.transform, input.sourcePath, input.candidatePath],
    cwd: dirname(input.candidatePath),
    timeoutMs: 15_000,
    maxStdoutBytes: 4_096,
    signal: input.signal,
    ...(input.onProcessGroup === undefined ? {} : { onProcessGroup: input.onProcessGroup }),
  });
  if (result.exitCode !== 0) throw new JpegCoefficientVerifierError();
  const record = parseRecord(result.stdoutTail);
  const diagnostic = result.stderrTail.trim();
  if (
    !record.exact &&
    (diagnostic === "coefficient-mismatch" ||
      diagnostic === "component-layout-mismatch" ||
      diagnostic === "dimension-mismatch" ||
      diagnostic === "header-mismatch" ||
      diagnostic === "quantization-mismatch")
  ) {
    return { ...record, diagnostic };
  }
  return record;
}
