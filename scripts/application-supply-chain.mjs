#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  sha256Bytes,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const INVENTORY_MAXIMUM_BYTES = 2 * 1024 * 1024;
const PACKAGE_JSON_MAXIMUM_BYTES = 128 * 1024;
const LICENSE_TEXT_MAXIMUM_BYTES = 256 * 1024;
const NOTICES_MAXIMUM_BYTES = 4 * 1024 * 1024;
const SBOM_MAXIMUM_BYTES = 4 * 1024 * 1024;
const SCOPES = ["engine", "web-staging", "web-production", "worker", "lockfile"];
const APPLICATION_SCOPES = new Set(["web-staging", "web-production", "worker"]);
const MUST_NOT_SHIP = ["@img/sharp-libvips-linux-x64@1.2.4"];
const PNPM_VERSION = "11.11.0";
const SYFT_VERSION = "1.44.0";
const SYFT_IMAGE =
  "ghcr.io/anchore/syft@sha256:2baa4d24d90599840c0100a8d30deaa533821fcd99f405ce6f90e3d225bd836d";
const ALLOWED_LICENSES = [
  "0BSD",
  "Apache-2.0",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "(MIT AND Zlib)",
];
const PNPM_REQUEST = Object.freeze({
  command: "pnpm",
  args: [
    "licenses",
    "list",
    "--prod",
    "--json",
    "--filter",
    "@hereisit/web...",
    "--filter",
    "@hereisit/api-worker...",
  ],
  maxBuffer: INVENTORY_MAXIMUM_BYTES,
});

function defaultListProductionLicenses({ command, args, cwd, maxBuffer }) {
  return new Promise((fulfill, reject) => {
    execFile(command, args, { cwd, maxBuffer, encoding: "utf8", shell: false }, (error, stdout) => {
      if (error) reject(new Error("production dependency inventory failed"));
      else fulfill(stdout);
    });
  });
}

function ensureInside(path, root, label) {
  const rest = relative(root, path);
  if (rest === "" || rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new TypeError(`${label} escapes its allowed root`);
  }
}

