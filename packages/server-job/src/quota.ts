import type { ToolResourceEstimate } from "./resource-estimate";

export interface RetryReservationInput {
  accountDailyLimit: number;
  accountReservedToday: number;
  accountSettledToday: number;
  anonymousDailyLimit: number;
  anonymousReservedToday: number;
  anonymousSettledToday: number;
  networkDailyLimit: number;
  networkReservedToday: number;
  networkSettledToday: number;
  requestedUnits: ToolResourceEstimate["reservedWeightedUnits"];
}

export interface CreateAdmissionInput extends RetryReservationInput {
  activeJobs: number;
  networkPendingJobs: number;
  networkPendingJobLimit: number;
  accountPendingJobs: number;
  accountPendingJobLimit: number;
  oldestQueuedAgeSeconds: number;
  maximumQueuedAgeSeconds: number;
}

export type AdmissionInput = CreateAdmissionInput;

export type RetryReservationDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "SERVER_PROCESSING_DISABLED" | "QUOTA_EXCEEDED";
    };

export type AdmissionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "SERVER_PROCESSING_DISABLED" | "QUOTA_EXCEEDED" | "QUEUE_UNAVAILABLE";
    };

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer.`);
  }
}

function checkedSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError(`${label} must remain within the maximum safe integer.`);
    }
    total += value;
  }
  return total;
}

const dailyLimitFields = [
  "accountDailyLimit",
  "anonymousDailyLimit",
  "networkDailyLimit",
] as const satisfies readonly (keyof RetryReservationInput)[];

const retryUsageFields = [
  "accountReservedToday",
  "accountSettledToday",
  "anonymousReservedToday",
  "anonymousSettledToday",
  "networkReservedToday",
  "networkSettledToday",
  "requestedUnits",
] as const satisfies readonly (keyof RetryReservationInput)[];

const createOnlyFields = [
  "activeJobs",
  "networkPendingJobs",
  "networkPendingJobLimit",
  "accountPendingJobs",
  "accountPendingJobLimit",
  "oldestQueuedAgeSeconds",
  "maximumQueuedAgeSeconds",
] as const satisfies readonly (keyof CreateAdmissionInput)[];

function validateFields<T extends object>(
  input: T,
  fields: readonly (keyof T)[],
  validator: (value: number, label: string) => void,
): void {
  for (const label of fields) {
    const value = input[label];
    if (typeof value !== "number") {
      throw new TypeError(`${String(label)} must be a number.`);
    }
    validator(value, String(label));
  }
}

function processingIsDisabled(input: RetryReservationInput): boolean {
  return (
    input.accountDailyLimit <= 0 || input.anonymousDailyLimit <= 0 || input.networkDailyLimit <= 0
  );
}

function unitQuotaIsExceeded(input: RetryReservationInput): boolean {
  const accountRequestedTotal = checkedSum(
    [input.accountReservedToday, input.accountSettledToday, input.requestedUnits],
    "account requested total",
  );
  const anonymousRequestedTotal = checkedSum(
    [input.anonymousReservedToday, input.anonymousSettledToday, input.requestedUnits],
    "anonymous requested total",
  );
  const networkRequestedTotal = checkedSum(
    [input.networkReservedToday, input.networkSettledToday, input.requestedUnits],
    "network requested total",
  );

  return (
    accountRequestedTotal > input.accountDailyLimit ||
    anonymousRequestedTotal > input.anonymousDailyLimit ||
    networkRequestedTotal > input.networkDailyLimit
  );
}

export function decideRetryReservation(input: RetryReservationInput): RetryReservationDecision {
  validateFields(input, dailyLimitFields, assertSafeInteger);
  validateFields(input, retryUsageFields, assertNonNegativeSafeInteger);

  if (processingIsDisabled(input)) {
    return { allowed: false, code: "SERVER_PROCESSING_DISABLED" };
  }

  if (unitQuotaIsExceeded(input)) {
    return { allowed: false, code: "QUOTA_EXCEEDED" };
  }

  return { allowed: true };
}

/**
 * Admission for creating a new job. Retries must use decideRetryReservation()
 * because their job is already counted as active and pending.
 */
export function decideAdmission(input: CreateAdmissionInput): AdmissionDecision {
  validateFields(input, dailyLimitFields, assertSafeInteger);
  validateFields(input, retryUsageFields, assertNonNegativeSafeInteger);
  validateFields(input, createOnlyFields, assertNonNegativeSafeInteger);

  if (processingIsDisabled(input)) {
    return { allowed: false, code: "SERVER_PROCESSING_DISABLED" };
  }

  if (input.oldestQueuedAgeSeconds > input.maximumQueuedAgeSeconds) {
    return { allowed: false, code: "QUEUE_UNAVAILABLE" };
  }

  if (
    input.activeJobs >= 1 ||
    input.networkPendingJobs >= input.networkPendingJobLimit ||
    input.accountPendingJobs >= input.accountPendingJobLimit ||
    unitQuotaIsExceeded(input)
  ) {
    return { allowed: false, code: "QUOTA_EXCEEDED" };
  }

  return { allowed: true };
}
