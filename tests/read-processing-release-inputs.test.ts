import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessingReleaseInputs } from "../scripts/create-processing-release-inputs.mjs";
import { canonicalJson, sha256Bytes } from "../scripts/image-lab-common.mjs";

const cli = resolve("scripts/read-processing-release-inputs.mjs");
const roots: string[] = [];
const ceilings = {
  maxCostPer1000JobsMicrousd: 500_000,
  maxLiveMedianOutputRatioBps: 10_000,
  maxLiveP95WeightedUnits: 12_000,
  maxLiveOriginalRetainedRateBps: 2_500,
  maxProjectedMonthlyCostMicrousd: 5_000_000,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-release-input-reader-"));
  roots.push(root);
  const path = join(root, "processing-release-inputs.json");
  const input = JSON.parse(
    await readFile("docs/deployment/processing-staging-cost-input.json", "utf8"),
  );
  const { routeCpuBenchmark, ...modelInput } = input;
  const document = createProcessingReleaseInputs({
    version: 1,
    releaseId: "2026-07-20.1",
    baseSourceSha256: "a".repeat(64),
    reviewedAt: "2026-07-20T00:00:00.000Z",
    reviewerIdHash: "b".repeat(64),
    pricesAndResources: {
      version: 1,
      artifactSha256: "c".repeat(64),
      modelInput,
    },
    ceilings,
    routeCpuBenchmark: { artifactSha256: "d".repeat(64), ...routeCpuBenchmark },
  });
  const bytes = Buffer.from(canonicalJson(document));
  await writeFile(path, bytes);
  return { root, path, bytes, sha256: sha256Bytes(bytes) };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("processing release-input scalar reader", () => {
  it.each(
    Object.entries(ceilings),
  )("returns only the allowlisted %s scalar", async (field, value) => {
    const valueFixture = await fixture();
    const result = run([
      "--release-inputs",
      valueFixture.path,
      "--expected-sha256",
      valueFixture.sha256,
      "--field",
      field,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${value}\n`);
    expect(result.stderr).toBe("");
  });

  it("rejects a hash mismatch, unknown field, and extra argument without printing input data", async () => {
    const valueFixture = await fixture();
    for (const args of [
      [
        "--release-inputs",
        valueFixture.path,
        "--expected-sha256",
        "0".repeat(64),
        "--field",
        "maxLiveP95WeightedUnits",
      ],
      [
        "--release-inputs",
        valueFixture.path,
        "--expected-sha256",
        valueFixture.sha256,
        "--field",
        "releaseId",
      ],
      [
        "--release-inputs",
        valueFixture.path,
        "--expected-sha256",
        valueFixture.sha256,
        "--field",
        "maxLiveP95WeightedUnits",
        "--token",
        "must-not-print",
      ],
    ]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(valueFixture.path);
      expect(result.stderr).not.toContain("must-not-print");
      expect(result.stderr).not.toContain("2026-07-20.1");
    }
  });

  it.each(["symbolic", "oversized", "noncanonical"])("rejects a %s document", async (kind) => {
    const valueFixture = await fixture();
    let path = valueFixture.path;
    if (kind === "symbolic") {
      path = join(valueFixture.root, "release-input-link.json");
      await symlink(valueFixture.path, path);
    } else if (kind === "oversized") {
      await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x20));
    } else {
      await writeFile(path, `${valueFixture.bytes.toString("utf8")} `);
    }
    const result = run([
      "--release-inputs",
      path,
      "--expected-sha256",
      valueFixture.sha256,
      "--field",
      "maxLiveP95WeightedUnits",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/symbolic|bounded|regular|canonical|size/i);
  });

  it("rejects a canonical document whose median ratio exceeds 10000 basis points", async () => {
    const valueFixture = await fixture();
    const document = JSON.parse(valueFixture.bytes.toString("utf8"));
    document.ceilings.maxLiveMedianOutputRatioBps = 10_001;
    const bytes = Buffer.from(canonicalJson(document));
    await writeFile(valueFixture.path, bytes);

    const result = run([
      "--release-inputs",
      valueFixture.path,
      "--expected-sha256",
      sha256Bytes(bytes),
      "--field",
      "maxLiveMedianOutputRatioBps",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/median|10000|positive/i);
  });
});
