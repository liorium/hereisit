#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;

function tokenizeSpdx(expression) {
  const tokens = [];
  let remaining = expression.trim();
  while (remaining.length > 0) {
    const whitespace = /^\s+/.exec(remaining)?.[0];
    if (whitespace !== undefined) {
      remaining = remaining.slice(whitespace.length);
      continue;
    }
    const punctuation = /^[()]/.exec(remaining)?.[0];
    if (punctuation !== undefined) {
      tokens.push(punctuation);
      remaining = remaining.slice(1);
      continue;
    }
    const identifier = /^[A-Za-z0-9][A-Za-z0-9.+-]*/.exec(remaining)?.[0];
    if (identifier === undefined) throw new TypeError("SPDX expression contains an invalid token");
    tokens.push(identifier);
    remaining = remaining.slice(identifier.length);
  }
  return tokens;
}

function combineDecision(left, right) {
  if (left === "prohibited" || right === "prohibited") return "prohibited";
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "conditional" || right === "conditional") return "conditional";
  return "allowed";
}

function licenseDecision(identifier, policy) {
  if (identifier === "NOASSERTION" || identifier.startsWith("LicenseRef-")) return "unknown";
  const configuration = policy?.applicationAndNative;
  if (configuration === undefined) return "unknown";
  if (
    configuration.prohibited?.includes(identifier) === true ||
    /^(?:AGPL|GPL)-/.test(identifier)
  ) {
    return "prohibited";
  }
  if (Object.hasOwn(configuration.conditional ?? {}, identifier)) return "conditional";
  if (configuration.allowed?.includes(identifier) === true) return "allowed";
  return "unknown";
}

export function evaluateSpdxExpression(expression, policy) {
  try {
    if (typeof expression !== "string" || expression.trim() === "") return "unknown";
    const tokens = tokenizeSpdx(expression);
    let position = 0;
    const current = () => tokens[position];
    const consume = () => tokens[position++];

    const parsePrimary = () => {
      if (current() === "(") {
        consume();
        const decision = parseOr();
        if (consume() !== ")") throw new TypeError("SPDX expression has unbalanced parentheses");
        return decision;
      }
      const identifier = consume();
      if (
        identifier === undefined ||
        identifier === ")" ||
        identifier === "AND" ||
        identifier === "OR" ||
        identifier === "WITH"
      ) {
        throw new TypeError("SPDX expression is incomplete");
      }
      return licenseDecision(identifier, policy);
    };

    const parseWith = () => {
      const decision = parsePrimary();
      if (current() !== "WITH") return decision;
      consume();
      const exception = consume();
      if (
        exception === undefined ||
        exception === "(" ||
        exception === ")" ||
        exception === "AND" ||
        exception === "OR" ||
        exception === "WITH"
      ) {
        throw new TypeError("SPDX exception is invalid");
      }
      if (decision === "prohibited") return "prohibited";
      return policy?.applicationAndNative?.allowedExceptions?.includes(exception) === true
        ? decision
        : "unknown";
    };

    const parseAnd = () => {
      let decision = parseWith();
      while (current() === "AND") {
        consume();
        decision = combineDecision(decision, parseWith());
      }
      return decision;
    };

    function parseOr() {
      let decision = parseAnd();
      while (current() === "OR") {
        consume();
        decision = combineDecision(decision, parseAnd());
      }
      return decision;
    }

    const decision = parseOr();
    if (position !== tokens.length) return "unknown";
    return decision;
  } catch {
    return "unknown";
  }
}

function assertNonEmptyString(record, field) {
  if (typeof record[field] !== "string" || record[field].trim() === "") {
    throw new TypeError(`vulnerability exception ${field} is required`);
  }
}

