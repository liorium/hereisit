import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projects = [
  "chromium",
  "firefox",
  "mobile-chromium",
  "mobile-firefox",
  "webkit",
  "mobile-webkit",
];
const desktop = [
  "processes and downloads an image without external uploads",
  "accepts a real HEIC file without uploading it",
  "makes a photo-like JPEG smaller while preserving its format",
];
const mobile = [
  "keeps image watermark controls ordered, reachable, and inside an iPhone viewport",
  "shows representative image selectors in the initial 390 by 844 viewport",
  "keeps general image result actions touch-safe at every responsive boundary",
];
const server = [
  "discloses upload and prepares a same-format result despite a wrong browser MIME label",
  "keeps an explicit local choice on-device and restores it after reload",
];
const analytics = [
  "image analytics excludes file data and records only the aggregate funnel",
  "a pending analytics request cannot delay a result or download",
  "an aborted analytics request cannot fail a tool action",
  "analytics creates no browser identity storage",
];
const workbenchAnalytics = [
  "product analytics records one image run and download",
  "product analytics settles a cancelled image run once",
];

function spec(file: string, title: string, projectName: string) {
  return {
    title,
    file,
    id: `${file}-${title}-${projectName}`,
    line: 1,
    column: 1,
    tags: [],
    ok: true,
    tests: [
      {
        timeout: 30_000,
        annotations: [] as { type: string; description: string }[],
        expectedStatus: "passed",
        projectName,
        projectId: projectName,
        status: "expected",
        results: [
          {
            workerIndex: 0,
            parallelIndex: 0,
            status: "passed",
            duration: 100,
            errors: [] as { message: string }[],
            stdout: [{ text: "PRIVATE_FILENAME.png https://private.invalid/signed" }],
            stderr: [],
            retry: 0,
            startTime: "2026-09-22T00:00:00.000Z",
            annotations: [],
            attachments: [],
          },
        ],
      },
    ],
  };
}

function report(selected: string[], analyticsOnly = false) {
  const specs = selected.flatMap((project) => {
    if (analyticsOnly)
      return [
        ...analytics.map((title) => spec("product-analytics.spec.ts", title, project)),
        ...workbenchAnalytics.map((title) => spec("image-workbench.spec.ts", title, project)),
      ];
    const entries = project.startsWith("mobile-")
      ? mobile.map((title) => spec("mobile.spec.ts", title, project))
      : [
          ...desktop.map((title) => spec("image-workbench.spec.ts", title, project)),
          spec(
            "image-watermark.spec.ts",
            "text watermark uses the approved defaults and downloads only on request",
            project,
          ),
        ];
    if (project !== "mobile-firefox")
      entries.push(
        ...server.map((title) => spec("image-compression-server.spec.ts", title, project)),
      );
    return entries;
  });
  return {
    config: { projects: projects.map((name) => ({ name, id: name })) },
    suites: [
      {
        title: "nested report fixture",
        file: "image-workbench.spec.ts",
        line: 0,
        column: 0,
        specs: [] as ReturnType<typeof spec>[],
        suites: [{ title: "nested suite", specs }],
      },
    ],
    errors: [] as { message: string }[],
    stats: {
      startTime: "2026-09-22T00:00:00.000Z",
      duration: 1000,
      expected: specs.length,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
  };
}

function inputs() {
  return {
    primary: report(projects.slice(0, 4)),
    webkit: report(projects.slice(4)),
    analytics: report(["chromium"], true),
  };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function run(reports = inputs(), extra: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "hereisit-browser-evidence-"));
  directories.push(directory);
  const output = join(directory, "evidence.json");
  const source = join(directory, "exact-source.tar");
  await writeFile(source, "exact-source-fixture");
  const args: string[] = [];
  for (const [name, value] of Object.entries(reports)) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(value));
    args.push(`--${name}`, path);
  }
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/create-image-browser-evidence.mjs"),
      ...args,
      "--source",
      source,
      "--git-sha",
      "a".repeat(40),
      "--check-run-id",
      "1234",
      "--output",
      output,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return { ...result, output };
}