function decodeUtf8(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
  } catch {
    throw new TypeError(`${label} must be UTF-8`);
  }
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      throw new TypeError(`${label} contains prohibited control characters`);
    }
  }
  return text;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} must be valid JSON`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function sameArray(actual, expected) {
  return (
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
  );
}

async function loadPolicy(path) {
  const bytes = await readBoundedRegularFile(path, 256 * 1024, "application license policy");
  const policy = assertObject(
    parseJson(bytes, "application license policy"),
    "application license policy",
  );
  if (!bytes.equals(Buffer.from(canonicalJson(policy)))) {
    throw new TypeError("application license policy must be byte-canonical");
  }
  assertExactKeys(
    policy,
    ["allowedLicenseExpressions", "fallbacks", "mustNotShip", "pnpm", "schemaVersion", "syft"],
    "application license policy",
  );
  if (policy.schemaVersion !== 1)
    throw new TypeError("application license policy version is invalid");
  if (!sameArray(policy.allowedLicenseExpressions ?? [], ALLOWED_LICENSES)) {
    throw new TypeError("application license allowlist drifted");
  }
  assertExactKeys(policy.pnpm, ["version"], "application license policy pnpm");
  assertExactKeys(policy.syft, ["image", "version"], "application license policy Syft");
  if (policy.pnpm.version !== PNPM_VERSION)
    throw new TypeError("application license pnpm version drifted");
  if (policy.syft.version !== SYFT_VERSION || policy.syft.image !== SYFT_IMAGE) {
    throw new TypeError("application license Syft identity drifted");
  }
  const mustNotShip = stringArray(policy.mustNotShip, "application license mustNotShip");
  if (!sameArray(mustNotShip, MUST_NOT_SHIP)) {
    throw new TypeError("application license mustNotShip drifted");
  }
  const fallbacks = assertObject(policy.fallbacks, "application license fallbacks");
  for (const [identity, fallbackValue] of Object.entries(fallbacks)) {
    nonEmptyString(identity, "application license fallback identity");
    const fallback = assertObject(fallbackValue, `fallback ${identity}`);
    if (fallback.kind === "package") {
      assertExactKeys(fallback, ["kind", "package"], `fallback ${identity}`);
      nonEmptyString(fallback.package, `fallback ${identity} package`);
    } else if (fallback.kind === "checked-in") {
      assertExactKeys(fallback, ["kind", "path", "sha256"], `fallback ${identity}`);
      nonEmptyString(fallback.path, `fallback ${identity} path`);
      assertSha256(fallback.sha256, `fallback ${identity} SHA-256`);
    } else if (fallback.kind === "root-readme") {
      assertExactKeys(fallback, ["kind", "path"], `fallback ${identity}`);
      if (fallback.path !== "README.md")
        throw new TypeError(`fallback ${identity} path is invalid`);
    } else {
      throw new TypeError(`fallback ${identity} kind is invalid`);
    }
  }
  return { policy, bytes, mustNotShip: new Set(mustNotShip), fallbacks };
}

async function assertRepository(root) {
  const resolved = resolve(root);
  const canonical = await realpath(resolved).catch(() => {
    throw new TypeError("repository root is invalid");
  });
  if (canonical !== resolved) throw new TypeError("repository root must not be symbolic");
  const packageBytes = await readBoundedRegularFile(
    join(canonical, "package.json"),
    128 * 1024,
    "root package",
  );
  const packageValue = assertObject(parseJson(packageBytes, "root package"), "root package");
  if (packageValue.packageManager !== `pnpm@${PNPM_VERSION}`) {
    throw new TypeError("root pnpm identity drifted");
  }
  const nodeModules = join(canonical, "node_modules");
  if ((await realpath(nodeModules).catch(() => undefined)) !== nodeModules) {
    throw new TypeError("repository node_modules is invalid");
  }
  return { root: canonical, nodeModules };
}

function validateInventoryRecord(recordValue, groupLicense, label) {
  const record = assertObject(recordValue, label);
  const allowedFields = new Set([
    "name",
    "versions",
    "paths",
    "license",
    "author",
    "homepage",
    "description",
  ]);
  if (Object.keys(record).some((field) => !allowedFields.has(field))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const field of ["name", "versions", "paths", "license"]) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`${label} fields are incomplete`);
  }
  const name = nonEmptyString(record.name, `${label} name`);
  const license = nonEmptyString(record.license, `${label} license`);
  if (license !== groupLicense) throw new TypeError(`${label} license grouping is invalid`);
  for (const field of ["author", "homepage", "description"]) {
    if (Object.hasOwn(record, field)) nonEmptyString(record[field], `${label} ${field}`);
  }
  const versions = stringArray(record.versions, `${label} versions`);
  const paths = stringArray(record.paths, `${label} paths`);
  if (versions.length !== paths.length || new Set(versions).size !== versions.length) {
    throw new TypeError(`${label} grouped versions and paths are invalid`);
  }
  return { name, license, versions, paths };
}

async function collectInventory(repository, rawInventory) {
  if (
    typeof rawInventory !== "string" ||
    Buffer.byteLength(rawInventory) > INVENTORY_MAXIMUM_BYTES
  ) {
    throw new RangeError("production dependency inventory is oversized");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawInventory);
  } catch {
    throw new TypeError("production dependency inventory is malformed");
  }
  const inventory = assertObject(parsed, "production dependency inventory");
  const paths = new Set();
  const identities = new Set();
  const packages = [];
  for (const [groupLicense, records] of Object.entries(inventory)) {
    nonEmptyString(groupLicense, "inventory license expression");
    if (!Array.isArray(records) || records.length === 0) {
      throw new TypeError("production dependency inventory records are invalid");
    }
    for (const [recordIndex, recordValue] of records.entries()) {
      const record = validateInventoryRecord(
        recordValue,
        groupLicense,
        `inventory record ${recordIndex}`,
      );
      for (let index = 0; index < record.paths.length; index += 1) {
        const packagePath = record.paths[index];
        if (!isAbsolute(packagePath))
          throw new TypeError("inventory package path must be absolute");
        const normalizedPath = resolve(packagePath);
        ensureInside(normalizedPath, repository.nodeModules, "inventory package path");
        if (paths.has(normalizedPath)) throw new TypeError("duplicate inventory package path");
        paths.add(normalizedPath);
        const canonicalPath = await realpath(normalizedPath).catch(() => {
          throw new TypeError("inventory package path could not be resolved");
        });
        if (canonicalPath !== normalizedPath) {
          throw new TypeError("inventory package path must not be symbolic");
        }
        ensureInside(canonicalPath, repository.nodeModules, "inventory package path");
        const packageBytes = await readBoundedRegularFile(
          join(canonicalPath, "package.json"),
          PACKAGE_JSON_MAXIMUM_BYTES,
          "inventory package manifest",
        );
        const manifest = assertObject(
          parseJson(packageBytes, "inventory package manifest"),
          "inventory package manifest",
        );
        const version = record.versions[index];
        if (
          manifest.name !== record.name ||
          manifest.version !== version ||
          manifest.license !== record.license
        ) {
          throw new TypeError("inventory package manifest identity does not agree with pnpm");
        }
        const identity = `${record.name}@${version}`;
        if (identities.has(identity)) throw new TypeError("duplicate inventory package identity");
        identities.add(identity);
        packages.push({
          identity,
          name: record.name,
          version,
          license: record.license,
          root: canonicalPath,
        });
      }
    }
  }
  packages.sort((left, right) =>
    left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0,
  );
  return packages;
}

async function directLicenseTexts(packageValue) {
  const entries = await readdir(packageValue.root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => /^(?:license|copying|notice)(?:[._-].*)?$/i.test(entry.name))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const texts = [];
  for (const candidate of candidates) {
    if (!candidate.isFile()) throw new TypeError("package license text must be a regular file");
    const bytes = await readBoundedRegularFile(
      join(packageValue.root, candidate.name),
      LICENSE_TEXT_MAXIMUM_BYTES,
      "package license text",
    );
    texts.push({ label: candidate.name, text: decodeUtf8(bytes, "package license text") });
  }
  return texts;
}

async function buildNotices(repository, policyState, packages) {
  const packageMap = new Map(packages.map((entry) => [entry.identity, entry]));
  const direct = new Map();
  for (const packageValue of packages)
    direct.set(packageValue.identity, await directLicenseTexts(packageValue));
  const usedFallbacks = new Set();
  const checkedInHashes = new Set();

  async function resolveTexts(identity, stack = new Set()) {
    if (stack.has(identity)) throw new TypeError("license fallback cycle detected");
    const packageValue = packageMap.get(identity);
    if (packageValue === undefined)
      throw new TypeError("license fallback package identity is missing");
    const own = direct.get(identity);
    const fallback = policyState.fallbacks[identity];
    if (own.length > 0) {
      if (fallback !== undefined) throw new TypeError("license fallback is unused");
      return own;
    }
    if (fallback === undefined) throw new TypeError("package is missing reviewed license text");
    usedFallbacks.add(identity);
    const nextStack = new Set(stack).add(identity);
    if (fallback.kind === "package") {
      return (await resolveTexts(fallback.package, nextStack)).map((entry) => ({
        label: `fallback ${fallback.package}: ${entry.label}`,
        text: entry.text,
      }));
    }
    if (fallback.kind === "checked-in") {
      const fallbackPath = resolve(repository.root, fallback.path);
      ensureInside(fallbackPath, repository.root, "checked-in license text");
      const bytes = await readBoundedRegularFile(
        fallbackPath,
        LICENSE_TEXT_MAXIMUM_BYTES,
        "checked-in license text",
      );
      const digest = sha256Bytes(bytes);
      if (digest !== fallback.sha256)
        throw new TypeError("checked-in license text SHA-256 changed");
      checkedInHashes.add(digest);
      return [
        {
          label: "reviewed checked-in license text",
          text: decodeUtf8(bytes, "checked-in license text"),
        },
      ];
    }
    const readmePath = resolve(packageValue.root, fallback.path);
    ensureInside(readmePath, packageValue.root, "fallback README");
    const bytes = await readBoundedRegularFile(
      readmePath,
      LICENSE_TEXT_MAXIMUM_BYTES,
      "fallback README",
    );
    return [{ label: fallback.path, text: decodeUtf8(bytes, "fallback README") }];
  }

  const thirdParty = packages.filter((entry) => !entry.name.startsWith("@hereisit/"));
  const sections = [];
  for (const packageValue of thirdParty) {
    const mustNotShip = policyState.mustNotShip.has(packageValue.identity);
    if (!ALLOWED_LICENSES.includes(packageValue.license)) {
      if (!(mustNotShip && packageValue.license === "LGPL-3.0-or-later")) {
        throw new TypeError("package license is not reviewed for application use");
      }
    }
    const texts = await resolveTexts(packageValue.identity);
    texts.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
    sections.push(
      `${"=".repeat(72)}\nPackage: ${packageValue.name}\nVersion: ${packageValue.version}\nLicense: ${packageValue.license}\n${texts
        .map((entry) => `\n--- ${entry.label} ---\n${entry.text.trimEnd()}\n`)
        .join("")}`,
    );
  }
  const unused = Object.keys(policyState.fallbacks).filter(
    (identity) => !usedFallbacks.has(identity),
  );
  if (unused.length > 0)
    throw new TypeError("application license policy contains an unused fallback");
  const text = `HereIsIt Third-Party Notices\n\nGenerated deterministically from the reviewed production dependency inventory.\n\n${sections.join("\n")}`;
  if (Buffer.byteLength(text) > NOTICES_MAXIMUM_BYTES)
    throw new RangeError("third-party notices are oversized");
  return {
    text,
    packageCount: thirdParty.length,
    noticeSha256: sha256Bytes(text),
    checkedInHashes: [...checkedInHashes].sort(),
  };
}

async function writeTextIfAbsentOrEqual(path, text) {
  await mkdir(resolve(path, ".."), { recursive: true });
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("notices output could not be inspected");
  }
  if (metadata !== undefined) {
    const existing = await readBoundedRegularFile(path, NOTICES_MAXIMUM_BYTES, "existing notices");
    if (!existing.equals(Buffer.from(text)))
      throw new TypeError("refusing to overwrite different notices");
    return;
  }
  try {
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("notices output could not be written");
    const existing = await readBoundedRegularFile(path, NOTICES_MAXIMUM_BYTES, "existing notices");
    if (!existing.equals(Buffer.from(text)))
      throw new TypeError("refusing to overwrite different notices");
  }
}

function verifySyftTool(metadata) {
  const tools = assertObject(metadata.tools, "SBOM tools");
  assertExactKeys(tools, ["components"], "SBOM tools");
  if (!Array.isArray(tools.components) || tools.components.length !== 1) {
    throw new TypeError("SBOM must contain exactly one Syft tool identity");
  }
  const tool = assertObject(tools.components[0], "SBOM Syft tool");
  assertExactKeys(tool, ["author", "name", "type", "version"], "SBOM Syft tool");
  if (
    tool.type !== "application" ||
    tool.author !== "anchore" ||
    tool.name !== "syft" ||
    tool.version !== SYFT_VERSION
  ) {
    throw new TypeError("SBOM Syft tool identity drifted");
  }
}

async function verifySbom(scope, descriptor, policyState) {
  assertExactKeys(descriptor, ["artifactSha256", "path"], `${scope} SBOM descriptor`);
  const artifactSha256 = assertSha256(descriptor.artifactSha256, `${scope} artifact SHA-256`);
  nonEmptyString(descriptor.path, `${scope} SBOM path`);
  const bytes = await readBoundedRegularFile(descriptor.path, SBOM_MAXIMUM_BYTES, `${scope} SBOM`);
  const sbom = assertObject(parseJson(bytes, `${scope} SBOM`), `${scope} SBOM`);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1) {
    throw new TypeError(`${scope} SBOM CycloneDX identity is invalid`);
  }
  const metadata = assertObject(sbom.metadata, `${scope} SBOM metadata`);
  verifySyftTool(metadata);
  const source = assertObject(metadata.component, `${scope} SBOM source`);
  const sourceName = `hereisit-${scope}:sha256-${artifactSha256}`;
  if (source.name !== sourceName) throw new TypeError(`${scope} SBOM source identity is invalid`);
  if (!Array.isArray(sbom.components) || sbom.components.length > 100_000) {
    throw new TypeError(`${scope} SBOM components are invalid`);
  }
  const identities = new Set();
  for (const componentValue of sbom.components) {
    const component = assertObject(componentValue, `${scope} SBOM component`);
    const name = nonEmptyString(component.name, `${scope} SBOM component name`);
    const version = nonEmptyString(component.version, `${scope} SBOM component version`);
    const identity = `${name}@${version}`;
    if (identities.has(identity))
      throw new TypeError(`${scope} SBOM contains a duplicate component`);
    identities.add(identity);
  }
  if (APPLICATION_SCOPES.has(scope)) {
    for (const prohibited of policyState.mustNotShip) {
      if (identities.has(prohibited))
        throw new TypeError(`${scope} SBOM contains a must not ship component`);
    }
  }
  return { artifactSha256, sbomSha256: sha256Bytes(bytes), componentCount: sbom.components.length };
}

function validateOptions(options) {
  const value = assertObject(options, "application supply-chain options");
  const common = ["lockfilePath", "mode", "noticesPath", "policyPath", "repositoryRoot"];
  const expected = value.mode === "verify" ? [...common, "gatePath", "sboms"] : common;
  if (value.mode !== "notices" && value.mode !== "verify") {
    throw new TypeError("application supply-chain mode is invalid");
  }
  assertExactKeys(value, expected, "application supply-chain options");
  for (const field of ["repositoryRoot", "policyPath", "lockfilePath", "noticesPath"]) {
    nonEmptyString(value[field], `application supply-chain ${field}`);
  }
  if (value.mode === "verify") nonEmptyString(value.gatePath, "application supply-chain gatePath");
  return value;
}

export async function runApplicationSupplyChain(options, adapters = {}) {
  const value = validateOptions(options);
  const repository = await assertRepository(value.repositoryRoot);
  const policyState = await loadPolicy(value.policyPath);
  const listProductionLicenses = adapters.listProductionLicenses ?? defaultListProductionLicenses;
  let rawInventory;
  try {
    rawInventory = await listProductionLicenses({
      ...PNPM_REQUEST,
      args: [...PNPM_REQUEST.args],
      cwd: repository.root,
    });
  } catch {
    throw new Error("production dependency inventory failed");
  }
  const packages = await collectInventory(repository, rawInventory);
  const notices = await buildNotices(repository, policyState, packages);
  if (value.mode === "notices") {
    await writeTextIfAbsentOrEqual(value.noticesPath, notices.text);
    return { noticeSha256: notices.noticeSha256, packageCount: notices.packageCount };
  }

  const noticesBytes = await readBoundedRegularFile(
    value.noticesPath,
    NOTICES_MAXIMUM_BYTES,
    "committed notices",
  );
  if (!noticesBytes.equals(Buffer.from(notices.text)))
    throw new TypeError("committed notices mismatch");
  const sboms = assertObject(value.sboms, "application SBOMs");
  assertExactKeys(sboms, SCOPES, "application SBOMs");
  const scopeResults = {};
  for (const scope of SCOPES)
    scopeResults[scope] = await verifySbom(scope, sboms[scope], policyState);
  const lockfileBytes = await readBoundedRegularFile(
    value.lockfilePath,
    16 * 1024 * 1024,
    "pnpm lockfile",
  );
  const gate = {
    schema: "hereisit-application-supply-chain-gate@1",
    passed: true,
    policySha256: sha256Bytes(policyState.bytes),
    lockfileSha256: sha256Bytes(lockfileBytes),
    noticesSha256: notices.noticeSha256,
    fallbackTextSha256: notices.checkedInHashes,
    pnpmVersion: PNPM_VERSION,
    syftVersion: SYFT_VERSION,
    syftImage: SYFT_IMAGE,
    reviewedPackageCount: notices.packageCount,
    scopes: scopeResults,
  };
  await writeCanonicalJsonAtomic(value.gatePath, gate, { refuseOverwrite: true });
  return gate;
}

function cliOptions(argv) {
  const values = parseCliArguments(argv);
  const mode = values.mode;
  const commonNames = new Set(["mode", "repository", "policy", "lockfile", "notices-output"]);
  const verifyNames = new Set([
    ...commonNames,
    "gate-output",
    ...SCOPES.flatMap((scope) => [`${scope}-sbom`, `${scope}-artifact-sha256`]),
  ]);
  const allowed = mode === "verify" ? verifyNames : mode === "notices" ? commonNames : new Set();
  if (
    Object.keys(values).some((name) => !allowed.has(name)) ||
    Object.keys(values).length !== allowed.size
  ) {
    throw new TypeError("CLI arguments are invalid");
  }
  const options = {
    mode,
    repositoryRoot: values.repository,
    policyPath: values.policy,
    lockfilePath: values.lockfile,
    noticesPath: values["notices-output"],
  };
  if (mode === "verify") {
    options.gatePath = values["gate-output"];
    options.sboms = Object.fromEntries(
      SCOPES.map((scope) => [
        scope,
        { path: values[`${scope}-sbom`], artifactSha256: values[`${scope}-artifact-sha256`] },
      ]),
    );
  }
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runApplicationSupplyChain(cliOptions(process.argv.slice(2)));
    process.stdout.write(canonicalJson(result));
  } catch {
    process.stderr.write("application supply-chain gate failed\n");
    process.exitCode = 1;
  }
}