export function validateVulnerabilityExceptions(value, now = new Date(), options = {}) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.exceptions)
  ) {
    throw new TypeError("vulnerability exceptions document is invalid");
  }
  const required = [
    "cve",
    "affectedPackage",
    "affectedVersion",
    "affectedScope",
    "affectedDigest",
    "exploitabilityEvidence",
    "owner",
    "approvalReference",
    "expiresAt",
  ];
  const allowedScopes = new Set(options.allowedScopes ?? ["engine"]);
  const maximumValidityDays = options.maximumValidityDays ?? 30;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("vulnerability exception verification time is invalid");
  }
  const identities = new Set();
  for (const exception of value.exceptions) {
    if (typeof exception !== "object" || exception === null) {
      throw new TypeError("vulnerability exception is invalid");
    }
    const fields = Object.keys(exception);
    const unknown = fields.filter((field) => !required.includes(field));
    if (unknown.length > 0) {
      throw new TypeError("vulnerability exception fields are invalid");
    }
    for (const field of required) assertNonEmptyString(exception, field);
    if (!/^CVE-\d{4}-\d{4,}$/.test(exception.cve)) {
      throw new TypeError("vulnerability exception CVE is invalid");
    }
    for (const field of ["affectedPackage", "affectedVersion"]) {
      if (exception[field] !== exception[field].trim() || /[*?[\]]/.test(exception[field])) {
        throw new TypeError(`vulnerability exception ${field} must be exact`);
      }
    }
    if (!allowedScopes.has(exception.affectedScope)) {
      throw new TypeError("vulnerability exception scope is invalid");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(exception.affectedDigest)) {
      throw new TypeError("vulnerability exception affectedDigest is invalid");
    }
    let approval;
    try {
      approval = new URL(exception.approvalReference);
    } catch {
      throw new TypeError("vulnerability exception approvalReference is invalid");
    }
    if (
      approval.protocol !== "https:" ||
      approval.username !== "" ||
      approval.password !== "" ||
      approval.hostname === ""
    ) {
      throw new TypeError("vulnerability exception approvalReference must use HTTPS");
    }
    const expiry = new Date(exception.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== exception.expiresAt) {
      throw new TypeError("vulnerability exception expiresAt is invalid");
    }
    if (expiry.getTime() <= now.getTime())
      throw new TypeError("vulnerability exception is expired");
    if (expiry.getTime() - now.getTime() > maximumValidityDays * DAY_MS) {
      throw new TypeError(`vulnerability exception may not exceed ${maximumValidityDays} days`);
    }
    const identity = [
      exception.cve,
      exception.affectedPackage,
      exception.affectedVersion,
      exception.affectedScope,
      exception.affectedDigest,
    ].join("\0");
    if (identities.has(identity)) throw new TypeError("duplicate vulnerability exception");
    identities.add(identity);
  }
  return value.exceptions;
}

export function validatePackageLicenses(packages, policy, sourceLock) {
  if (!Array.isArray(packages)) throw new TypeError("package license inventory is invalid");
  const firstParty = new Set(policy?.applicationAndNative?.firstPartyPackages ?? []);
  const seen = new Map();
  for (const packageRecord of packages) {
    if (typeof packageRecord !== "object" || packageRecord === null) {
      throw new TypeError("package license inventory contains an invalid record");
    }
    const { name, version, license } = packageRecord;
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("package license inventory contains an unnamed package");
    }
    if (typeof version !== "string" || version.trim() === "") {
      throw new TypeError(`package ${name} has no version`);
    }
    const identity = `${name}@${version}`;
    const previous = seen.get(identity);
    if (previous !== undefined && previous !== license) {
      throw new TypeError(`package ${identity} has conflicting license declarations`);
    }
    seen.set(identity, license);
    if (firstParty.has(name)) continue;
    if (license === null && typeof packageRecord.license_file === "string") {
      const source = sourceLock?.sources?.find(
        (candidate) => candidate?.name === name && candidate?.version === version,
      );
      const sourceReference = packageRecord.source;
      const exactLockedSource =
        typeof source?.repository === "string" &&
        typeof source?.revision === "string" &&
        typeof sourceReference === "string" &&
        sourceReference.startsWith(`git+${source.repository}`) &&
        sourceReference.endsWith(`#${source.revision}`) &&
        source.noticePaths?.includes(packageRecord.license_file) === true &&
        Array.isArray(source.licenses) &&
        source.licenses.length > 0 &&
        source.licenses.every(
          (expression) => evaluateSpdxExpression(expression, policy) === "allowed",
        );
      if (exactLockedSource) continue;
    }
    const decision = evaluateSpdxExpression(license, policy);
    if (decision !== "allowed") {
      throw new TypeError(`package ${identity} license is not conclusively allowed`);
    }
  }
}

function strictDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`commercial review ${field} is invalid`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`commercial review ${field} is invalid`);
  }
  return parsed;
}

export function validateCommercialReview(value, sourceLockBytes, now = new Date()) {
  if (!(sourceLockBytes instanceof Uint8Array)) {
    throw new TypeError("commercial review source lock bytes are required");
  }
  const sourceLockSha256 = createHash("sha256").update(sourceLockBytes).digest("hex");
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== 1 ||
    value.sourceLockSha256 !== sourceLockSha256 ||
    !Array.isArray(value.records)
  ) {
    throw new TypeError("commercial review does not match the exact source lock");
  }
  const sourceLock = JSON.parse(Buffer.from(sourceLockBytes).toString("utf8"));
  if (sourceLock?.schemaVersion !== 1 || !Array.isArray(sourceLock.sources)) {
    throw new TypeError("commercial review source lock is invalid");
  }
  const productionSources = new Map(
    sourceLock.sources
      .filter((source) => source?.production === true)
      .map((source) => [source.name, source]),
  );
  if (value.records.length !== productionSources.size) {
    throw new TypeError("commercial review must cover every production source exactly once");
  }
  const allowedFields = new Set([
    "component",
    "revision",
    "reviewedFiles",
    "reviewer",
    "organization",
    "reviewDate",
    "decision",
    "conditions",
    "approvalReference",
    "reReviewDate",
  ]);
  const reviewed = new Set();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  for (const record of value.records) {
    if (typeof record !== "object" || record === null) {
      throw new TypeError("commercial review record is invalid");
    }
    const unknownFields = Object.keys(record).filter((field) => !allowedFields.has(field));
    if (unknownFields.length > 0) {
      throw new TypeError("commercial review record has unknown fields");
    }
    for (const field of [
      "component",
      "revision",
      "reviewer",
      "organization",
      "approvalReference",
    ]) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        throw new TypeError(`commercial review ${field} is required`);
      }
    }
    const source = productionSources.get(record.component);
    if (source === undefined || reviewed.has(record.component)) {
      throw new TypeError("commercial review component coverage is invalid");
    }
    reviewed.add(record.component);
    if (record.revision !== source.revision) {
      throw new TypeError(`commercial review revision mismatch for ${record.component}`);
    }
    if (
      !Array.isArray(record.reviewedFiles) ||
      record.reviewedFiles.length === 0 ||
      record.reviewedFiles.some((file) => typeof file !== "string" || file.trim() === "") ||
      new Set(record.reviewedFiles).size !== record.reviewedFiles.length
    ) {
      throw new TypeError(`commercial review reviewedFiles is invalid for ${record.component}`);
    }
    for (const noticePath of source.noticePaths ?? []) {
      if (!record.reviewedFiles.includes(noticePath)) {
        throw new TypeError(`commercial review is missing ${record.component}/${noticePath}`);
      }
    }
    const reviewDate = strictDate(record.reviewDate, "reviewDate");
    if (reviewDate > today) throw new TypeError("commercial review date is in the future");
    if (record.reReviewDate !== undefined) {
      const reReviewDate = strictDate(record.reReviewDate, "reReviewDate");
      if (reReviewDate <= today) throw new TypeError("commercial review has expired");
    }
    if (record.decision !== "approved") {
      throw new TypeError(`commercial review for ${record.component} is not approved`);
    }
    if (!Array.isArray(record.conditions) || record.conditions.length !== 0) {
      throw new TypeError(`commercial review conditions are not satisfied for ${record.component}`);
    }
  }
  return { sourceLockSha256 };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateSourceLock(lock) {
  if (lock?.schemaVersion !== 1 || !Array.isArray(lock.sources) || lock.sources.length === 0) {
    throw new TypeError("source lock is invalid");
  }
  const names = new Set();
  for (const source of lock.sources) {
    if (typeof source !== "object" || source === null)
      throw new TypeError("source lock is invalid");
    for (const field of [
      "name",
      "version",
      "repository",
      "revision",
      "buildRole",
      "artifactRecord",
    ]) {
      if (typeof source[field] !== "string" || source[field].trim() === "") {
        throw new TypeError(`source lock ${field} is required`);
      }
    }
    if (names.has(source.name)) throw new TypeError(`source lock duplicates ${source.name}`);
    names.add(source.name);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(source.repository)) {
      throw new TypeError(`source ${source.name} repository is invalid`);
    }
    if (!/^[0-9a-f]{40}$/.test(source.revision)) {
      throw new TypeError(`source ${source.name} revision is invalid`);
    }
    if (!Array.isArray(source.licenses) || source.licenses.length === 0) {
      throw new TypeError(`source ${source.name} has no licenses`);
    }
    if (!Array.isArray(source.noticePaths) || source.noticePaths.length === 0) {
      throw new TypeError(`source ${source.name} has no notice paths`);
    }
    if (!/^\/build-metadata\/[a-z0-9-]+\.json$/.test(source.artifactRecord)) {
      throw new TypeError(`source ${source.name} artifact record is invalid`);
    }
    if (typeof source.production !== "boolean") {
      throw new TypeError(`source ${source.name} production classification is required`);
    }
  }
}

