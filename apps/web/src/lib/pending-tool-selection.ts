import type { AvailableToolId } from "@hereisit/tool-registry/catalog";
import type { DetectedFileItem } from "./file-recommendations";

export const PENDING_TOOL_SELECTION_TTL_MS = 60_000;

export type PendingToolSelectionResult =
  | { state: "consumed"; items: readonly DetectedFileItem[] }
  | { state: "empty" | "expired" | "target-mismatch" };

let pending: {
  targetToolId: AvailableToolId;
  items: readonly DetectedFileItem[];
  createdAtMonotonicMs: number;
} | null = null;
let expiredTargetToolId: AvailableToolId | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function clearExpiryTimer(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
}

export function replacePendingToolSelection(
  targetToolId: AvailableToolId,
  items: readonly DetectedFileItem[],
  now = performance.now(),
): void {
  clearExpiryTimer();
  expiredTargetToolId = null;
  pending = {
    targetToolId,
    items: Object.freeze([...items]),
    createdAtMonotonicMs: now,
  };
  const createdAt = now;
  expiryTimer = setTimeout(() => {
    if (pending?.createdAtMonotonicMs !== createdAt) return;
    expiredTargetToolId = pending.targetToolId;
    pending = null;
    expiryTimer = null;
  }, PENDING_TOOL_SELECTION_TTL_MS);
}

export function consumePendingToolSelection(
  targetToolId: AvailableToolId,
  now = performance.now(),
): PendingToolSelectionResult {
  const current = pending;
  const expiredTarget = expiredTargetToolId;
  pending = null;
  expiredTargetToolId = null;
  clearExpiryTimer();

  if (current === null) {
    if (expiredTarget === null) return { state: "empty" };
    if (expiredTarget !== targetToolId) return { state: "target-mismatch" };
    return { state: "expired" };
  }

  if (current.targetToolId !== targetToolId) return { state: "target-mismatch" };
  if (now - current.createdAtMonotonicMs >= PENDING_TOOL_SELECTION_TTL_MS) {
    return { state: "expired" };
  }
  return { state: "consumed", items: current.items };
}

export function clearPendingToolSelection(): void {
  clearExpiryTimer();
  pending = null;
  expiredTargetToolId = null;
}
