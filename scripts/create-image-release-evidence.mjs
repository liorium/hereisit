import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createProcessingHostedCheck,
  hostedReviewSchemas,
  validateHostedReviewDocument,
} from "./create-processing-hosted-check.mjs";
import {
  assertExactKeys,
  assertSha256,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { evaluateNativeImageReleaseReport } from "./verify-image-quality.mjs";

export async function createImageReleaseEvidence(input) {
  const { gitSha, engineImageDigest } = input;
  const checkRunId = Number(input.checkRunId);
  if (!/^[a-f0-9]{40}$/.test(gitSha ?? "") || !Number.isSafeInteger(checkRunId) || checkRunId < 1)
    throw new TypeError("invalid image release identity");
  if (!/^sha256:[a-f0-9]{64}$/.test(engineImageDigest ?? ""))
    throw new TypeError("invalid image release engine digest");
  const source = await readBoundedRegularFile(
    resolve(input.source),
    256 * 1024 * 1024,
    "exact release source",
  );
  const sourceLock = await readBoundedRegularFile(
    resolve(input.sourceLock),
    1024 * 1024,
    "native source lock",
  );
  const read = async (path, label) => {
    const bytes = await readBoundedRegularFile(resolve(path), 8 * 1024 * 1024, label);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  };
  const [benchmark, manifest, browser, license] = await Promise.all([
    read(input.benchmark, "native benchmark"),
    read(input.manifest, "corpus manifest"),
    read(input.browser, "browser evidence"),
    read(input.license, "license gate"),
  ]);
  const sourceSha256 = sha256Bytes(source);
  const sourceLockSha256 = sha256Bytes(sourceLock);
  if (
    benchmark.value.identity?.engineImageDigest !== engineImageDigest ||
    benchmark.value.identity?.sourceLockSha256 !== sourceLockSha256 ||
    license.value.schema !== "hereisit-image-engine-license-gate@1" ||
    license.value.passed !== true ||
    license.value.artifactSha256 !== engineImageDigest.slice(7) ||
    license.value.sourceLockSha256 !== sourceLockSha256
  )
    throw new TypeError("image measurements and license gate must bind the exact engine");
  const measured = browser.value;
  assertExactKeys(
    measured,
    [
      "schema",
      "version",
      "passed",
      "gitSha",
      "sourceSha256",
      "checkRunId",
      "projects",
      "productAnalytics",
      "privacyTestsRun",
      "visualProfilesMeasured",
      "reportSha256",
    ],
    "browser evidence",
  );
  if (
    measured.schema !== "hereisit-image-browser-evidence@1" ||
    measured.version !== 1 ||
    measured.passed !== true ||
    measured.gitSha !== gitSha ||
    measured.sourceSha256 !== sourceSha256 ||
    measured.checkRunId !== checkRunId
  )
    throw new TypeError("browser evidence does not bind this exact source and CI run");
  assertExactKeys(
    measured.reportSha256,
    ["primary", "webkit", "analytics"],
    "browser report hashes",
  );
  for (const hash of Object.values(measured.reportSha256))
    assertSha256(hash, "browser report hash");
  const gate = evaluateNativeImageReleaseReport(
    benchmark.value,
    manifest.value,
    sha256Bytes(manifest.bytes),
  );
  if (!gate.passed) throw new TypeError(`native image release failed: ${gate.failures.join(",")}`);
  const common = {
    version: 2,
    passed: true,
    gitSha,
    sourceSha256,
    checkRunId,
    execution: "exact-main-hosted-check",
  };
  const browserSha256 = sha256Bytes(browser.bytes);
  const details = {
    fullCorpusBenchmark: {
      profilesMeasured: gate.profilesMeasured,
      corpusSha256: sha256Bytes(manifest.bytes),
      benchmarkSha256: sha256Bytes(benchmark.bytes),
      releaseGateSha256: sha256Canonical(gate),
      engineImageDigest,
    },
    blindedHumanReview: {
      visualProfilesMeasured: gate.visualProfilesMeasured,
      evidenceSha256: sha256Bytes(benchmark.bytes),
    },
    commercialReview: { licenseGateSha256: sha256Bytes(license.bytes) },
    privacyReview: { testsRun: measured.privacyTestsRun, evidenceSha256: browserSha256 },
    deviceMatrix: {
      projects: measured.projects,
      productAnalytics: measured.productAnalytics,
      evidenceSha256: browserSha256,
      visualProfilesMeasured: measured.visualProfilesMeasured,
    },
  };
  const reports = Object.fromEntries(
    Object.entries(details).map(([name, detail]) => {
      const document = { schema: hostedReviewSchemas[name], ...common, ...detail };
      validateHostedReviewDocument(document, { name, gitSha, sourceSha256, checkRunId });
      return [name, document];
    }),
  );
  const output = resolve(input.output);
  const documents = join(output, "documents");
  await mkdir(documents, { recursive: true, mode: 0o700 });
  await writeCanonicalJsonAtomic(join(output, "native-release-gate.json"), gate, {
    refuseOverwrite: true,
    mode: 0o600,
  });
  for (const [name, document] of Object.entries(reports))
    await writeCanonicalJsonAtomic(join(documents, `${name}.json`), document, {
      refuseOverwrite: true,
      mode: 0o600,
    });
  await createProcessingHostedCheck({
    source: input.source,
    input: documents,
    output,
    gitSha,
    checkRunId,
  });
  return gate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseCliArguments(process.argv.slice(2));
  assertExactKeys(
    args,
    [
      "source",
      "source-lock",
      "benchmark",
      "manifest",
      "browser",
      "license",
      "git-sha",
      "check-run-id",
      "engine-image-digest",
      "output",
    ],
    "image release evidence arguments",
  );
  const result = await createImageReleaseEvidence({
    ...args,
    sourceLock: args["source-lock"],
    gitSha: args["git-sha"],
    checkRunId: args["check-run-id"],
    engineImageDigest: args["engine-image-digest"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
