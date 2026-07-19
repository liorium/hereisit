import type { ToolJobState } from "@hereisit/tool-contracts";

export interface RetentionInput {
  state: ToolJobState;
  resultKind: "download" | "original-retained" | null;
  uploadExpiresAt: number;
  resultExpiresAt: number | null;
  terminalRecordExpiresAt: number | null;
  now: number;
  downloadAcknowledgedAt: number | null;
}

export interface RetentionDecision {
  deleteInput: boolean;
  deleteOutput: boolean;
  expireJob: boolean;
  deleteRecord: boolean;
}

const terminalStates: ReadonlySet<ToolJobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function validateOptionalTimestamp(value: number | null, label: string): void {
  if (value !== null) {
    assertNonNegativeSafeInteger(value, label);
  }
}

export function retentionDecision(input: RetentionInput): RetentionDecision {
  assertNonNegativeSafeInteger(input.uploadExpiresAt, "uploadExpiresAt");
  assertNonNegativeSafeInteger(input.now, "now");
  validateOptionalTimestamp(input.resultExpiresAt, "resultExpiresAt");
  validateOptionalTimestamp(input.terminalRecordExpiresAt, "terminalRecordExpiresAt");
  validateOptionalTimestamp(input.downloadAcknowledgedAt, "downloadAcknowledgedAt");

  const uploadExpired =
    (input.state === "created" || input.state === "uploading") &&
    input.uploadExpiresAt <= input.now;
  const resultExpired =
    input.resultKind === "download" &&
    input.resultExpiresAt !== null &&
    input.resultExpiresAt <= input.now;
  const downloadAcknowledged =
    input.resultKind === "download" &&
    input.downloadAcknowledgedAt !== null &&
    input.downloadAcknowledgedAt <= input.now;
  const terminalRecordExpired =
    input.terminalRecordExpiresAt !== null && input.terminalRecordExpiresAt <= input.now;

  const deleteInput = terminalStates.has(input.state) || uploadExpired;
  const noOutputCanExist =
    input.resultKind === "original-retained" ||
    uploadExpired ||
    ((input.state === "failed" || input.state === "cancelled" || input.state === "expired") &&
      input.resultKind !== "download");
  const deleteOutput = noOutputCanExist || resultExpired || downloadAcknowledged;

  let expireJob = false;
  if (input.state === "created" || input.state === "uploading") {
    expireJob = uploadExpired;
  } else if (input.state === "succeeded" && input.resultKind === "download") {
    expireJob = resultExpired;
  } else if (
    input.state === "succeeded" ||
    input.state === "failed" ||
    input.state === "cancelled"
  ) {
    expireJob = terminalRecordExpired;
  }

  const deleteRecord = terminalRecordExpired && deleteInput;

  return {
    deleteInput,
    deleteOutput,
    expireJob,
    deleteRecord,
  };
}
