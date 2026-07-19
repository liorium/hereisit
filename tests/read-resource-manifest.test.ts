import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  readResourceManifestField,
  readResourceManifestFile,
  runResourceManifestReader,
} from "../scripts/read-resource-manifest.mjs";

const accountId = "0123456789abcdef0123456789abcdef";

function manifestEntry(environment = "staging") {
  return {
    environment,
    accountId,
    verifiedAt: "2026-07-19T00:00:00.000Z",
    d1: {
      databaseId: "11111111-2222-3333-4444-555555555555",
      name: `hereisit-processing-${environment}`,
      location: "apac",
    },
    r2: {
      jobs: {
        name: `hereisit-processing-${environment}`,
        lifecycleDays: 1,
        private: true,
      },
      usage: {
        name: `hereisit-processing-usage-${environment}`,
        lifecycleDays: 3,
        private: true,
      },
    },
    queues: {
      primary: {
        id: "1".repeat(32),
        name: `hereisit-image-jobs-${environment}`,
        deliveryPaused: true,
      },
      dlq: {
        id: "2".repeat(32),
        name: `hereisit-image-jobs-dlq-${environment}`,
        deliveryPaused: true,
      },
    },
    analytics: {
      datasetName: `hereisit_processing_usage_${environment}`,
      verified: true,
      workerVersionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    logpush: {
      jobId: 41,
      configSha256: "a".repeat(64),
      verified: true,
    },
    providerUsage: {
      schemaSha256: "b".repeat(64),
      verified: true,
    },
  };
}

function resourceManifest(entries = [manifestEntry()]) {
  const payload = {
    schema: "hereisit-processing-resources@1",
    version: 1,
    sealed: true,
    environments: entries,
  };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

describe("processing resource manifest reader", () => {
  it("reads only allowlisted scalar resource identities", () => {
    const manifest = resourceManifest();

    expect(readResourceManifestField(manifest, "d1.databaseId")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(readResourceManifestField(manifest, "logpush.jobId")).toBe(41);
    expect(readResourceManifestField(manifest, "providerUsage.schemaSha256")).toBe("b".repeat(64));
    expect(readResourceManifestField(manifest, "analytics.datasetName")).toBe(
      "hereisit_processing_usage_staging",
    );
  });

  it.each([
    "d1",
    "environments.0.d1.databaseId",
    "verificationSha256",
    "__proto__.polluted",
    "logpush.destination",
    "secret",
  ])("rejects non-allowlisted field %s", (field) => {
    expect(() => readResourceManifestField(resourceManifest(), field)).toThrow(/field/i);
  });

  it("rejects a stale verification stamp", () => {
    const manifest = resourceManifest();
    manifest.environments[0].d1.databaseId = "99999999-2222-3333-4444-555555555555";
    expect(() => readResourceManifestField(manifest, "d1.databaseId")).toThrow(/verification/i);
  });

  it("rejects duplicate environments", () => {
    expect(() =>
      readResourceManifestField(
        resourceManifest([manifestEntry(), manifestEntry()]),
        "d1.databaseId",
      ),
    ).toThrow(/duplicate/i);
  });

  it.each([
    ["malformed account", { accountId: "wrong" }],
    ["malformed D1 ID", { d1: { ...manifestEntry().d1, databaseId: "wrong" } }],
    ["unverified analytics", { analytics: { ...manifestEntry().analytics, verified: false } }],
    [
      "public R2",
      { r2: { ...manifestEntry().r2, jobs: { ...manifestEntry().r2.jobs, private: false } } },
    ],
    ["unexpected plaintext", { token: "must-not-appear" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      readResourceManifestField(
        resourceManifest([{ ...manifestEntry(), ...override }]),
        "d1.databaseId",
      ),
    ).toThrow();
  });

  it("reads a bounded manifest file without exposing the whole document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-resource-manifest-"));
    const file = join(directory, "resources.json");
    try {
      await writeFile(file, JSON.stringify(resourceManifest()), "utf8");
      await expect(readResourceManifestFile({ file, field: "queues.primary.id" })).resolves.toBe(
        "1".repeat(32),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a manifest file beyond the fixed input bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-resource-manifest-"));
    const file = join(directory, "resources.json");
    try {
      await writeFile(file, " ".repeat(256 * 1024 + 1), "utf8");
      await expect(readResourceManifestFile({ file, field: "d1.databaseId" })).rejects.toThrow(
        /size|large/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prints only the requested scalar through the CLI boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hereisit-resource-manifest-"));
    const file = join(directory, "resources.json");
    const writes: string[] = [];
    try {
      await writeFile(file, JSON.stringify(resourceManifest()), "utf8");
      await runResourceManifestReader(["--file", file, "--field", "logpush.jobId"], {
        write(value: string) {
          writes.push(value);
        },
      });
      expect(writes).toEqual(["41\n"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
