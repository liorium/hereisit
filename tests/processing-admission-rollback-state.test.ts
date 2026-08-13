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

function response(results: unknown[], changes = results.map(() => 1)) {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: results.map((rows, index) => ({
        success: true,
        results: rows,
        meta: { changes: changes[index], served_by_primary: true },
      })),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("processing admission rollback state", () => {
  it("restores the exact prior active policy/config binding and circuit values", () => {
    const batch = createProcessingAdmissionRollbackBatch(snapshot, 200);
    expect(batch).toHaveLength(3);
    expect(batch[0].sql).toContain("EXISTS");
    expect(batch[1].sql).toContain("worker_module_sha256 = ?");
    expect(batch[1].sql).toContain("generated_config_sha256 = ?");
    expect(batch[1].sql).toContain("release_report_sha256 = ?");
    expect(batch[0].sql).toContain("rollout_control WHERE id = 1");
    expect(batch[1].sql).toContain("rollout_control WHERE id = 1");
    expect(batch[0].params).toEqual([
      "retired",
      200,
      "active",
      snapshot.state.versionId,
      snapshot.state.versionId,
      snapshot.state.workerModuleSha256,
      snapshot.state.generatedConfigSha256,
      snapshot.state.releaseReportSha256,
    ]);
    expect(batch[2].params).toEqual([
      0,
      null,
      null,
      snapshot.state.versionId,
      snapshot.state.workerModuleSha256,
      snapshot.state.generatedConfigSha256,
      snapshot.state.releaseReportSha256,
    ]);
  });

  it("fails closed unless a primary read proves the exact prior state was restored", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? response([[], [], []], [1, 1, 1])
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

  it("atomically aborts with no partial retirement when the exact prior tuple is absent", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response([[], [], []], [0, 0, 0]);
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
    ).rejects.toThrow(/exact prior tuple|prerequisite/i);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ batch: expect.any(Array) });
    expect((bodies[0] as { batch: Array<{ sql: string }> }).batch).toHaveLength(3);
    expect((bodies[0] as { batch: Array<{ sql: string }> }).batch[0].sql).toContain("EXISTS");
  });
});
