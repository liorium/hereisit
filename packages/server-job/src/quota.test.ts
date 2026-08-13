import { describe, expect, it } from "vitest";
import { decideAdmission, decideRetryReservation } from "./quota";

const otherwiseAllowedAdmission = {
  accountDailyLimit: 1_000,
  accountReservedToday: 0,
  accountSettledToday: 0,
  anonymousDailyLimit: 1_000,
  anonymousReservedToday: 0,
  anonymousSettledToday: 0,
  networkDailyLimit: 3_000,
  networkReservedToday: 0,
  networkSettledToday: 0,
  activeJobs: 0,
  networkPendingJobs: 0,
  networkPendingJobLimit: 3,
  accountPendingJobs: 0,
  accountPendingJobLimit: 10,
  oldestQueuedAgeSeconds: 0,
  maximumQueuedAgeSeconds: 600,
  requestedUnits: 1,
};

const otherwiseAllowedRetryReservation = {
  accountDailyLimit: 1_000,
  accountReservedToday: 0,
  accountSettledToday: 0,
  anonymousDailyLimit: 1_000,
  anonymousReservedToday: 0,
  anonymousSettledToday: 0,
  networkDailyLimit: 3_000,
  networkReservedToday: 0,
  networkSettledToday: 0,
  requestedUnits: 1,
};

describe("decideAdmission", () => {
  it("applies the same exact quota boundary to PDF resource reservations", () => {
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        accountDailyLimit: 2_439_579_999,
        anonymousDailyLimit: 2_439_579_999,
        networkDailyLimit: 2_439_579_999,
        requestedUnits: 2_439_579_999,
      }),
    ).toEqual({ allowed: true });
  });
  it("allows an admission exactly at every weighted-unit boundary", () => {
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        accountReservedToday: 600,
        accountSettledToday: 399,
        anonymousReservedToday: 500,
        anonymousSettledToday: 499,
        networkReservedToday: 2_000,
        networkSettledToday: 999,
      }),
    ).toEqual({ allowed: true });
  });

  it("reports processing disabled first when any daily limit is zero", () => {
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        accountDailyLimit: 0,
        activeJobs: 1,
        oldestQueuedAgeSeconds: 601,
      }),
    ).toEqual({ allowed: false, code: "SERVER_PROCESSING_DISABLED" });
  });

  it.each([
    "accountDailyLimit",
    "anonymousDailyLimit",
    "networkDailyLimit",
  ] as const)("disables processing for zero %s", (field) => {
    expect(decideAdmission({ ...otherwiseAllowedAdmission, [field]: 0 })).toEqual({
      allowed: false,
      code: "SERVER_PROCESSING_DISABLED",
    });
  });

  it.each([
    "accountDailyLimit",
    "anonymousDailyLimit",
    "networkDailyLimit",
  ] as const)("disables create processing for negative safe %s", (field) => {
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        [field]: -1,
        activeJobs: 1,
        oldestQueuedAgeSeconds: 601,
      }),
    ).toEqual({
      allowed: false,
      code: "SERVER_PROCESSING_DISABLED",
    });
  });

  it.each([
    ["an active job", { activeJobs: 1 }],
    ["the network pending boundary", { networkPendingJobs: 3, networkPendingJobLimit: 3 }],
    ["the account pending boundary", { accountPendingJobs: 10, accountPendingJobLimit: 10 }],
    [
      "account units above the boundary",
      { accountReservedToday: 999, accountSettledToday: 0, requestedUnits: 2 },
    ],
    [
      "anonymous units above the boundary",
      { anonymousReservedToday: 999, anonymousSettledToday: 0, requestedUnits: 2 },
    ],
    [
      "network units above the boundary",
      {
        networkReservedToday: 2_999,
        networkSettledToday: 0,
        networkDailyLimit: 3_000,
        requestedUnits: 2,
      },
    ],
  ])("reports quota exceeded for %s", (_case, override) => {
    expect(decideAdmission({ ...otherwiseAllowedAdmission, ...override })).toEqual({
      allowed: false,
      code: "QUOTA_EXCEEDED",
    });
  });

  it("reports stale queue unavailability before quota", () => {
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        networkPendingJobs: 3,
        oldestQueuedAgeSeconds: 601,
      }),
    ).toEqual({ allowed: false, code: "QUEUE_UNAVAILABLE" });
  });

  it("allows the maximum queue age and rejects only greater ages", () => {
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        oldestQueuedAgeSeconds: 600,
      }),
    ).toEqual({ allowed: true });
    expect(
      decideAdmission({
        ...otherwiseAllowedAdmission,
        oldestQueuedAgeSeconds: 601,
      }),
    ).toEqual({ allowed: false, code: "QUEUE_UNAVAILABLE" });
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s raw numeric inputs", (_case, value) => {
    expect(() =>
      decideAdmission({
        ...otherwiseAllowedAdmission,
        accountReservedToday: value,
      }),
    ).toThrow();
  });

  it("rejects unsafe quota sums instead of overflowing silently", () => {
    expect(() =>
      decideAdmission({
        ...otherwiseAllowedAdmission,
        accountDailyLimit: Number.MAX_SAFE_INTEGER,
        accountReservedToday: Number.MAX_SAFE_INTEGER,
        requestedUnits: 1,
      }),
    ).toThrow("safe integer");
  });
});

describe("decideRetryReservation", () => {
  it("checks only unit ceilings for an already active and pending job", () => {
    const retryWithCreateOnlyFields = {
      ...otherwiseAllowedRetryReservation,
      activeJobs: 1,
      accountPendingJobs: 10,
      networkPendingJobs: 3,
      oldestQueuedAgeSeconds: 601,
    };

    expect(decideRetryReservation(retryWithCreateOnlyFields)).toEqual({ allowed: true });
  });

  it("allows a retry reservation exactly at all three boundaries", () => {
    expect(
      decideRetryReservation({
        ...otherwiseAllowedRetryReservation,
        accountReservedToday: 600,
        accountSettledToday: 399,
        anonymousReservedToday: 500,
        anonymousSettledToday: 499,
        networkReservedToday: 2_000,
        networkSettledToday: 999,
      }),
    ).toEqual({ allowed: true });
  });

  it("gives disabled limits precedence over exceeded unit quota", () => {
    expect(
      decideRetryReservation({
        ...otherwiseAllowedRetryReservation,
        accountDailyLimit: 0,
        networkReservedToday: 3_000,
      }),
    ).toEqual({ allowed: false, code: "SERVER_PROCESSING_DISABLED" });
  });

  it.each([
    "accountDailyLimit",
    "anonymousDailyLimit",
    "networkDailyLimit",
  ] as const)("disables retry processing for negative safe %s", (field) => {
    expect(
      decideRetryReservation({
        ...otherwiseAllowedRetryReservation,
        [field]: -1,
        networkReservedToday: 3_000,
      }),
    ).toEqual({
      allowed: false,
      code: "SERVER_PROCESSING_DISABLED",
    });
  });

  it.each([
    ["account", { accountReservedToday: 1_000 }],
    ["anonymous session", { anonymousReservedToday: 1_000 }],
    ["network", { networkReservedToday: 3_000 }],
  ])("denies an uncovered %s retry reservation", (_case, override) => {
    expect(
      decideRetryReservation({
        ...otherwiseAllowedRetryReservation,
        ...override,
      }),
    ).toEqual({ allowed: false, code: "QUOTA_EXCEEDED" });
  });
});
