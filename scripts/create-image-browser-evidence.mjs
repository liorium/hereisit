import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const projects = [
  "chromium",
  "firefox",
  "mobile-chromium",
  "mobile-firefox",
  "webkit",
  "mobile-webkit",
];
// Exact test identities prevent unrelated green tests from satisfying privacy coverage.
const analyticsCases = {
  "product-analytics.spec.ts": [
    "image analytics excludes file data and records only the aggregate funnel",
    "a pending analytics request cannot delay a result or download",
    "an aborted analytics request cannot fail a tool action",
    "analytics creates no browser identity storage",
  ],
  "image-workbench.spec.ts": [
    "product analytics records one image run and download",
    "product analytics settles a cancelled image run once",
  ],
};
const desktopPrivacy = [
  "processes and downloads an image without external uploads",
  "accepts a real HEIC file without uploading it",
];
const serverPrivacy = [
  "discloses upload and prepares a same-format result despite a wrong browser MIME label",
  "keeps an explicit local choice on-device and restores it after reload",
];
const mobilePrivacy =
  "keeps image watermark controls ordered, reachable, and inside an iPhone viewport";
const mobileCases = [
  mobilePrivacy,
  "shows representative image selectors in the initial 390 by 844 viewport",
  "starts each representative work area inside a 320 by 568 viewport",
  "keeps image compression preset text readable after selection",
  "keeps mixed HEIC compression guidance visible across narrow responsive widths",
  "keeps general image result actions touch-safe at every responsive boundary",
  "puts settings before the preview with touch-safe controls",
  "keeps representative image error feedback reachable",
];
const localOnlyCases = [
  "discloses local processing before selection and preserves PNG",
  "keeps the mobile workbench in one column without horizontal overflow",
  "supports keyboard setup with named compression presets",
];
const imageFiles = [
  "image-workbench.spec.ts",
  "image-compression-server.spec.ts",
  "image-watermark.spec.ts",
];

function requireEvidence(condition, reason) {
  if (!condition) throw new TypeError(`image browser evidence ${reason}`);
}

