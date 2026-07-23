import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as processingReleaseInputModule from "../scripts/create-processing-release-inputs.mjs";
import {
  createProcessingReleaseInputs,
  processingReleaseInputsSha256,
  writeProcessingReleaseInputs,
} from "../scripts/create-processing-release-inputs.mjs";
import { canonicalJson } from "../scripts/image-lab-common.mjs";

const sha = (character: string) => character.repeat(64);
const { routeCpuBenchmark: _fixtureRoute, ...modelInput } = JSON.parse(
  readFileSync("docs/deployment/processing-staging-cost-input.json", "utf8"),
);
const repositoryRoot = process.cwd();
const releaseInputsCli = resolve(repositoryRoot, "scripts/create-processing-release-inputs.mjs");
const trustedSchema = readFileSync(
  resolve(repositoryRoot, "docs/deployment/processing-release-inputs.schema.json"),
);
const reviewed = {
  version: 1,
  releaseId: "2026-07-16.1",
  baseSourceSha256: sha("a"),
  reviewedAt: "2026-07-16T00:00:00.000Z",
  reviewerIdHash: sha("b"),
  pricesAndResources: { version: 1, artifactSha256: sha("c"), modelInput },
  ceilings: {
    maxCostPer1000JobsMicrousd: 500_000,
    maxLiveMedianOutputRatioBps: 8_000,
    maxLiveP95WeightedUnits: 12_000,
    maxLiveOriginalRetainedRateBps: 2_500,
    maxProjectedMonthlyCostMicrousd: 5_000_000,
  },
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

async function createVerificationRoot(releaseId = reviewed.releaseId) {
  const root = await mkdtemp(join(tmpdir(), "hereisit-release-input-verify-"));
  const releaseDirectory = join(root, "docs/deployment/releases", releaseId);
  const schemaPath = join(root, "docs/deployment/processing-release-inputs.schema.json");
  const inputPath = join(releaseDirectory, "processing-release-inputs.json");
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(schemaPath, trustedSchema);
  return { root, schemaPath, inputPath };
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [releaseInputsCli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

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
    expect(result.ceilings).toEqual({
      maxCostPer1000JobsMicrousd: 500_000,
      maxLiveMedianOutputRatioBps: 8_000,
      maxLiveOriginalRetainedRateBps: 2_500,
      maxLiveP95WeightedUnits: 12_000,
      maxProjectedMonthlyCostMicrousd: 5_000_000,
    });
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

  it.each([
    ["zero median ratio", "maxLiveMedianOutputRatioBps", 0],
    ["unsafe median ratio", "maxLiveMedianOutputRatioBps", Number.MAX_SAFE_INTEGER + 1],
    ["median ratio above 10000", "maxLiveMedianOutputRatioBps", 10_001],
    ["zero weighted units", "maxLiveP95WeightedUnits", 0],
    ["negative retained rate", "maxLiveOriginalRetainedRateBps", -1],
    ["retained rate above 10000", "maxLiveOriginalRetainedRateBps", 10_001],
  ])("rejects %s", (_label, field, value) => {
    expect(() =>
      createProcessingReleaseInputs({
        ...reviewed,
        ceilings: { ...reviewed.ceilings, [field]: value },
      }),
    ).toThrow();
  });

  it("accepts the exact 10000 basis-point median ratio boundary", () => {
    expect(
      createProcessingReleaseInputs({
        ...reviewed,
        ceilings: { ...reviewed.ceilings, maxLiveMedianOutputRatioBps: 10_000 },
      }).ceilings.maxLiveMedianOutputRatioBps,
    ).toBe(10_000);
  });

  it("produces stable content", () => {
    const first = createProcessingReleaseInputs(reviewed);
    const second = createProcessingReleaseInputs(
      Object.fromEntries(Object.entries(reviewed).reverse()),
    );
    expect(processingReleaseInputsSha256(first)).toBe(processingReleaseInputsSha256(second));
  });

  it("validates canonical release-input bytes through one shared document validator", () => {
    const document = createProcessingReleaseInputs(reviewed);
    expect(
      processingReleaseInputModule.validateCanonicalProcessingReleaseInputs(
        Buffer.from(canonicalJson(document)),
      ),
    ).toEqual(document);
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

  it("verifies canonical bytes at the release-bound path and emits only their SHA-256", async () => {
    const fixture = await createVerificationRoot();
    try {
      const document = createProcessingReleaseInputs(reviewed);
      const bytes = canonicalJson(document);
      await writeFile(fixture.inputPath, bytes);

      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${processingReleaseInputsSha256(document)}\n`);
      expect(result.stderr).toBe("");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects noncanonical release-input bytes", async () => {
    const fixture = await createVerificationRoot();
    try {
      await writeFile(
        fixture.inputPath,
        `${JSON.stringify(createProcessingReleaseInputs(reviewed), null, 2)}\n`,
      );
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/canonical/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["symbolic", "oversized"])("rejects a %s release-input file", async (kind) => {
    const fixture = await createVerificationRoot();
    try {
      if (kind === "symbolic") {
        const target = join(fixture.root, "release-input-target.json");
        await writeFile(target, canonicalJson(createProcessingReleaseInputs(reviewed)));
        await symlink(target, fixture.inputPath);
      } else {
        await writeFile(fixture.inputPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
      }
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/symbolic|bounded|regular|size/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a release ID that does not match its immutable repository path", async () => {
    const fixture = await createVerificationRoot("2026-07-16.2");
    try {
      await writeFile(fixture.inputPath, canonicalJson(createProcessingReleaseInputs(reviewed)));
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.2/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/release.*path|path.*release/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a noncanonical alias of the immutable repository path", async () => {
    const fixture = await createVerificationRoot();
    try {
      await writeFile(fixture.inputPath, canonicalJson(createProcessingReleaseInputs(reviewed)));
      const result = runCli(fixture.root, [
        "--verify-only",
        "./docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/repository path|canonical path/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "placeholder",
      { ...createProcessingReleaseInputs(reviewed), releaseId: "TODO" },
      /releaseId|immutable/i,
    ],
    ["extra field", { ...createProcessingReleaseInputs(reviewed), unexpected: true }, /fields/i],
  ])("rejects a %s in verification mode", async (_, document, errorPattern) => {
    const fixture = await createVerificationRoot();
    try {
      await writeFile(fixture.inputPath, canonicalJson(document));
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(errorPattern);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous verification arguments", async () => {
    const fixture = await createVerificationRoot();
    try {
      await writeFile(fixture.inputPath, canonicalJson(createProcessingReleaseInputs(reviewed)));
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
        "--output",
        "ignored.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/fields|arguments|output/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an arbitrary schema path in verification mode", async () => {
    const fixture = await createVerificationRoot();
    const arbitrarySchema = join(fixture.root, "schema.json");
    try {
      await writeFile(fixture.inputPath, canonicalJson(createProcessingReleaseInputs(reviewed)));
      await writeFile(arbitrarySchema, trustedSchema);
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/schema.*repository path|trusted schema/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "invalid",
    "symbolic",
    "oversized",
  ])("rejects a %s trusted schema in verification mode", async (kind) => {
    const fixture = await createVerificationRoot();
    try {
      await writeFile(fixture.inputPath, canonicalJson(createProcessingReleaseInputs(reviewed)));
      if (kind === "invalid") {
        await writeFile(fixture.schemaPath, "{}\n");
      } else if (kind === "symbolic") {
        const target = join(fixture.root, "schema-target.json");
        await writeFile(target, trustedSchema);
        await rm(fixture.schemaPath);
        await symlink(target, fixture.schemaPath);
      } else {
        await writeFile(fixture.schemaPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
      }
      const result = runCli(fixture.root, [
        "--verify-only",
        "docs/deployment/releases/2026-07-16.1/processing-release-inputs.json",
        "--schema",
        "docs/deployment/processing-release-inputs.schema.json",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/schema|symbolic|bounded|regular|size/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves the existing input-file creation mode", async () => {
    const fixture = await createVerificationRoot();
    const rawInput = join(fixture.root, "reviewed.json");
    try {
      await writeFile(rawInput, JSON.stringify(reviewed));
      const result = runCli(fixture.root, [
        "--input",
        rawInput,
        "--schema",
        fixture.schemaPath,
        "--output",
        fixture.inputPath,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{64}\n$/);
      expect(readFileSync(fixture.inputPath, "utf8")).toBe(
        canonicalJson(createProcessingReleaseInputs(reviewed)),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves the reviewed component-file creation mode with all five ceilings", async () => {
    const fixture = await createVerificationRoot();
    const priceInput = join(fixture.root, "reviewed-prices.json");
    const routeInput = join(fixture.root, "reviewed-routes.json");
    const ceilingInput = join(fixture.root, "reviewed-ceilings.json");
    const { artifactSha256: _artifactSha256, ...routeCpuBenchmark } = reviewed.routeCpuBenchmark;
    try {
      await writeFile(
        priceInput,
        JSON.stringify({
          version: 1,
          reviewedAt: reviewed.reviewedAt,
          reviewerIdHash: reviewed.reviewerIdHash,
          modelInput: reviewed.pricesAndResources.modelInput,
        }),
      );
      await writeFile(routeInput, JSON.stringify(routeCpuBenchmark));
      await writeFile(ceilingInput, JSON.stringify(reviewed.ceilings));

      const result = runCli(fixture.root, [
        "--base-source-sha",
        reviewed.baseSourceSha256,
        "--price-input",
        priceInput,
        "--route-cpu-benchmark",
        routeInput,
        "--quality-cost-ceilings",
        ceilingInput,
        "--schema",
        fixture.schemaPath,
        "--output",
        fixture.inputPath,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(fixture.inputPath, "utf8")).ceilings).toEqual(
        reviewed.ceilings,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("publishes the exact v1 ceiling constraints in the trusted schema", () => {
    const schema = JSON.parse(trustedSchema.toString("utf8"));
    expect(schema.properties.ceilings).toMatchObject({
      additionalProperties: false,
      required: [
        "maxCostPer1000JobsMicrousd",
        "maxLiveMedianOutputRatioBps",
        "maxLiveP95WeightedUnits",
        "maxLiveOriginalRetainedRateBps",
        "maxProjectedMonthlyCostMicrousd",
      ],
      properties: {
        maxLiveMedianOutputRatioBps: {
          type: "integer",
          minimum: 1,
          maximum: 10_000,
        },
        maxLiveP95WeightedUnits: {
          type: "integer",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        maxLiveOriginalRetainedRateBps: { type: "integer", minimum: 0, maximum: 10_000 },
      },
    });
  });
});
