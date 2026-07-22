import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProcessingEvidenceBundle,
  runProcessingEvidenceBundleCreatorCli,
  writeProcessingEvidenceBundle,
} from "../scripts/create-processing-evidence-bundle.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";

const reportNames = [
  "fullCorpusBenchmark",
  "competitorComparison",
  "blindedHumanReview",
  "commercialReview",
  "privacyReview",
  "deviceMatrix",
] as const;
const temporaryRoots: string[] = [];

function inputs() {
  return {
    releaseId: "2026-07-20.1",
    gitSha: "a".repeat(40),
    candidateVerificationSha256: "b".repeat(64),
    createdAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-21T10:00:00.000Z",
    reports: Object.fromEntries(
      reportNames.map((name, index) => [name, { passed: true, name, score: index + 0.5 }]),
    ),
  };
}

function producerReports() {
  const benchmark = {
    version: 1,
    scope: "release",
    identity: { engineImageDigest: `sha256:${"c".repeat(64)}` },
    records: [
      {
        corpusId: "photo-jpeg",
        inputMime: "image/jpeg",
        outputMime: null,
        outcome: "original-retained",
      },
      {
        corpusId: "graphic-png",
        inputMime: "image/png",
        outputMime: "image/webp",
        outcome: "download",
      },
    ],
    summary: { attempted: 2, succeeded: 2 },
  };
  const competitor = [
    {
      vendor: "competitor",
      tool: "image optimizer",
      corpusId: "graphic-png",
      inputSha256: "d".repeat(64),
      outputSha256: "e".repeat(64),
      outputMime: "image/png",
      outputBytes: 1024,
    },
  ];
  return {
    ...inputs().reports,
    fullCorpusBenchmark: benchmark,
    competitorComparison: competitor,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing evidence bundle creation", () => {
  it("produces deterministic canonical report entries with stable hashes", () => {
    const first = createProcessingEvidenceBundle(inputs());
    const second = createProcessingEvidenceBundle({
      ...inputs(),
      reports: Object.fromEntries(Object.entries(inputs().reports).reverse()),
    });

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first).toMatchObject({ schema: "hereisit-processing-evidence@1", version: 1 });
    for (const name of reportNames) {
      expect(Object.keys(first.reports[name]).sort()).toEqual([
        "document",
        "sourceSha256",
        "summarySha256",
      ]);
      expect(first.reports[name].sourceSha256).toBe(sha256Canonical(inputs().reports[name]));
      expect(first.reports[name].summarySha256).toBe(sha256Canonical(first.reports[name].document));
    }
  });

  it("projects producer MIME fields while preserving source hashes through both creators", async () => {
    const reports = producerReports();
    const expected = createProcessingEvidenceBundle({ ...inputs(), reports });

    for (const name of ["fullCorpusBenchmark", "competitorComparison"] as const) {
      const entry = expected.reports[name];
      expect(entry.sourceSha256).toBe(sha256Canonical(reports[name]));
      expect(entry.summarySha256).toBe(sha256Canonical(entry.document));
      expect(canonicalJson(entry.document)).not.toMatch(/(?:inputMime|outputMime|image\/)/);
    }

    const root = await mkdtemp(join(tmpdir(), "hereisit-evidence-projection-"));
    temporaryRoots.push(root);
    const paths = Object.fromEntries(reportNames.map((name) => [name, join(root, `${name}.json`)]));
    await Promise.all(
      reportNames.map((name) => writeFile(paths[name], canonicalJson(reports[name]))),
    );
    const output = join(root, "bundle.json");
    await runProcessingEvidenceBundleCreatorCli([
      "--release-id",
      inputs().releaseId,
      "--git-sha",
      inputs().gitSha,
      "--candidate-verification-sha256",
      inputs().candidateVerificationSha256,
      "--created-at",
      inputs().createdAt,
      "--expires-at",
      inputs().expiresAt,
      "--full-corpus-benchmark",
      paths.fullCorpusBenchmark,
      "--competitor-comparison",
      paths.competitorComparison,
      "--blinded-human-review",
      paths.blindedHumanReview,
      "--commercial-review",
      paths.commercialReview,
      "--privacy-review",
      paths.privacyReview,
      "--device-matrix",
      paths.deviceMatrix,
      "--schema",
      resolve("docs/deployment/processing-evidence.schema.json"),
      "--output",
      output,
    ]);

    expect(await readFile(output, "utf8")).toBe(canonicalJson(expected));
  });

  it("rejects MIME projection fields with any other value", () => {
    for (const value of ["image/gif", "application/pdf", false]) {
      const reports = producerReports();
      reports.fullCorpusBenchmark.records[0].outputMime = value as never;
      expect(() => createProcessingEvidenceBundle({ ...inputs(), reports })).toThrow(/MIME/i);
    }
  });

  it("writes once with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-evidence-create-"));
    temporaryRoots.push(root);
    const output = join(root, "bundle.json");

    const hash = await writeProcessingEvidenceBundle({ output, ...inputs() });

    expect(hash).toBe(sha256Canonical(createProcessingEvidenceBundle(inputs())));
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
    await expect(writeProcessingEvidenceBundle({ output, ...inputs() })).rejects.toThrow(
      /exist|overwrite/i,
    );
  });

  it("requires exactly the six reports", () => {
    const missing = inputs();
    delete (missing.reports as Record<string, unknown>).deviceMatrix;
    expect(() => createProcessingEvidenceBundle(missing)).toThrow(/report|field/i);

    expect(() =>
      createProcessingEvidenceBundle({
        ...inputs(),
        reports: { ...inputs().reports, surprise: {} },
      }),
    ).toThrow(/report|field/i);
  });

  it("rejects forbidden keys and values", () => {
    for (const document of [
      { nested: { fileName: "safe.txt" } },
      { note: "/home/alice/private.txt" },
      { note: "C:\\Users\\alice\\private.txt" },
      { note: "\\\\server\\share\\private.txt" },
      { note: "file:///tmp/private.txt" },
      { note: "data:image/png;base64,abc" },
      { note: "blob:https://example.test/id" },
      { note: "image/png" },
      { note: "https://example.test/private" },
    ]) {
      expect(() =>
        createProcessingEvidenceBundle({
          ...inputs(),
          reports: { ...inputs().reports, privacyReview: document },
        }),
      ).toThrow(/forbidden|report|URL/i);
    }
  });

  it("allows only safe approval references", () => {
    const approval = {
      kind: "approval-reference",
      href: "https://approvals.example.test/reviews/42",
      sha256: "c".repeat(64),
    };
    expect(() =>
      createProcessingEvidenceBundle({
        ...inputs(),
        reports: { ...inputs().reports, commercialReview: { approval } },
      }),
    ).not.toThrow();

    for (const href of [
      "http://approvals.example.test/42",
      "https://user:pass@approvals.example.test/42",
      "https://approvals.example.test/42#secret",
    ]) {
      expect(() =>
        createProcessingEvidenceBundle({
          ...inputs(),
          reports: {
            ...inputs().reports,
            commercialReview: { approval: { ...approval, href } },
          },
        }),
      ).toThrow(/approval|URL|HTTPS/i);
    }
  });

  it("rejects array and object coercion for approval reference href", () => {
    const approval = {
      kind: "approval-reference",
      href: "https://approvals.example.test/reviews/42",
      sha256: "c".repeat(64),
    };

    for (const href of [[approval.href], { toString: () => approval.href }]) {
      expect(() =>
        createProcessingEvidenceBundle({
          ...inputs(),
          reports: {
            ...inputs().reports,
            commercialReview: { approval: { ...approval, href } },
          },
        }),
      ).toThrow(/approval|URL|string/i);
    }
  });

  it("rejects deep, sparse, non-finite, and prototype-bearing documents", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 33; index++) deep = { nested: deep };
    const sparse = Array(2);
    sparse[1] = true;
    const prototypeBearing = Object.create({ inherited: true });
    prototypeBearing.passed = true;

    for (const document of [deep, sparse, { score: Number.POSITIVE_INFINITY }, prototypeBearing]) {
      expect(() =>
        createProcessingEvidenceBundle({
          ...inputs(),
          reports: { ...inputs().reports, deviceMatrix: document },
        }),
      ).toThrow(/depth|sparse|finite|object|prototype/i);
    }
  });

  it("rejects report files over one MiB through the exact CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-evidence-create-"));
    temporaryRoots.push(root);
    const schema = resolve("docs/deployment/processing-evidence.schema.json");
    const paths = Object.fromEntries(reportNames.map((name) => [name, join(root, `${name}.json`)]));
    await Promise.all(
      reportNames.map((name) =>
        writeFile(paths[name], name === "deviceMatrix" ? `"${"x".repeat(1024 * 1024)}"` : "{}"),
      ),
    );

    await expect(
      runProcessingEvidenceBundleCreatorCli([
        "--release-id",
        inputs().releaseId,
        "--git-sha",
        inputs().gitSha,
        "--candidate-verification-sha256",
        inputs().candidateVerificationSha256,
        "--created-at",
        inputs().createdAt,
        "--expires-at",
        inputs().expiresAt,
        "--full-corpus-benchmark",
        paths.fullCorpusBenchmark,
        "--competitor-comparison",
        paths.competitorComparison,
        "--blinded-human-review",
        paths.blindedHumanReview,
        "--commercial-review",
        paths.commercialReview,
        "--privacy-review",
        paths.privacyReview,
        "--device-matrix",
        paths.deviceMatrix,
        "--schema",
        schema,
        "--output",
        join(root, "bundle.json"),
      ]),
    ).rejects.toThrow(/size|bounded|MiB/i);
  });
});