export function validateBaseImageLock(lock) {
  if (
    lock?.schemaVersion !== 1 ||
    lock.platform !== "linux/amd64" ||
    !Array.isArray(lock.images) ||
    lock.images.length === 0
  ) {
    throw new TypeError("base image lock is invalid");
  }
  for (const image of lock.images) {
    if (typeof image?.name !== "string" || typeof image.reference !== "string") {
      throw new TypeError("base image lock entry is invalid");
    }
    for (const field of ["indexDigest", "platformDigest"]) {
      if (!/^sha256:[0-9a-f]{64}$/.test(image[field])) {
        throw new TypeError(`base image ${image.name} ${field} is invalid`);
      }
    }
  }
}

const requiredRuntimeArtifacts = [
  "/usr/local/bin/cjpeg",
  "/usr/local/bin/djpeg",
  "/usr/local/bin/jpegtran",
  "/usr/local/bin/jpeg-coeff-verify",
  "/usr/local/bin/oxipng",
  "/usr/local/bin/png-smart",
  "/usr/local/bin/cwebp",
  "/usr/local/bin/dwebp",
  "/usr/local/lib/libvips.so",
  "/app/dist/server.mjs",
  "/app/dist/job/job-runner.mjs",
];

const artifactSourceByPath = new Map([
  ["/usr/local/bin/cjpeg", "mozjpeg"],
  ["/usr/local/bin/djpeg", "mozjpeg"],
  ["/usr/local/bin/jpegtran", "mozjpeg"],
  ["/usr/local/bin/jpeg-coeff-verify", "mozjpeg"],
  ["/usr/local/bin/oxipng", "oxipng"],
  ["/usr/local/bin/png-smart", "png-smart"],
  ["/usr/local/bin/cwebp", "libwebp"],
  ["/usr/local/bin/dwebp", "libwebp"],
  ["/usr/local/lib/libvips.so", "libvips"],
]);

