import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProcessingHostedCheck,
  hostedReviewSchemas,
} from "../scripts/create-processing-hosted-check.mjs";
import { sha256Bytes } from "../scripts/image-lab-common.mjs";

const roots: string[] = [];
const gitSha = "a".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function documentFor(reportName: keyof typeof hostedReviewSchemas, sourceSha256: string) {
  const common = {
    schema: hostedReviewSchemas[reportName],
    version: 2,
    passed: true,
    gitSha,
    sourceSha256,
    checkRunId: 42,
    execution: "exact-main-hosted-check",
  };
  const detail = {
    fullCorpusBenchmark: {
      profilesMeasured: 3,
      corpusSha256: "b".repeat(64),
      benchmarkSha256: "1".repeat(64),
      releaseGateSha256: "2".repeat(64),
      engineImageDigest: `sha256:${"3".repeat(64)}`,
    },
    competitorComparison: { casesCompared: 12, baselineSha256: "1".repeat(64) },
    blindedHumanReview: {
      visualProfilesMeasured: 9,
      evidenceSha256: "c".repeat(64),
    },
    commercialReview: {
      licenseGateSha256: "e".repeat(64),
    },
    privacyReview: {
      testsRun: 6,
      evidenceSha256: "c".repeat(64),
    },
    deviceMatrix: {
      projects: [
        "chromium",
        "firefox",
        "mobile-chromium",
        "mobile-firefox",
        "webkit",
        "mobile-webkit",
      ],
      productAnalytics: true,
      evidenceSha256: "c".repeat(64),
      visualProfilesMeasured: 9,
    },
  };
  return { ...common, ...detail[reportName] };
}

describe("exact-main hosted processing checks", () => {
  it.each([
    true,
    false,
  ])("seals genuine strict reports with competitor comparison %s", async (includeComparison) => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-hosted-check-"));
    roots.push(root);
    const source = join(root, "source.tar");
    const input = join(root, "reports");
    const output = join(root, "receipts");
    const sourceBytes = Buffer.from("exact archived source");
    await writeFile(source, sourceBytes);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(input));
    const sourceSha256 = sha256Bytes(sourceBytes);
    for (const reportName of Object.keys(hostedReviewSchemas) as Array<
      keyof typeof hostedReviewSchemas
    >) {
      if (!includeComparison && reportName === "competitorComparison") continue;
      await writeFile(
        join(input, `${reportName}.json`),
        JSON.stringify(documentFor(reportName, sourceSha256)),
      );
    }

    await createProcessingHostedCheck({
      source,
      input,
      output,
      gitSha,
      checkRunId: 42,
    });

    for (const reportName of Object.keys(hostedReviewSchemas)) {
      if (!includeComparison && reportName === "competitorComparison") {
        await expect(readFile(join(output, `${reportName}.json`))).rejects.toMatchObject({
          code: "ENOENT",
        });
        continue;
      }
      const receipt = JSON.parse(await readFile(join(output, `${reportName}.json`), "utf8"));
      expect(receipt.document).toEqual(documentFor(reportName, sourceSha256));
      expect(receipt).toMatchObject({
        schema: "hereisit-processing-hosted-review@1",
        version: 1,
        reportName,
        passed: true,
        gitSha,
        sourceSha256,
        checkRunId: 42,
      });
    }
  });

  it("fails closed when image visual evidence is missing from otherwise complete reviews", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-hosted-check-"));
    roots.push(root);
    const source = join(root, "source.tar");
    const input = join(root, "reports");
    const sourceBytes = Buffer.from("exact archived source");
    await writeFile(source, sourceBytes);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(input));
    const sourceSha256 = sha256Bytes(sourceBytes);
    for (const reportName of Object.keys(hostedReviewSchemas) as Array<
      keyof typeof hostedReviewSchemas
    >) {
      await writeFile(
        join(input, `${reportName}.json`),
        JSON.stringify(
          reportName === "deviceMatrix"
            ? { ...documentFor(reportName, sourceSha256), evidenceSha256: undefined }
            : documentFor(reportName, sourceSha256),
        ),
      );
    }

    await expect(
      createProcessingHostedCheck({
        source,
        input,
        output: join(root, "out"),
        gitSha,
        checkRunId: 42,
      }),
    ).rejects.toThrow(/field|visual|missing/i);
  });

  it.each([
    "invalid-json",
    "invalid-review",
    "directory",
    "dangling-symlink",
  ])("rejects a supplied competitor comparison that is %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-hosted-optional-"));
    roots.push(root);
    const source = join(root, "source.tar");
    const input = join(root, "reports");
    const sourceBytes = Buffer.from("exact archived source");
    await writeFile(source, sourceBytes);
    await mkdir(input);
    const sourceSha256 = sha256Bytes(sourceBytes);
    for (const name of Object.keys(hostedReviewSchemas) as Array<
      keyof typeof hostedReviewSchemas
    >) {
      if (name === "competitorComparison") continue;
      await writeFile(join(input, `${name}.json`), JSON.stringify(documentFor(name, sourceSha256)));
    }
    const path = join(input, "competitorComparison.json");
    if (kind === "directory") await mkdir(path);
    else if (kind === "dangling-symlink") await symlink(join(root, "missing"), path);
    else
      await writeFile(
        path,
        kind === "invalid-json"
          ? "{"
          : JSON.stringify({
              ...documentFor("competitorComparison", sourceSha256),
              extra: true,
            }),
      );
    await expect(
      createProcessingHostedCheck({
        source,
        input,
        output: join(root, "out"),
        gitSha,
        checkRunId: 42,
      }),
    ).rejects.toThrow(/competitorComparison/);
    await expect(readFile(join(root, "out", "fullCorpusBenchmark.json"))).rejects.toThrow();
  });

  it("fails closed without manufacturing a missing hosted review", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-hosted-check-"));
    roots.push(root);
    const source = join(root, "source.tar");
    const input = join(root, "reports");
    await writeFile(source, "source");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(input));

    await expect(
      createProcessingHostedCheck({
        source,
        input,
        output: join(root, "out"),
        gitSha,
        checkRunId: 42,
      }),
    ).rejects.toThrow(/missing|invalid/i);
    await expect(readFile(join(root, "out", "fullCorpusBenchmark.json"))).rejects.toThrow();
  });

  it("rejects a wrong source identity instead of restamping it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-hosted-check-"));
    roots.push(root);
    const source = join(root, "source.tar");
    const input = join(root, "reports");
    await writeFile(source, "source");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(input));
    for (const reportName of Object.keys(hostedReviewSchemas) as Array<
      keyof typeof hostedReviewSchemas
    >) {
      await writeFile(
        join(input, `${reportName}.json`),
        JSON.stringify(documentFor(reportName, "0".repeat(64))),
      );
    }

    await expect(
      createProcessingHostedCheck({
        source,
        input,
        output: join(root, "out"),
        gitSha,
        checkRunId: 42,
      }),
    ).rejects.toThrow(/exact source|identity/i);
  });
});
