import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createImageReleaseEvidence } from "../scripts/create-image-release-evidence.mjs";
import { sha256Bytes } from "../scripts/image-lab-common.mjs";
import { bytes, fixture } from "./fixtures/image-release-quality-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const identity = {
  gitSha: "a".repeat(40),
  checkRunId: 42,
  sourceSha256: sha256Bytes(Buffer.from("source")),
};
async function inputs(change: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "image-release-evidence-"));
  roots.push(root);
  const benchmark = fixture();
  const browser = {
    schema: "hereisit-image-browser-evidence@1",
    version: 1,
    passed: true,
    ...identity,
    projects: [
      "chromium",
      "firefox",
      "mobile-chromium",
      "mobile-firefox",
      "webkit",
      "mobile-webkit",
    ],
    productAnalytics: true,
    privacyTestsRun: 10,
    visualProfilesMeasured: 20,
    reportSha256: { primary: "d".repeat(64), webkit: "e".repeat(64), analytics: "f".repeat(64) },
    ...change,
  };
  const files = {
    source: Buffer.from("source"),
    manifest: bytes,
    benchmark: Buffer.from(JSON.stringify(benchmark)),
    browser: Buffer.from(JSON.stringify(browser)),
    license: Buffer.from(
      JSON.stringify({
        schema: "hereisit-image-engine-license-gate@1",
        passed: true,
        artifactSha256: "a".repeat(64),
        sourceLockSha256: "b".repeat(64),
      }),
    ),
    sourceLock: Buffer.from("lock"),
  };
  benchmark.identity.sourceLockSha256 = sha256Bytes(files.sourceLock);
  files.benchmark = Buffer.from(JSON.stringify(benchmark));
  const license = JSON.parse(files.license.toString());
  license.sourceLockSha256 = benchmark.identity.sourceLockSha256;
  files.license = Buffer.from(JSON.stringify(license));
  const paths: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) {
    paths[key] = join(root, key);
    await writeFile(paths[key], value);
  }
  return {
    ...paths,
    gitSha: identity.gitSha,
    checkRunId: 42,
    engineImageDigest: `sha256:${"a".repeat(64)}`,
    output: join(root, "out"),
  };
}
async function create(input: unknown) {
  return createImageReleaseEvidence(input);
}
it("creates five measured hosted receipts and never invents competitor or live cost passes", async () => {
  const input = await inputs();
  await create(input);
  const report = JSON.parse(await readFile(join(input.output, "fullCorpusBenchmark.json"), "utf8"));
  expect(report.document).toMatchObject({
    profilesMeasured: 117,
    engineImageDigest: input.engineImageDigest,
    ...identity,
  });
  await expect(readFile(join(input.output, "competitorComparison.json"))).rejects.toThrow();
});
it("refuses another source or run and incomplete browser evidence", async () => {
  for (const change of [
    { gitSha: "b".repeat(40) },
    { checkRunId: 43 },
    { passed: false },
    { privacyTestsRun: 0 },
  ]) {
    await expect(create(await inputs(change))).rejects.toThrow();
  }
});
