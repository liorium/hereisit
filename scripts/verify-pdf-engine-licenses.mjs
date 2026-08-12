#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = Object.freeze({
  version: "12.4.0",
  url: "https://github.com/qpdf/qpdf/releases/download/v12.4.0/qpdf-12.4.0.tar.gz",
  sha256: "2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529",
  licenseSha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  noticeSha256: "b207f65a9e5491195ded63b2941199b19a4d30148871f2742c88eae7bfc513a6",
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function regular(path, maximum = 256 * 1024) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum)
    throw new TypeError("PDF engine policy input is invalid");
  return readFile(path);
}

export async function verifyPdfEngineLicenses({ root }) {
  const resolved = resolve(root);
  const [lockBytes, policyBytes, license, notice, dockerfile, build] = await Promise.all([
    regular(join(resolved, "native/sources.lock.json")),
    regular(join(resolved, "licenses/policy.json")),
    regular(join(resolved, "licenses/qpdf-12.4.0-Apache-2.0.txt")),
    regular(join(resolved, "licenses/qpdf-12.4.0-NOTICE.md")),
    regular(join(resolved, "Dockerfile")),
    regular(join(resolved, "native/build-qpdf.sh")),
  ]);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const source =
    lock?.schemaVersion === 1 && Array.isArray(lock.sources) && lock.sources.length === 1
      ? lock.sources[0]
      : null;
  if (
    source?.name !== "qpdf" ||
    source.version !== EXPECTED.version ||
    source.url !== EXPECTED.url ||
    source.sha256 !== EXPECTED.sha256 ||
    source.license !== "Apache-2.0"
  )
    throw new TypeError("qpdf source lock is invalid");
  if (sha256(license) !== EXPECTED.licenseSha256 || sha256(notice) !== EXPECTED.noticeSha256)
    throw new TypeError("qpdf license material is invalid");
  if (
    policy?.component?.sourceSha256 !== EXPECTED.sha256 ||
    policy?.component?.license !== "Apache-2.0" ||
    policy?.runtime?.uid !== 10001
  )
    throw new TypeError("PDF engine license policy is invalid");
  const image = dockerfile.toString("utf8").toLowerCase();
  const script = build.toString("utf8");
  if (
    !image.includes("user 10001:10001") ||
    !image.includes("/tmp/hereisit-pdf-engine") ||
    !script.includes("sha256sum --check --strict") ||
    !script.includes("sources.lock.json") ||
    /^\s*(?:VERSION=[0-9]|URL=https?:|SHA256=[0-9a-f]{64}\s*$)/mu.test(script)
  )
    throw new TypeError("PDF engine build controls are missing");
  for (const prohibited of policy.runtime.prohibitedComponents)
    if (image.includes(prohibited)) throw new TypeError("prohibited PDF component is present");
  return {
    schema: "hereisit-pdf-engine-license-gate@1",
    passed: true,
    qpdfVersion: EXPECTED.version,
    sourceSha256: EXPECTED.sha256,
    sourceLockSha256: sha256(lockBytes),
    policySha256: sha256(policyBytes),
    licenseSha256: sha256(license),
    noticeSha256: sha256(notice),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--root");
  if (index === -1 || index + 2 !== process.argv.length) {
    process.stderr.write("PDF engine license gate failed\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(
        `${JSON.stringify(await verifyPdfEngineLicenses({ root: process.argv[index + 1] }))}\n`,
      );
    } catch {
      process.stderr.write("PDF engine license gate failed\n");
      process.exitCode = 1;
    }
  }
}
