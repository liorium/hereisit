import {
  type ImageOptimizeWarningCode,
  imageOptimizeWarningCodeSchema,
  type ToolJobErrorCode,
  toolJobErrorCodeSchema,
} from "@hereisit/tool-contracts";
import { z } from "zod";

const nonnegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export interface SafeProcessingEvent {
  event: "job-phase" | "job-terminal" | "deletion" | "queue-retry";
  jobId: string;
  sessionHashPrefix: string;
  contractId: "image.optimize@1";
  engineBuildId?: string | undefined;
  inputBytes: number;
  outputBytes?: number | undefined;
  pixels: number;
  phase?: string | undefined;
  queueMs?: number | undefined;
  processingMs?: number | undefined;
  peakMemoryBytes?: number | undefined;
  reservedUnits: number;
  actualUnits?: number | undefined;
  warningCode?: ImageOptimizeWarningCode | undefined;
  errorCode?: ToolJobErrorCode | undefined;
}

export const safeProcessingEventSchema: z.ZodType<SafeProcessingEvent> = z
  .object({
    event: z.enum(["job-phase", "job-terminal", "deletion", "queue-retry"]),
    jobId: z.uuid(),
    sessionHashPrefix: z.string().regex(/^[0-9a-f]{12}$/),
    contractId: z.literal("image.optimize@1"),
    engineBuildId: z.string().min(1).max(128).optional(),
    inputBytes: nonnegativeSafeInteger,
    outputBytes: nonnegativeSafeInteger.optional(),
    pixels: nonnegativeSafeInteger,
    phase: z.string().min(1).max(64).optional(),
    queueMs: nonnegativeSafeInteger.optional(),
    processingMs: nonnegativeSafeInteger.optional(),
    peakMemoryBytes: nonnegativeSafeInteger.optional(),
    reservedUnits: nonnegativeSafeInteger,
    actualUnits: nonnegativeSafeInteger.optional(),
    warningCode: imageOptimizeWarningCodeSchema.optional(),
    errorCode: toolJobErrorCodeSchema.optional(),
  })
  .strict();

export type SafeProcessingEventWriter = (event: SafeProcessingEvent) => void;

function defaultWriter(event: SafeProcessingEvent): void {
  console.info(event);
}

export function emitSafeProcessingEvent(
  event: SafeProcessingEvent,
  write: SafeProcessingEventWriter = defaultWriter,
): void {
  write(safeProcessingEventSchema.parse(event));
}

export function sessionHashPrefix(sessionHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(sessionHash)) {
    throw new TypeError("Session hash must be a lowercase SHA-256 digest.");
  }
  return sessionHash.slice(0, 12);
}
