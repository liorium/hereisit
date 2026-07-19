#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [packagesPath, copyrightPathsPath, outputPath] = process.argv.slice(2);
if (packagesPath === undefined || copyrightPathsPath === undefined || outputPath === undefined) {
  throw new TypeError("packages, copyright paths, and output arguments are required");
}

const packages = (await readFile(packagesPath, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, version, unexpected] = line.split("\t");
    if (name === undefined || version === undefined || unexpected !== undefined) {
      throw new TypeError("Debian package inventory line is invalid");
    }
    return { name, version };
  });
const copyrightPaths = (await readFile(copyrightPathsPath, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean);

await writeFile(
  outputPath,
  `${JSON.stringify({
    schemaVersion: 1,
    snapshot: "20260716T000000Z",
    packages,
    copyrightPaths,
  })}\n`,
  { flag: "wx", mode: 0o644 },
);
