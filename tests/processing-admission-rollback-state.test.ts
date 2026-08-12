import { describe, expect, it } from "vitest";
import {
  createProcessingAdmissionRollbackBatch,
  restoreProcessingAdmissionRollbackState,
} from "../scripts/processing-admission-rollback-state.mjs";

const snapshot = {
  schema: "hereisit-processing-admission-rollback@1",
  state: {
    circuitOpen: 0,
    circuitReason: null,
    openedAt: null,
    versionId: "00000000-0000-4000-8000-000000000001",
    workerModuleSha256: "a".repeat(64),
    generatedConfigSha256: "b".repeat(64),
    releaseReportSha256: "c".repeat(64),
    publicAdmissionAllowed: 1,
    observedAt: 100,
  },
};

function response(results: unknown[]) {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: results.map((rows) => ({
        success: true,
        results: rows,
        meta: { changes: 1, served_by_primary: true },
      })),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("processing admission rollback state", () => {
  it("restores the exact prior active policy/config binding and circuit values", () => {
    const batch = createProcessingAdmissionRollbackBatch(snapshot, 200);
    expect(batch).toHaveLength(3);
    expect(batch[0].sql).toContain("version_id <> ?");
    expect(batch[1].params).toEqual([
      "active",
      1,
      snapshot.state.versionId,
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ]);
    expect(batch[2].params).toEqual([0, null, null]);
  });

  it("fails closed unless a primary read proves the exact prior state was restored", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? response([[], [], []])
        : response([[{ ...snapshot.state, generatedConfigSha256: "d".repeat(64) }]]);
    };
    await expect(
      restoreProcessingAdmissionRollbackState({
        accountId: "a".repeat(32),
        databaseId: "00000000-0000-4000-8000-000000000001",
        apiToken: "private",
        snapshot,
        now: 200,
        fetchImpl,
      }),
    ).rejects.toThrow(/not restored exactly/i);
    expect(calls).toBe(2);
  });
});
