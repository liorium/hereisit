import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    version: 1,
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
    competitorComparison: { casesCompared: 12, baselineSha256: "c".repeat(64) },
    blindedHumanReview: {
      reviewers: 2,
      approval: {
        kind: "approval-reference",
        href: "https://approvals.example.test/reviews/42",
        sha256: "d".repeat(64),
      },
    },
    commercialReview: {
      licenseGateSha256: "e".repeat(64),
      approval: {
        kind: "approval-reference",
        href: "https://approvals.example.test/reviews/43",
        sha256: "f".repeat(64),
      },
    },
    privacyReview: { testsRun: 9 },
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
      pdfVisualEvidenceSha256: "4".repeat(64),
      pdfVisualProfilesMeasured: 9,
    },
  };
  return { ...common, ...detail[reportName] };
}

describe("exact-main hosted processing checks", () => {
  it("seals genuine strict reports without restamping their identity", async () => {
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
