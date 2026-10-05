// Diagnostic evidence only; the vulnerability gate still requires exact-image review.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checks = [
  "smallSourceMapped",
  "oversizedSourceRejectedBeforeRead",
  "smallSourceSniffed",
  "oversizedSniffRejectedBeforeRead",
];
export function validateBoundsRuntime({
  source,
  metadata,
  libraryPath,
  librarySha256,
  patchSha256,
  results,
}) {
  if (
    source?.name !== "libvips" ||
    source.version !== "8.18.7" ||
    source.revision !== "24ad4d042940e6bf99a68871ba886ca8847c9c82" ||
    !/^[a-f0-9]{64}$/.test(patchSha256) ||
    source.patchSha256 !== patchSha256 ||
    metadata?.name !== source.name ||
    metadata.revision !== source.revision ||
    metadata.patchSha256 !== patchSha256 ||
    !/^\/usr\/local\/lib\/libvips\.so\.[0-9.]+$/.test(libraryPath) ||
    !/^[a-f0-9]{64}$/.test(librarySha256) ||
    !metadata.artifacts?.some(
      (artifact) =>
        artifact.path === libraryPath.replace("/usr/local", "/opt/hereisit-native/libvips") &&
        artifact.sha256 === librarySha256,
    )
  )
    throw new TypeError("libvips bounds runtime provenance mismatch");
  if (
    results?.runtimeVersion !== source.version ||
    Object.keys(results).length !== checks.length + 1 ||
    checks.some((check) => results[check] !== true)
  )
    throw new TypeError("libvips bounds probe did not pass both paths and controls");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [artifactSha256, gitSha, runId, runAttempt] = process.argv.slice(2);
    if (
      process.argv.length !== 6 ||
      !/^[a-f0-9]{64}$/.test(artifactSha256) ||
      !/^[a-f0-9]{40}$/.test(gitSha) ||
      !/^[1-9][0-9]*$/.test(runId) ||
      !/^[1-9][0-9]*$/.test(runAttempt)
    )
      throw new TypeError("libvips bounds CI identity is invalid");
    const lockBytes = readFileSync("/licenses/sources.lock.json");
    const sources = JSON.parse(lockBytes).sources.filter((source) => source.name === "libvips");
    if (sources.length !== 1) throw new TypeError("libvips source is ambiguous");
    const source = sources[0];
    const metadata = JSON.parse(readFileSync("/build-metadata/libvips.json"));
    const libraryPath = realpathSync("/usr/local/lib/libvips.so.42");
    const librarySha256 = hash(readFileSync(libraryPath));
    const patchSha256 = hash(readFileSync("/licenses/libvips/libvips-source-bounds.patch"));
    const results = JSON.parse(
      execFileSync("/probe", [], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096 }),
    );
    validateBoundsRuntime({ source, metadata, libraryPath, librarySha256, patchSha256, results });
    process.stdout.write(
      `${JSON.stringify({
        schema: "hereisit-libvips-bounds-diagnostic@1",
        artifactSha256,
        testedAt: new Date().toISOString(),
        producer: { gitSha, runId, runAttempt },
        sourceLockSha256: hash(lockBytes),
        source: { version: source.version, revision: source.revision, patchSha256 },
        runtime: { libraryPath, librarySha256 },
        probe: {
          sourceSha256: hash(readFileSync("/probe-source.c")),
          binarySha256: hash(readFileSync("/probe")),
        },
        results,
      })}\n`,
    );
  } catch {
    process.stderr.write("libvips bounds diagnostic failed\n");
    process.exitCode = 1;
  }
}