function summarizeReport(report, expectedProjects, analyticsOnly) {
  requireEvidence(Array.isArray(report?.errors) && report.errors.length === 0, "contains errors");
  const counts = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  const seen = new Set();
  const passed = new Set();
  let privacyTestsRun = 0;
  let visualProfilesMeasured = 0;
  let total = 0;

  function visit(suites, depth = 0) {
    requireEvidence(Array.isArray(suites) && depth < 32, "has invalid suites");
    for (const suite of suites) {
      requireEvidence(Array.isArray(suite?.specs), "has invalid specs");
      for (const spec of suite.specs) {
        requireEvidence(
          typeof spec?.file === "string" &&
            typeof spec.title === "string" &&
            spec.title.length > 0 &&
            spec.ok === true &&
            Array.isArray(spec.tests) &&
            spec.tests.length > 0,
          "has an invalid test specification",
        );
        const file = spec.file.replace(/^tests\/e2e\//, "");
        const analytic = analyticsCases[file]?.includes(spec.title) === true;
        for (const test of spec.tests) {
          total++;
          requireEvidence(total <= 100_000, "exceeds the test limit");
          requireEvidence(
            expectedProjects.includes(test?.projectName),
            "has an unexpected project",
          );
          const key = JSON.stringify([test.projectName, file, spec.title]);
          requireEvidence(!seen.has(key), "contains duplicate test cases");
          seen.add(key);
          requireEvidence(
            Array.isArray(test.results) &&
              test.results.length === 1 &&
              test.results[0].retry === 0 &&
              Array.isArray(test.results[0].errors) &&
              test.results[0].errors.length === 0 &&
              test.results[0].error === undefined,
            "contains missing, retried, or errored results",
          );
          if (test.status === "skipped") {
            const reason = analytic
              ? "requires a build with product analytics enabled"
              : file === "image-compression-server.spec.ts" && localOnlyCases.includes(spec.title)
                ? "requires the default local-only build"
                : undefined;
            requireEvidence(
              !analyticsOnly &&
                reason !== undefined &&
                test.expectedStatus === "skipped" &&
                test.results[0].status === "skipped" &&
                Array.isArray(test.annotations) &&
                test.annotations.some(
                  (annotation) => annotation.type === "skip" && annotation.description === reason,
                ),
              "contains an unapproved skipped test",
            );
            counts.skipped++;
            continue;
          }
          requireEvidence(
            test.status === "expected" &&
              test.expectedStatus === "passed" &&
              test.results[0].status === "passed",
            "contains a non-passing test",
          );
          requireEvidence(!analyticsOnly || analytic, "has unrelated analytics coverage");
          counts.expected++;
          passed.add(key);
          if (
            analytic ||
            (file === "image-workbench.spec.ts" && desktopPrivacy.includes(spec.title)) ||
            (file === "image-compression-server.spec.ts" && serverPrivacy.includes(spec.title)) ||
            (file === "mobile.spec.ts" && spec.title === mobilePrivacy)
          )
            privacyTestsRun++;
          // Legacy device-matrix field: executed image functional/layout cases, not screenshot
          // comparisons, codec quality profiles, physical-device tests, or human visual review.
          if (
            !analyticsOnly &&
            !analytic &&
            (imageFiles.includes(file) ||
              (file === "mobile.spec.ts" && mobileCases.includes(spec.title)))
          )
            visualProfilesMeasured++;
        }
      }
      if (suite.suites !== undefined) visit(suite.suites, depth + 1);
    }
  }
  visit(report.suites);
  requireEvidence(total > 0, "contains no tests");
  for (const [name, count] of Object.entries(counts))
    requireEvidence(report.stats?.[name] === count, "summary counts do not match results");

  function requireCases(project, file, titles) {
    for (const title of titles)
      requireEvidence(
        passed.has(JSON.stringify([project, file, title])),
        "required coverage is missing",
      );
  }
  for (const project of expectedProjects) {
    if (analyticsOnly) {
      for (const [file, titles] of Object.entries(analyticsCases))
        requireCases(project, file, titles);
    } else {
      if (project.startsWith("mobile-")) {
        requireCases(project, "mobile.spec.ts", [mobileCases[0], mobileCases[1], mobileCases[5]]);
      } else {
        requireCases(project, "image-workbench.spec.ts", [
          ...desktopPrivacy,
          "makes a photo-like JPEG smaller while preserving its format",
        ]);
        requireCases(project, "image-watermark.spec.ts", [
          "text watermark uses the approved defaults and downloads only on request",
        ]);
      }
      if (project !== "mobile-firefox")
        requireCases(project, "image-compression-server.spec.ts", serverPrivacy);
    }
  }
  return { privacyTestsRun, visualProfilesMeasured };
}

export async function createImageBrowserEvidence({
  primary,
  webkit,
  analytics,
  source,
  gitSha,
  checkRunId,
  output,
}) {
  requireEvidence(
    typeof gitSha === "string" && /^[a-f0-9]{40}$/.test(gitSha),
    "Git SHA is invalid",
  );
  const runId = typeof checkRunId === "string" ? Number(checkRunId) : checkRunId;
  requireEvidence(Number.isSafeInteger(runId) && runId > 0, "check run ID is invalid");
  const sourceBytes = await readBoundedRegularFile(
    resolve(source),
    256 * 1024 * 1024,
    "exact hosted source archive",
  );
  const reportSha256 = {};
  let privacyTestsRun = 0;
  let visualProfilesMeasured = 0;
  for (const [name, path, selected] of [
    ["primary", primary, projects.slice(0, 4)],
    ["webkit", webkit, projects.slice(4)],
    ["analytics", analytics, ["chromium"]],
  ]) {
    const bytes = await readBoundedRegularFile(
      resolve(path),
      64 * 1024 * 1024,
      "browser JSON report",
    );
    let report;
    try {
      report = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new TypeError("image browser evidence report is not valid JSON");
    }
    const counts = summarizeReport(report, selected, name === "analytics");
    privacyTestsRun += counts.privacyTestsRun;
    visualProfilesMeasured += counts.visualProfilesMeasured;
    reportSha256[name] = sha256Bytes(bytes);
  }
  const evidence = {
    schema: "hereisit-image-browser-evidence@1",
    version: 1,
    passed: true,
    gitSha,
    sourceSha256: sha256Bytes(sourceBytes),
    checkRunId: runId,
    projects,
    productAnalytics: true,
    privacyTestsRun,
    visualProfilesMeasured,
    reportSha256,
  };
  await writeCanonicalJsonAtomic(resolve(output), evidence, { refuseOverwrite: true, mode: 0o600 });
  return evidence;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = parseCliArguments(process.argv.slice(2));
    assertExactKeys(
      args,
      ["primary", "webkit", "analytics", "source", "git-sha", "check-run-id", "output"],
      "image browser evidence arguments",
    );
    const evidence = await createImageBrowserEvidence({
      ...args,
      gitSha: args["git-sha"],
      checkRunId: args["check-run-id"],
    });
    process.stdout.write(canonicalJson(evidence));
  } catch {
    // Never forward raw reporter content, paths, file names, URLs, or parser diagnostics.
    process.stderr.write("Image browser evidence creation failed.\n");
    process.exitCode = 1;
  }
}
