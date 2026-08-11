import { describe, expect, it } from "vitest";
import {
  migrationName,
  resolveAttestedActiveWorkerVersion,
  resolvePreviousActiveWorkerVersion,
  resolvePreviousActiveWorkerVersionFromD1,
  runPreviousActiveWorkerVersionCli,
  stateSql,
} from "../scripts/resolve-previous-active-worker-version.mjs";

const activeId = "11111111-2222-3333-4444-555555555555";
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
  it("resolves the authoritative D1 version before deployment reconciliation", async () => {
    const results = [[{ name: migrationName }], [row()]];
    let output = "";
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
      runPreviousActiveWorkerVersionCli(
        ["--account-id", "a".repeat(32), "--database-id", activeId, "--attestation-only", "true"],
        {
          env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" },
          fetchImpl,
          stdout: { write: (value: string) => (output += value) },
        },
      ),
    ).resolves.toBe(activeId);
    expect(output).toBe(`${activeId}\n`);
    expect(resolveAttestedActiveWorkerVersion({ rows: [row()] })).toBe(activeId);
  });

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
        deployment: { versions: [{ version_id: activeId, percentage: 100 }] },
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
        deployment: { versions: [] },
        fetchImpl,
      }),
    ).resolves.toBe("none");
  });

  it("returns none only for a consistent first deployment", () => {
    expect(
      resolvePreviousActiveWorkerVersion({
        rows: [row({ rowCount: 0, activeCount: 0, versionId: null, publicAdmissionAllowed: null })],
        deployment: { versions: [] },
      }),
    ).toBe("none");
  });

  it("rejects an unattested live Worker before a first deployment", () => {
    expect(() =>
      resolvePreviousActiveWorkerVersion({
        rows: [row({ rowCount: 0, activeCount: 0, versionId: null, publicAdmissionAllowed: null })],
        deployment: { versions: [{ version_id: activeId, percentage: 100 }] },
      }),
    ).toThrow(/first|deployment|active/i);
  });

  it("returns an admissible active version served at 100% even outside the recent-version window", () => {
    expect(
      resolvePreviousActiveWorkerVersion({
        rows: [row()],
        deployment: { versions: [{ version_id: activeId, percentage: 100 }] },
      }),
    ).toBe(activeId);
  });

  it.each([
    ["multiple active rows", row({ activeCount: 2 })],
    ["inadmissible active row", row({ publicAdmissionAllowed: 0 })],
    ["retired active row", row({ retiredAt: 1 })],
    ["malformed active ID", row({ versionId: "not-a-uuid" })],
  ])("rejects %s", (_label, state) => {
    expect(() =>
      resolvePreviousActiveWorkerVersion({
        rows: [state],
        deployment: { versions: [{ version_id: activeId, percentage: 100 }] },
      }),
    ).toThrow();
  });

  it("rejects an attested active version absent from the live deployment", () => {
    expect(() =>
      resolvePreviousActiveWorkerVersion({
        rows: [row()],
        deployment: {
          versions: [{ version_id: "66666666-7777-8888-9999-aaaaaaaaaaaa", percentage: 100 }],
        },
      }),
    ).toThrow(/deployment|active/i);
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
        deployment: { versions: [] },
      }),
    ).toThrow(/empty.*inconsistent/i);
  });
});
