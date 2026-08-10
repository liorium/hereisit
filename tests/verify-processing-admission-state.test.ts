import { describe, expect, it } from "vitest";
import {
  disableProcessingAdmissionInD1,
  readProcessingAdmissionStateFromD1,
  runProcessingAdmissionStateCli,
  verifyProcessingAdmissionState,
} from "../scripts/verify-processing-admission-state.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const databaseId = "11111111-2222-3333-4444-555555555555";
const activeVersionId = "00000000-0000-0000-0000-000000000007";
const releaseReportSha256 = "a".repeat(64);

function readyRow() {
  return {
    circuitOpen: 0,
    circuitReason: null,
    deletionOverdueCount: 0,
    activeJobs: 0,
    unsentOutbox: 0,
    activeAttestationCount: 1,
    activeVersionId,
    publicAdmissionAllowed: 1,
    costAccountingEpoch: "release-epoch",
    releaseReportSha256,
  };
}

function response(rows: unknown[], { primary = true, changes = 0 } = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: [
        {
          success: true,
          meta: { served_by_primary: primary, changes },
          results: rows,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("processing public admission state", () => {
  it("accepts one idle admissible active release with initialized accounting", () => {
    expect(
      verifyProcessingAdmissionState({
        rows: [readyRow()],
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
      }),
    ).toEqual({
      ready: true,
      activeVersionId,
      costAccountingEpoch: "release-epoch",
    });
  });

  it.each([
    ["an open circuit", { circuitOpen: 1, circuitReason: "OPERATOR_DISABLED" }],
    ["overdue deletion", { deletionOverdueCount: 1 }],
    ["an active job", { activeJobs: 1 }],
    ["an unsent outbox row", { unsentOutbox: 1 }],
    ["no active attestation", { activeAttestationCount: 0 }],
    ["multiple active attestations", { activeAttestationCount: 2 }],
    ["an inadmissible active version", { publicAdmissionAllowed: 0 }],
    ["an uninitialized cost epoch", { costAccountingEpoch: "uninitialized" }],
    ["an unsafe count", { activeJobs: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_label, change) => {
    expect(() =>
      verifyProcessingAdmissionState({
        rows: [{ ...readyRow(), ...change }],
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
      }),
    ).toThrow();
  });

  it("rejects the wrong active version or release hash", () => {
    expect(() =>
      verifyProcessingAdmissionState({
        rows: [readyRow()],
        expectedVersionId: "00000000-0000-0000-0000-000000000008",
        expectedReleaseReportSha256: releaseReportSha256,
      }),
    ).toThrow(/version/i);
    expect(() =>
      verifyProcessingAdmissionState({
        rows: [readyRow()],
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: "b".repeat(64),
      }),
    ).toThrow(/release|hash/i);
  });

  it("rejects a missing or extended state row", () => {
    expect(() =>
      verifyProcessingAdmissionState({
        rows: [],
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
      }),
    ).toThrow(/one row|exactly/i);
    expect(() =>
      verifyProcessingAdmissionState({
        rows: [{ ...readyRow(), privateValue: "must-not-pass" }],
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
      }),
    ).toThrow(/field/i);
  });

  it("reads only the strict aggregate from primary D1", async () => {
    const calls: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return response([readyRow()]);
    };
    await expect(
      readProcessingAdmissionStateFromD1({
        accountId,
        databaseId,
        apiToken: "d1-token",
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ ready: true, activeVersionId });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ params: [] });
    expect(JSON.stringify(calls[0])).toContain("deletion_overdue_count");
    expect(JSON.stringify(calls[0])).not.toContain("d1-token");
  });

  it("rejects a replica D1 response", async () => {
    await expect(
      readProcessingAdmissionStateFromD1({
        accountId,
        databaseId,
        apiToken: "d1-token",
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
        fetchImpl: async () => response([readyRow()], { primary: false }),
      }),
    ).rejects.toThrow(/primary/i);
  });

  it("opens the existing circuit idempotently and verifies the primary row", async () => {
    const bodies: Array<{ sql: string; params: unknown[] }> = [];
    const disabled = { ...readyRow(), circuitOpen: 1, circuitReason: "OPERATOR_DISABLED" };
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return bodies.length === 1 ? response([], { changes: 1 }) : response([disabled]);
    };
    await expect(
      disableProcessingAdmissionInD1({
        accountId,
        databaseId,
        apiToken: "d1-token",
        expectedVersionId: activeVersionId,
        expectedReleaseReportSha256: releaseReportSha256,
        now: Date.parse("2026-08-10T00:10:00.000Z"),
        fetchImpl,
      }),
    ).resolves.toEqual({ disabled: true, circuitOpen: true });
    expect(bodies[0].params).toEqual([
      Date.parse("2026-08-10T00:10:00.000Z"),
      Date.parse("2026-08-10T00:10:00.000Z"),
    ]);
    expect(bodies[0].sql).toContain("CASE WHEN circuit_open = 1 THEN reason");
    expect(bodies[1].params).toEqual([]);
  });

  it("accepts only strict verify and disable CLI forms with an environment token", async () => {
    const outputs: string[] = [];
    const common = [
      "--account-id",
      accountId,
      "--database-id",
      databaseId,
      "--expected-version-id",
      activeVersionId,
      "--expected-release-report-sha256",
      releaseReportSha256,
    ];
    let disableRequests = 0;
    await expect(
      runProcessingAdmissionStateCli(["--mode", "verify", ...common], {
        env: { CLOUDFLARE_D1_API_TOKEN: "d1-token" },
        fetchImpl: async () => response([readyRow()]),
        stdout: { write: (value: string) => outputs.push(value) },
      }),
    ).resolves.toMatchObject({ ready: true });
    await expect(
      runProcessingAdmissionStateCli(
        ["--mode", "disable", ...common, "--now", "2026-08-10T00:10:00.000Z"],
        {
          env: { CLOUDFLARE_D1_API_TOKEN: "d1-token" },
          fetchImpl: async () =>
            disableRequests++ === 0
              ? response([], { changes: 1 })
              : response([{ ...readyRow(), circuitOpen: 1, circuitReason: "OPERATOR_DISABLED" }]),
          stdout: { write: (value: string) => outputs.push(value) },
        },
      ),
    ).resolves.toEqual({ disabled: true, circuitOpen: true });
    expect(outputs.map((value) => JSON.parse(value))).toEqual([
      { ready: true, activeVersionId, costAccountingEpoch: "release-epoch" },
      { disabled: true, circuitOpen: true },
    ]);
    expect(outputs.join("")).not.toContain("d1-token");
    await expect(
      runProcessingAdmissionStateCli(["--mode", "verify", ...common, "--token", "secret"], {
        env: { CLOUDFLARE_D1_API_TOKEN: "d1-token" },
      }),
    ).rejects.toThrow(/field|argument|unknown/i);
    let noncanonicalRequests = 0;
    await expect(
      runProcessingAdmissionStateCli(["--mode", "disable", ...common, "--now", "2026-08-10"], {
        env: { CLOUDFLARE_D1_API_TOKEN: "d1-token" },
        fetchImpl: async () => {
          noncanonicalRequests += 1;
          return response([]);
        },
      }),
    ).rejects.toThrow(/canonical|timestamp/i);
    expect(noncanonicalRequests).toBe(0);
  });
});
