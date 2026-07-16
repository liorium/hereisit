import { describe, expect, it } from "vitest";
import { retentionDecision } from "./retention";

const base = {
  state: "succeeded",
  resultKind: "download",
  uploadExpiresAt: 1_000,
  resultExpiresAt: 2_000,
  terminalRecordExpiresAt: 86_400_000,
  now: 1_500,
  downloadAcknowledgedAt: null,
} as const;

describe("retentionDecision", () => {
  it("deletes terminal input and an acknowledged download without expiring early", () => {
    expect(
      retentionDecision({
        ...base,
        downloadAcknowledgedAt: 1_400,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: false,
      deleteRecord: false,
    });
  });

  it.each([
    "created",
    "uploading",
  ] as const)("expires an incomplete %s upload at its upload deadline", (state) => {
    expect(
      retentionDecision({
        ...base,
        state,
        resultKind: null,
        resultExpiresAt: null,
        terminalRecordExpiresAt: null,
        now: 1_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: true,
      deleteRecord: false,
    });
  });

  it.each([
    "queued",
    "running",
  ] as const)("never applies the historical upload deadline to %s", (state) => {
    expect(
      retentionDecision({
        ...base,
        state,
        resultKind: null,
        resultExpiresAt: null,
        terminalRecordExpiresAt: null,
        now: 50_000,
      }),
    ).toEqual({
      deleteInput: false,
      deleteOutput: false,
      expireJob: false,
      deleteRecord: false,
    });
  });

  it("never applies the upload deadline to a succeeded job", () => {
    expect(
      retentionDecision({
        ...base,
        uploadExpiresAt: 1,
        resultExpiresAt: 10_000,
        now: 5_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: false,
      expireJob: false,
      deleteRecord: false,
    });
  });

  it("expires and deletes a download at its result deadline", () => {
    expect(
      retentionDecision({
        ...base,
        now: 2_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: true,
      deleteRecord: false,
    });
  });

  it("makes a stuck download record due at terminal retention for tombstoning", () => {
    expect(
      retentionDecision({
        ...base,
        resultExpiresAt: 100_000_000,
        terminalRecordExpiresAt: 2_000,
        now: 2_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: false,
      expireJob: false,
      deleteRecord: true,
    });
  });

  it("makes original-retained success record-deletable without an output object", () => {
    expect(
      retentionDecision({
        ...base,
        resultKind: "original-retained",
        resultExpiresAt: null,
        terminalRecordExpiresAt: 2_000,
        now: 2_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: true,
      deleteRecord: true,
    });
  });

  it.each([
    "failed",
    "cancelled",
  ] as const)("deletes terminal %s input and expires at record retention", (state) => {
    expect(
      retentionDecision({
        ...base,
        state,
        resultKind: null,
        resultExpiresAt: null,
        terminalRecordExpiresAt: 2_000,
        now: 2_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: true,
      deleteRecord: true,
    });
  });

  it("deletes an expired record without asking to expire it again", () => {
    expect(
      retentionDecision({
        ...base,
        state: "expired",
        resultKind: null,
        resultExpiresAt: null,
        terminalRecordExpiresAt: 2_000,
        now: 2_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: false,
      deleteRecord: true,
    });
  });

  it("makes an expired incomplete upload fully record-deletable at terminal retention", () => {
    expect(
      retentionDecision({
        ...base,
        state: "uploading",
        resultKind: null,
        resultExpiresAt: null,
        uploadExpiresAt: 1_000,
        terminalRecordExpiresAt: 1_000,
        now: 1_000,
      }),
    ).toEqual({
      deleteInput: true,
      deleteOutput: true,
      expireJob: true,
      deleteRecord: true,
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
  ])("rejects invalid raw timestamps %s", (now) => {
    expect(() => retentionDecision({ ...base, now })).toThrow();
  });

  it("rejects unsafe optional timestamps", () => {
    expect(() =>
      retentionDecision({
        ...base,
        resultExpiresAt: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});
