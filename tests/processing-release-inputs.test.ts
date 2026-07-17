import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProcessingReleaseInputs,
  processingReleaseInputsSha256,
  writeProcessingReleaseInputs,
} from "../scripts/create-processing-release-inputs.mjs";

const sha = (character: string) => character.repeat(64);
const { routeCpuBenchmark: _fixtureRoute, ...modelInput } = JSON.parse(
  readFileSync("tests/fixtures/live-cost-model-pr-input.json", "utf8"),
);
const reviewed = {
  version: 1,
  releaseId: "2026-07-16.1",
  baseSourceSha256: sha("a"),
  reviewedAt: "2026-07-16T00:00:00.000Z",
  reviewerIdHash: sha("b"),
  pricesAndResources: { version: 1, artifactSha256: sha("c"), modelInput },
  ceilings: { maxCostPer1000JobsMicrousd: 500_000, maxProjectedMonthlyCostMicrousd: 5_000_000 },
  routeCpuBenchmark: {
    version: 1,
    artifactSha256: sha("d"),
    sourceModuleSha256: sha("e"),
    toolchain: "workerd-test@1",
    margin: { kind: "p99-plus-percent", percent: 25 },
    routes: Object.fromEntries(
      ["policy", "create", "upload", "read", "result", "maintenance", "queue"].map(
        (route, index) => [route, { p99Ms: index + 1, samples: 100 }],
      ),
    ),
  },
};

describe("immutable processing release inputs", () => {
  it("binds the release, reviewed resources, ceilings, and all seven measured route envelopes", () => {
    const result = createProcessingReleaseInputs(reviewed);
    expect(result.releaseId).toBe(reviewed.releaseId);
    expect(result.baseSourceSha256).toBe(reviewed.baseSourceSha256);
    expect(Object.keys(result.routeCpuEnvelopeMs)).toEqual([
      "create",
      "maintenance",
      "policy",
      "queue",
      "read",
      "result",
      "upload",
    ]);
    expect(result.routeCpuEnvelopeMs.policy).toBe(2);
    expect(processingReleaseInputsSha256(result)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["placeholder release", { ...reviewed, releaseId: "TODO" }],
    ["path", { ...reviewed, localPath: "/tmp/secret" }],
    ["secret", { ...reviewed, apiToken: "secret" }],
    [
      "missing route",
      { ...reviewed, routeCpuBenchmark: { ...reviewed.routeCpuBenchmark, routes: {} } },
    ],
    ["unknown field", { ...reviewed, unknown: true }],
  ])("rejects %s", (_, value) => {
    expect(() => createProcessingReleaseInputs(value)).toThrow();
  });

  it("produces stable content", () => {
    const first = createProcessingReleaseInputs(reviewed);
    const second = createProcessingReleaseInputs(
      Object.fromEntries(Object.entries(reviewed).reverse()),
    );
    expect(processingReleaseInputsSha256(first)).toBe(processingReleaseInputsSha256(second));
  });

  it("writes once and refuses to overwrite an immutable release input", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-release-input-"));
    const path = join(root, "processing-release-inputs.json");
    try {
      await writeProcessingReleaseInputs(path, reviewed);
      await expect(writeProcessingReleaseInputs(path, reviewed)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
