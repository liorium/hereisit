import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProcessingCiReleaseSource } from "../scripts/prepare-processing-ci-release-source.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("CI release source preparation", () => {
  it("binds release inputs to exact source archive bytes rather than a label hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-ci-release-source-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const runtimeRoot = join(root, "runtime");
    const archive = join(root, "source.tar");
    await Promise.all([
      mkdir(sourceRoot),
      mkdir(runtimeRoot),
      writeFile(archive, "exact source bytes"),
    ]);
    await prepareProcessingCiReleaseSource({
      sourceRoot,
      runtimeRoot,
      releaseId: "2026-08-12.1",
      gitSha: "a".repeat(40),
      sourceArchive: archive,
      actor: "protected-reviewer",
      reviewedAt: "2026-08-12T00:00:00.000Z",
    });
    const inputs = JSON.parse(
      await readFile(join(sourceRoot, "processing-release-inputs.json"), "utf8"),
    );
    expect(inputs.baseSourceSha256).toBe(
      createHash("sha256").update("exact source bytes").digest("hex"),
    );
    expect(inputs.baseSourceSha256).not.toBe(
      createHash("sha256").update("a".repeat(40)).digest("hex"),
    );
  });
});