export function validateRuntimeInventory(inventory, sourceLock, policy) {
  if (inventory?.schemaVersion !== 1 || inventory.uid !== 10001) {
    throw new TypeError("runtime inventory has a privileged or unexpected uid");
  }
  if (
    !Array.isArray(inventory.entries) ||
    !Array.isArray(inventory.required) ||
    !Array.isArray(inventory.packages) ||
    !Array.isArray(inventory.linkage) ||
    typeof inventory.buildMetadata !== "object" ||
    inventory.buildMetadata === null
  ) {
    throw new TypeError("runtime inventory is invalid");
  }
  const prohibitedNames = [
    ...(policy?.runtime?.prohibitedNames ?? []),
    ...(policy?.runtime?.benchmarkOnlyNames ?? []),
  ];
  for (const entry of inventory.entries) {
    const path = typeof entry?.path === "string" ? entry.path.toLowerCase() : "";
    const prohibited = prohibitedNames.find((name) => path.includes(String(name).toLowerCase()));
    if (prohibited !== undefined) {
      throw new TypeError(`runtime contains prohibited component ${prohibited}`);
    }
  }
  const requiredByPath = new Map(inventory.required.map((record) => [record?.path, record]));
  for (const path of requiredRuntimeArtifacts) {
    const record = requiredByPath.get(path);
    if (record === undefined || !/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new TypeError(`runtime artifact is missing or unhashed: ${path}`);
    }
    if (path.startsWith("/usr/local/bin/") && (record.mode & 0o111) === 0) {
      throw new TypeError(`runtime command is not executable: ${path}`);
    }
  }
  for (const linkage of inventory.linkage) {
    if (typeof linkage?.output !== "string" || /=>\s+not found\b/.test(linkage.output)) {
      throw new TypeError(`runtime linkage is unresolved: ${linkage?.path ?? "unknown"}`);
    }
  }
  const entryPaths = new Set(inventory.entries.map((entry) => entry?.path));
  for (const source of sourceLock.sources.filter((candidate) => candidate.production === true)) {
    const metadataName = source.artifactRecord.split("/").at(-1);
    const metadata = inventory.buildMetadata[metadataName];
    if (
      metadata?.schemaVersion !== 1 ||
      metadata.name !== (source.name === "quantizr" ? "png-smart" : source.name) ||
      metadata.revision !== source.revision ||
      !Array.isArray(metadata.artifacts) ||
      metadata.artifacts.length === 0
    ) {
      throw new TypeError(`runtime build metadata is invalid for ${source.name}`);
    }
    for (const noticePath of source.noticePaths) {
      if (!entryPaths.has(`/licenses/${source.name}/${noticePath}`)) {
        throw new TypeError(`runtime notice is missing: ${source.name}/${noticePath}`);
      }
    }
  }
  for (const [path, sourceName] of artifactSourceByPath) {
    const source =
      sourceName === "png-smart"
        ? sourceLock.sources.find((item) => item.name === "quantizr")
        : sourceLock.sources.find((item) => item.name === sourceName);
    const metadataName = source?.artifactRecord?.split("/").at(-1);
    const artifacts = inventory.buildMetadata[metadataName]?.artifacts ?? [];
    const digest = requiredByPath.get(path)?.sha256;
    if (!artifacts.some((artifact) => artifact?.sha256 === digest)) {
      throw new TypeError(`runtime artifact hash is not bound to ${sourceName}: ${path}`);
    }
  }
  const debian = inventory.buildMetadata["debian-packages.json"];
  if (
    debian?.schemaVersion !== 1 ||
    debian.snapshot !== "20260716T000000Z" ||
    !Array.isArray(debian.packages) ||
    debian.packages.length === 0 ||
    !Array.isArray(debian.copyrightPaths) ||
    debian.copyrightPaths.length === 0
  ) {
    throw new TypeError("runtime Debian package inventory is invalid");
  }
  validatePackageLicenses(inventory.packages, policy);
  for (const name of ["oxipng-cargo-metadata.json", "png-smart-cargo-metadata.json"]) {
    const cargoMetadata = inventory.buildMetadata[name];
    if (!Array.isArray(cargoMetadata?.packages) || cargoMetadata.packages.length === 0) {
      throw new TypeError(`runtime Cargo metadata is missing: ${name}`);
    }
    validatePackageLicenses(
      cargoMetadata.packages.map((packageRecord) => ({
        name: packageRecord.name,
        version: packageRecord.version,
        license: packageRecord.license,
        license_file: packageRecord.license_file,
        source: packageRecord.source,
      })),
      policy,
      sourceLock,
    );
  }
}

