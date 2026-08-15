export type ImageCompressScreen = "setup" | "processing" | "result";
export type ImageCompressionExecution = "server" | "local" | "checking";

export interface ImageCompressionSummary {
  readonly count: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly reductionPercent: number;
}

export function deriveImageCompressScreen(input: {
  readonly processing: boolean;
  readonly archiving: boolean;
  readonly completedCount: number;
}): ImageCompressScreen {
  if (input.processing || input.archiving) return "processing";
  return input.completedCount > 0 ? "result" : "setup";
}

export function resolveImageCompressionExecution(
  preference: "server" | "local",
  policy: ImageCompressionExecution,
): ImageCompressionExecution {
  return preference === "local" ? "local" : policy;
}

export function summarizeImageCompression(
  entries: readonly { readonly inputBytes: number; readonly outputBytes: number }[],
): ImageCompressionSummary | null {
  if (entries.length === 0) return null;
  const inputBytes = entries.reduce((sum, entry) => sum + entry.inputBytes, 0);
  const outputBytes = entries.reduce((sum, entry) => sum + entry.outputBytes, 0);
  const rawReduction = inputBytes > 0 ? ((inputBytes - outputBytes) / inputBytes) * 100 : 0;
  return {
    count: entries.length,
    inputBytes,
    outputBytes,
    reductionPercent: Math.max(0, Math.round(rawReduction * 10) / 10),
  };
}
