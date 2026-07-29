import { describe, expect, it } from "vitest";
import {
  migrationName,
  resolvePreviousActiveWorkerVersion,
  resolvePreviousActiveWorkerVersionFromD1,
  stateSql,
} from "../scripts/resolve-previous-active-worker-version.mjs";

const activeId = "11111111-2222-3333-4444-555555555555";
const version = {
  id: activeId,
  number: 1,
  metadata: {
    author_email: "",
    author_id: "a".repeat(32),
    created_on: "2026-07-22T00:00:00.000Z",
    has_preview: false,
    source: "wrangler",
  },
  annotations: { "workers/triggered_by": "upload" },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    rowCount: 1,
    activeCount: 1,
    versionId: activeId,
    publicAdmissionAllowed: 1,
    retiredAt: null,
    ...overrides,
  };
}

describe("previous active Worker version resolution", () => {
  it("checks the migration then resolves primary D1 state against the pre-deploy snapshot", async () => {
    const bodies: unknown[] = [];
    const results = [[{ name: migrationName }], [row()]];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const rows = results.shift();
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [{ success: true, results: rows, meta: { served_by_primary: true } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      resolvePreviousActiveWorkerVersionFromD1({
        accountId: "a".repeat(32),
        databaseId: activeId,
        apiToken: "deployment-token",
        before: [version],
        fetchImpl,
      }),
    ).resolves.toBe(activeId);
    expect(bodies).toEqual([
      { sql: "SELECT name FROM d1_migrations WHERE name = ?", params: [migrationName] },
      { sql: stateSql },
    ]);
  });

  it("resolves an empty primary D1 table as the first deployment", async () => {
    const results = [
      [{ name: migrationName }],
      [
        {
          rowCount: 0,
          activeCount: 0,
          versionId: null,
          publicAdmissionAllowed: null,
          retiredAt: null,
        },
      ],
    ];
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [{ success: true, results: results.shift(), meta: { served_by_primary: true } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      resolvePreviousActiveWorkerVersionFromD1({
        accountId: "a".repeat(32),
        databaseId: activeId,
        apiToken: "deployment-token",
        before: [],
        fetchImpl,
      }),
    ).resolves.toBe("none");
  });

  it("returns none only for a consistent first deployment", () => {
    expect(
      resolvePreviousActiveWorkerVersion({
        rows: [row({ rowCount: 0, activeCount: 0, versionId: null, publicAdmissionAllowed: null })],
        before: [],
      }),
    ).toBe("none");
  });

  it("returns the sole admissible active version present before deployment", () => {
    expect(resolvePreviousActiveWorkerVersion({ rows: [row()], before: [version] })).toBe(activeId);
  });

  it.each([
    ["multiple active rows", row({ activeCount: 2 })],
    ["inadmissible active row", row({ publicAdmissionAllowed: 0 })],
    ["retired active row", row({ retiredAt: 1 })],
    ["malformed active ID", row({ versionId: "not-a-uuid" })],
  ])("rejects %s", (_label, state) => {
    expect(() =>
      resolvePreviousActiveWorkerVersion({ rows: [state], before: [version] }),
    ).toThrow();
  });

  it("rejects an active version absent from the pre-deploy snapshot", () => {
    expect(() => resolvePreviousActiveWorkerVersion({ rows: [row()], before: [] })).toThrow(
      /absent.*snapshot/i,
    );
  });

  it("rejects inconsistent empty state fields", () => {
    expect(() =>
      resolvePreviousActiveWorkerVersion({
        rows: [
          row({
            rowCount: 0,
            activeCount: 0,
            versionId: null,
            publicAdmissionAllowed: null,
            retiredAt: 1,
          }),
        ],
        before: [],
      }),
    ).toThrow(/empty.*inconsistent/i);
  });
});