function inspectRuntimeImage(image) {
  if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/.test(image)) {
    throw new TypeError("runtime image reference is invalid");
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const inventoryScript = resolve(
    repositoryRoot,
    "apps/image-engine/scripts/runtime-inventory.mjs",
  );
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      "--mount",
      `type=bind,src=${inventoryScript},dst=/tmp/runtime-inventory.mjs,readonly`,
      image,
      "/tmp/runtime-inventory.mjs",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

function parseArguments(argv) {
  const options = {
    scope: "pr",
    lock: "apps/image-engine/native/sources.lock.json",
    policy: "apps/image-engine/licenses/policy.json",
    exceptions: "apps/image-engine/security/vulnerability-exceptions.json",
    "base-lock": "apps/image-engine/base-images.lock.json",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== "string" || !name.startsWith("--") || value === undefined) {
      throw new TypeError("license verifier arguments are invalid");
    }
    const key = name.slice(2);
    if (!Object.hasOwn(options, key) && key !== "image" && key !== "commercial-review") {
      throw new TypeError(`unknown license verifier argument: ${name}`);
    }
    options[key] = value;
  }
  if (options.scope !== "pr" && options.scope !== "release") {
    throw new TypeError("license verifier scope is invalid");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceLockPath = resolve(options.lock);
  const [sourceLockBytes, policy, exceptions, baseLock] = await Promise.all([
    readFile(sourceLockPath),
    readJson(resolve(options.policy)),
    readJson(resolve(options.exceptions)),
    readJson(resolve(options["base-lock"])),
  ]);
  const lock = JSON.parse(sourceLockBytes.toString("utf8"));
  validateSourceLock(lock);
  validateBaseImageLock(baseLock);
  for (const source of lock.sources) {
    if (!Array.isArray(source.licenses) || source.licenses.length === 0) {
      throw new TypeError(`source ${source.name ?? "unknown"} has no licenses`);
    }
    for (const license of source.licenses) {
      const decision = evaluateSpdxExpression(license, policy);
      if (decision === "prohibited" || decision === "unknown") {
        throw new TypeError(`source ${source.name ?? "unknown"} license is not allowed`);
      }
    }
  }
  validateVulnerabilityExceptions(exceptions);
  if (options.image !== undefined) {
    validateRuntimeInventory(inspectRuntimeImage(options.image), lock, policy);
  }
  let commercialReviewSha256;
  if (options.scope === "release") {
    if (options["commercial-review"] === undefined) {
      throw new TypeError("release scope requires --commercial-review");
    }
    const reviewBytes = await readFile(resolve(options["commercial-review"]));
    validateCommercialReview(JSON.parse(reviewBytes.toString("utf8")), sourceLockBytes);
    commercialReviewSha256 = createHash("sha256").update(reviewBytes).digest("hex");
  }
  process.stdout.write(
    `${JSON.stringify({
      verified: true,
      scope: options.scope,
      sourceLockSha256: createHash("sha256").update(sourceLockBytes).digest("hex"),
      ...(commercialReviewSha256 === undefined ? {} : { commercialReviewSha256 }),
    })}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "license verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}
