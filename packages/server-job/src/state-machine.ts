import type { ToolJobState } from "@hereisit/tool-contracts";

const legalTransitions: Readonly<Record<ToolJobState, ReadonlySet<ToolJobState>>> = {
  created: new Set(["uploading", "cancelled", "expired"]),
  uploading: new Set(["queued", "cancelled", "failed", "expired"]),
  queued: new Set(["running", "cancelled", "failed", "expired"]),
  running: new Set(["queued", "succeeded", "failed", "cancelled", "expired"]),
  succeeded: new Set(["expired"]),
  failed: new Set(["expired"]),
  cancelled: new Set(["expired"]),
  expired: new Set(),
};

const terminalStates: ReadonlySet<ToolJobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export function transitionJobState(current: ToolJobState, next: ToolJobState): ToolJobState {
  if (legalTransitions[current].has(next)) {
    return next;
  }

  if (terminalStates.has(current)) {
    throw new Error(`Cannot transition terminal job state ${current} to ${next}.`);
  }

  throw new Error(`Illegal job state transition from ${current} to ${next}.`);
}
