import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runApplyWorkerVersionAttestationsCli } from "../scripts/apply-worker-version-attestations.mjs";
import {
  createWorkerAdmissionAttestationBatch,
  createWorkerVersionAttestationBatch,
} from "../scripts/verify-worker-version-chain.mjs";

const migrationName = "0002_worker_version_attestations.sql";
const hashes = {
  workerModuleSha256: "a".repeat(64),
  generatedConfigSha256: "b".repeat(64),
  releaseReportSha256: "c".repeat(64),
};

function validAttestation() {
  const versionIds = Array.from(
    { length: 6 },
    (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
  );
  return {
    schema: "hereisit-worker-version-attestations@1",
    version: 1,
    verifiedAt: "2026-07-19T00:08:00.000Z",
    ...hashes,
    activeVersionId: versionIds[5],
    previousActive: null,
    versions: versionIds.map((versionId, index) => ({
      versionId,
      state: index === 0 ? "bootstrap" : index === 5 ? "active" : "secret-intermediate",
      publicAdmissionPercent: 0,
    })),
  };
}

function validAdmissionAttestation() {
  return {
    schema: "hereisit-worker-admission-transition@1",
    version: 1,
    verifiedAt: "2026-08-10T00:09:00.000Z",
    fromVersionId: "00000000-0000-0000-0000-000000000006",
    activeVersionId: "00000000-0000-0000-0000-000000000007",
    fromPublicAdmissionPercent: 0,
    publicAdmissionPercent: 100,
    workerModuleSha256: "a".repeat(64),
    previousConfigSha256: "b".repeat(64),
    generatedConfigSha256: "d".repeat(64),
    releaseReportSha256: "c".repeat(64),
    versions: [
      {
        versionId: "00000000-0000-0000-0000-000000000007",
        state: "active",
        publicAdmissionPercent: 100,
      },
    ],
  };
}

function d1Result({ results = [], changed = false } = {}) {
  return {
    success: true,
    meta: {
      changed_db: changed,
      changes: changed ? 1 : 0,
      duration: 0.2,
      last_row_id: 0,
      rows_read: results.length,
      rows_written: changed ? 1 : 0,
      served_by_colo: "ICN",
      served_by_primary: true,
      served_by_region: "APAC",
      size_after: 4096,
      timings: { sql_duration_ms: 0.2 },
    },
    results,
  };
}

function d1Response(results: ReturnType<typeof d1Result>[]) {
  return new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result: results }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type CliOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

function runCli(argv: string[], options: CliOptions = {}) {
  return runApplyWorkerVersionAttestationsCli(argv, options);
}

describe("Worker version attestation application CLI", () => {
  it("runs as an executable and reports argument failures without echoing values", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          process.execPath,
          ["scripts/apply-worker-version-attestations.mjs", "--api-token", "must-stay-secret"],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toMatch(/unknown.*argument/i);
    expect(result.stderr).not.toContain("must-stay-secret");
  });

  it("rejects API tokens passed through process-visible CLI arguments", async () => {
    await expect(
      runCli([
        "--attestation",
        "attestation.json",
        "--account-id",
        "0123456789abcdef0123456789abcdef",
        "--database-id",
        "11111111-2222-3333-4444-555555555555",
        "--api-token",
        "must-not-be-accepted",
      ]),
    ).rejects.toThrow(/unknown.*argument/i);
  });

  it("requires the API token through a dedicated environment variable", async () => {
    await expect(
      runCli(
        [
          "--attestation",
          "attestation.json",
          "--account-id",
          "0123456789abcdef0123456789abcdef",
          "--database-id",
          "11111111-2222-3333-4444-555555555555",
        ],
        { env: {} },
      ),
    ).rejects.toThrow(/CLOUDFLARE_D1_API_TOKEN|environment/i);
  });

  it("requires every non-secret deployment coordinate", async () => {
    await expect(
      runCli(["--account-id", "0123456789abcdef0123456789abcdef"], {
        env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" },
      }),
    ).rejects.toThrow(/--attestation.*required/i);
  });

  it("rejects an attestation file larger than the bounded contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-attestation-cli-"));
    const attestationFile = join(directory, "oversized.json");
    try {
      await writeFile(attestationFile, "x".repeat(64 * 1024 + 1), "utf8");
      await expect(
        runCli(
          [
            "--attestation",
            attestationFile,
            "--account-id",
            "0123456789abcdef0123456789abcdef",
            "--database-id",
            "11111111-2222-3333-4444-555555555555",
          ],
          { env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" } },
        ),
      ).rejects.toThrow(/maximum size|too large|exceeds/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed attestation JSON without starting a request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-attestation-cli-"));
    const attestationFile = join(directory, "malformed.json");
    let requests = 0;
    try {
      await writeFile(attestationFile, "not-json", "utf8");
      await expect(
        runCli(
          [
            "--attestation",
            attestationFile,
            "--account-id",
            "0123456789abcdef0123456789abcdef",
            "--database-id",
            "11111111-2222-3333-4444-555555555555",
          ],
          {
            env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" },
            fetchImpl: async () => {
              requests += 1;
              return new Response();
            },
          },
        ),
      ).rejects.toThrow(/JSON/i);
      expect(requests).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates the versioned attestation contract before starting a request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-attestation-cli-"));
    const attestationFile = join(directory, "invalid-contract.json");
    let requests = 0;
    try {
      await writeFile(attestationFile, "{}", "utf8");
      await expect(
        runCli(
          [
            "--attestation",
            attestationFile,
            "--account-id",
            "0123456789abcdef0123456789abcdef",
            "--database-id",
            "11111111-2222-3333-4444-555555555555",
          ],
          {
            env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" },
            fetchImpl: async () => {
              requests += 1;
              return new Response();
            },
          },
        ),
      ).rejects.toThrow(/attestation|schema|keys/i);
      expect(requests).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies a validated attestation using only the environment token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-attestation-cli-"));
    const attestationFile = join(directory, "attestation.json");
    const attestation = validAttestation();
    const batch = createWorkerVersionAttestationBatch(attestation);
    const calls: Array<{ body: unknown; authorization: string | null }> = [];
    try {
      await writeFile(attestationFile, JSON.stringify(attestation), "utf8");
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({
          body,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (body.sql === "SELECT name FROM d1_migrations WHERE name = ?") {
          return d1Response([d1Result({ results: [{ name: migrationName }] })]);
        }
        if (Array.isArray(body.batch)) {
          return d1Response(body.batch.map(() => d1Result({ changed: true })));
        }
        const verification = batch.verification.find((query) => query.sql === body.sql);
        if (verification !== undefined) {
          return d1Response([d1Result({ results: verification.expected })]);
        }
        throw new Error("unexpected D1 request");
      };

      await expect(
        runCli(
          [
            "--attestation",
            attestationFile,
            "--account-id",
            "0123456789abcdef0123456789abcdef",
            "--database-id",
            "11111111-2222-3333-4444-555555555555",
          ],
          {
            env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" },
            fetchImpl,
          },
        ),
      ).resolves.toEqual({ applied: true, statements: 6, verificationQueries: 2 });
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.authorization === "Bearer deployment-token")).toBe(true);
      expect(JSON.stringify(calls.map((call) => call.body))).not.toContain("deployment-token");
      expect(JSON.stringify(calls.map((call) => call.body))).not.toContain(attestationFile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dispatches the one-version admission schema through the same guarded D1 path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-admission-cli-"));
    const attestationFile = join(directory, "attestation.json");
    const attestation = validAdmissionAttestation();
    const batch = createWorkerAdmissionAttestationBatch(attestation);
    try {
      await writeFile(attestationFile, JSON.stringify(attestation), "utf8");
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.sql === "SELECT name FROM d1_migrations WHERE name = ?") {
          return d1Response([d1Result({ results: [{ name: migrationName }] })]);
        }
        if (Array.isArray(body.batch)) {
          return d1Response(body.batch.map(() => d1Result({ changed: true })));
        }
        const verification = batch.verification.find((query) => query.sql === body.sql);
        if (verification !== undefined) {
          return d1Response([d1Result({ results: verification.expected })]);
        }
        throw new Error("unexpected D1 request");
      };

      await expect(
        runCli(
          [
            "--attestation",
            attestationFile,
            "--account-id",
            "0123456789abcdef0123456789abcdef",
            "--database-id",
            "11111111-2222-3333-4444-555555555555",
          ],
          { env: { CLOUDFLARE_D1_API_TOKEN: "deployment-token" }, fetchImpl },
        ),
      ).resolves.toEqual({ applied: true, statements: 2, verificationQueries: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