describe("image browser evidence", () => {
  it("counts real nested passing tests, binds exact bytes, and emits only sanitized evidence", async () => {
    const reports = inputs();
    const result = await run(reports);
    expect(result.status, result.stderr).toBe(0);
    const bytes = await readFile(result.output, "utf8");
    const evidence = JSON.parse(bytes);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(evidence).toEqual({
      schema: "hereisit-image-browser-evidence@1",
      version: 1,
      passed: true,
      gitSha: "a".repeat(40),
      sourceSha256: hash("exact-source-fixture"),
      checkRunId: 1234,
      projects,
      productAnalytics: true,
      privacyTestsRun: 25,
      visualProfilesMeasured: 31,
      reportSha256: {
        primary: hash(JSON.stringify(reports.primary)),
        webkit: hash(JSON.stringify(reports.webkit)),
        analytics: hash(JSON.stringify(reports.analytics)),
      },
    });
    expect(bytes + result.stdout + result.stderr).not.toMatch(
      /PRIVATE_FILENAME|private.invalid|spec.ts/,
    );
  });

  it("allows only documented build-specific skips without counting them", async () => {
    const reports = inputs();
    for (const [file, title, reason] of [
      [
        "product-analytics.spec.ts",
        analytics[0],
        "requires a build with product analytics enabled",
      ],
      [
        "image-compression-server.spec.ts",
        "discloses local processing before selection and preserves PNG",
        "requires the default local-only build",
      ],
    ]) {
      const skipped = spec(file, title, "chromium");
      Object.assign(skipped.tests[0], {
        expectedStatus: "skipped",
        status: "skipped",
        annotations: [{ type: "skip", description: reason }],
      });
      skipped.tests[0].results[0].status = "skipped";
      reports.primary.suites[0].specs.push(skipped);
      reports.primary.stats.skipped++;
    }
    const result = await run(reports);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(result.output, "utf8"))).toMatchObject({
      privacyTestsRun: 25,
      visualProfilesMeasured: 31,
    });
  });

  it("derives counts from additional executed image and privacy cases", async () => {
    const reports = inputs();
    reports.primary.suites[0].specs.push(
      spec(
        "image-workbench.spec.ts",
        "downloads one image without consulting available Web Share APIs",
        "chromium",
      ),
      spec("product-analytics.spec.ts", analytics[0], "chromium"),
    );
    reports.primary.stats.expected += 2;
    const result = await run(reports);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(result.output, "utf8"))).toMatchObject({
      privacyTestsRun: 26,
      visualProfilesMeasured: 32,
    });
  });

  it.each([
    "missing project",
    "missing analytics",
    "skipped privacy",
    "flaky",
    "failed result",
    "expected failure",
    "report errors",
    "wrong counts",
    "empty results",
    "duplicate case",
    "empty suite",
    "unknown skip",
    "missing server disclosure",
  ])("rejects %s without writing evidence", async (mutation) => {
    const reports = inputs();
    const specs = reports.primary.suites[0].suites[0].specs;
    const first = specs[0].tests[0];
    if (mutation === "missing project") {
      reports.webkit.suites[0].suites[0].specs = reports.webkit.suites[0].suites[0].specs.filter(
        (entry) => entry.tests[0].projectName !== "mobile-webkit",
      );
      reports.webkit.stats.expected -= 5;
    }
    if (mutation === "missing analytics") {
      reports.analytics.suites[0].suites[0].specs.pop();
      reports.analytics.stats.expected--;
    }
    if (mutation === "skipped privacy" || mutation === "unknown skip") {
      Object.assign(first, {
        status: "skipped",
        expectedStatus: "skipped",
        annotations: [
          { type: "skip", description: "requires a build with product analytics enabled" },
        ],
      });
      first.results[0].status = "skipped";
      reports.primary.stats.expected--;
      reports.primary.stats.skipped++;
      if (mutation === "unknown skip") specs[0].title = "unrelated new skip";
    }
    if (mutation === "flaky") {
      first.status = "flaky";
      first.results.unshift({ ...first.results[0], status: "failed" });
      first.results[1].retry = 1;
    }
    if (mutation === "failed result") first.results[0].status = "failed";
    if (mutation === "expected failure") {
      first.expectedStatus = "failed";
      first.results[0].status = "failed";
    }
    if (mutation === "report errors")
      reports.primary.errors.push({ message: "PRIVATE_FILENAME.png" });
    if (mutation === "wrong counts") reports.primary.stats.expected++;
    if (mutation === "empty results") first.results = [];
    if (mutation === "duplicate case") {
      specs.push(structuredClone(specs[0]));
      reports.primary.stats.expected++;
    }
    if (mutation === "empty suite") {
      reports.primary.suites = [];
      reports.primary.stats.expected = 0;
    }
    if (mutation === "missing server disclosure") {
      const index = specs.findIndex((entry) => entry.title === server[0]);
      specs.splice(index, 1);
      reports.primary.stats.expected--;
    }
    const result = await run(reports);
    expect(result.status).toBe(1);
    await expect(readFile(result.output)).rejects.toThrow();
    expect(result.stderr).not.toContain("PRIVATE_FILENAME");
  });

  it("rejects unrecognized CLI fields", async () => {
    const result = await run(inputs(), ["--pretend-passed", "true"]);
    expect(result.status).toBe(1);
    await expect(readFile(result.output)).rejects.toThrow();
  });
});
