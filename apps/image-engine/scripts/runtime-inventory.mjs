import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";

const roots = ["/app", "/usr/local/bin", "/usr/local/lib", "/licenses", "/build-metadata"];
const requiredPaths = [
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

function insideAllowedRoot(path) {
  return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const entries = [];
const packageRecords = new Map();
const dynamicObjects = new Set();

async function walk(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    let resolvedTarget;
    try {
      resolvedTarget = await realpath(path);
    } catch {
      throw new Error(`broken runtime symlink: ${path}`);
    }
    if (!insideAllowedRoot(resolvedTarget)) {
      throw new Error(`runtime symlink escapes inventory roots: ${path}`);
    }
    entries.push({ path, type: "symlink", target, resolvedTarget });
    return;
  }
  if (stat.isDirectory()) {
    entries.push({ path, type: "directory" });
    for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported runtime filesystem entry: ${path}`);
  const digest = await sha256(path);
  entries.push({ path, type: "file", bytes: stat.size, mode: stat.mode & 0o777, sha256: digest });
  if (path.includes(`${sep}node_modules${sep}`) && basename(path) === "package.json") {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value.name === "string" && typeof value.version === "string") {
      const identity = `${value.name}@${value.version}`;
      const record = { name: value.name, version: value.version, license: value.license ?? null };
      const previous = packageRecords.get(identity);
      if (previous !== undefined && previous.license !== record.license) {
        throw new Error(`conflicting runtime package metadata: ${identity}`);
      }
      packageRecords.set(identity, record);
    }
  }
  const header = (await readFile(path)).subarray(0, 4);
  if (
    header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    (path.startsWith("/usr/local/") || path.endsWith(".node"))
  ) {
    dynamicObjects.add(path);
  }
}

for (const root of roots) await walk(root);

const required = [];
for (const path of requiredPaths) {
  let resolvedPath;
  try {
    resolvedPath = await realpath(path);
  } catch {
    throw new Error(`required runtime artifact is missing: ${path}`);
  }
  const stat = await lstat(resolvedPath);
  if (!stat.isFile()) throw new Error(`required runtime artifact is not a file: ${path}`);
  required.push({
    path,
    resolvedPath,
    sha256: await sha256(resolvedPath),
    mode: stat.mode & 0o777,
  });
}

const linkage = [];
for (const path of [...dynamicObjects].sort()) {
  const result = spawnSync("ldd", [path], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/=>\s+not found\b/.test(output)) throw new Error(`unresolved runtime linkage: ${path}`);
  linkage.push({ path, status: result.status, output });
}

const buildMetadata = {};
for (const name of (await readdir("/build-metadata"))
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  buildMetadata[name] = JSON.parse(await readFile(join("/build-metadata", name), "utf8"));
}

process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    uid: process.getuid?.() ?? null,
    entries,
    required,
    packages: [...packageRecords.values()].sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    ),
    linkage,
    buildMetadata,
  }),
);
