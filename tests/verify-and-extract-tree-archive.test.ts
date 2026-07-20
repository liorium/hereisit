import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const createScript = resolve("scripts/create-deterministic-tree-archive.mjs");
const verifyScript = resolve("scripts/verify-and-extract-tree-archive.mjs");
const temporaryRoots: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hereisit-tree-extract-"));
  temporaryRoots.push(directory);
  return directory;
}

async function run(script: string, args: string[]) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeOctal(header: Buffer, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  header.fill(0, offset, offset + length);
  header.write(encoded, offset, length - 1, "ascii");
}

function rewriteChecksum(header: Buffer) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0");
  header.write(checksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

async function makeFixture(temporary: string) {
  const root = join(temporary, "source");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "abc");
  await writeFile(join(root, "assets", "run.js"), "console.log('ok');\n");
  await chmod(join(root, "assets", "run.js"), 0o755);
  const archive = join(temporary, "tree.tar");
  const result = JSON.parse(
    (await run(createScript, ["--root", root, "--output", archive])).stdout,
  );
  return { archive, result, root };
}

async function runVerifier(
  archive: string,
  output: string,
  archiveSha256: string,
  treeSha256: string,
) {
  return run(verifyScript, [
    "--archive",
    archive,
    "--expected-archive-sha256",
    archiveSha256,
    "--expected-tree-sha256",
    treeSha256,
    "--output",
    output,
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("deterministic tree archive verifier", () => {
  it("verifies both hashes and atomically extracts files with normalized modes", async () => {
    const temporary = await temporaryDirectory();
    const { archive, result } = await makeFixture(temporary);
    const output = join(temporary, "extracted");

    const verified = JSON.parse(
      (await runVerifier(archive, output, result.archiveSha256, result.treeSha256)).stdout,
    );

    expect(verified).toEqual(result);
    expect(await readFile(join(output, "index.html"), "utf8")).toBe("abc");
    expect(await readFile(join(output, "assets", "run.js"), "utf8")).toBe("console.log('ok');\n");
    expect((await stat(join(output, "index.html"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(output, "assets", "run.js"))).mode & 0o777).toBe(0o755);
  });

  it("rejects a wrong archive hash before creating the destination", async () => {
    const temporary = await temporaryDirectory();
    const { archive, result } = await makeFixture(temporary);
    const output = join(temporary, "extracted");

    await expect(
      runVerifier(archive, output, "0".repeat(64), result.treeSha256),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("archive SHA-256 mismatch") });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a wrong tree hash without publishing a partial destination", async () => {
    const temporary = await temporaryDirectory();
    const { archive, result } = await makeFixture(temporary);
    const output = join(temporary, "extracted");

    await expect(
      runVerifier(archive, output, result.archiveSha256, "0".repeat(64)),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("tree SHA-256 mismatch") });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an archive path that is a symbolic link", async () => {
    const temporary = await temporaryDirectory();
    const { archive, result } = await makeFixture(temporary);
    const link = join(temporary, "tree-link.tar");
    const output = join(temporary, "extracted");
    await symlink(archive, link);

    await expect(
      runVerifier(link, output, result.archiveSha256, result.treeSha256),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/symbolic|regular/i) });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "path escape",
      (bytes: Buffer) => {
        bytes.fill(0, 0, 100);
        bytes.write("../escape", 0, "utf8");
        rewriteChecksum(bytes.subarray(0, 512));
      },
      "member path is not canonical",
    ],
    [
      "symlink member",
      (bytes: Buffer) => {
        bytes[156] = "2".charCodeAt(0);
        rewriteChecksum(bytes.subarray(0, 512));
      },
      "only regular-file members are allowed",
    ],
    [
      "metadata drift",
      (bytes: Buffer) => {
        writeOctal(bytes.subarray(0, 512), 136, 12, 1);
        rewriteChecksum(bytes.subarray(0, 512));
      },
      "header metadata is not canonical",
    ],
    [
      "non-zero data padding",
      (bytes: Buffer) => {
        const size = Number.parseInt(bytes.subarray(124, 135).toString("ascii"), 8);
        bytes[512 + size] = 1;
      },
      "data padding must be zero",
    ],
    [
      "trailing archive block",
      (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(512)]),
      "archive must end with exactly two zero blocks",
    ],
  ])("rejects a canonical USTAR violation: %s", async (_label, mutate, expectedError) => {
    const temporary = await temporaryDirectory();
    const { archive, result } = await makeFixture(temporary);
    const original = await readFile(archive);
    const copy = Buffer.from(original);
    const changed = mutate(copy) ?? copy;
    const malicious = join(temporary, "malicious.tar");
    await writeFile(malicious, changed);
    const output = join(temporary, "extracted");

    await expect(
      runVerifier(malicious, output, digest(changed), result.treeSha256),
    ).rejects.toMatchObject({ stderr: expect.stringContaining(expectedError) });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(temporary, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing destination", async () => {
    const temporary = await temporaryDirectory();
    const { archive, result } = await makeFixture(temporary);
    const output = join(temporary, "extracted");
    await mkdir(output);
    await writeFile(join(output, "sentinel.txt"), "keep-me");

    await expect(
      runVerifier(archive, output, result.archiveSha256, result.treeSha256),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("destination already exists") });
    expect(await readFile(join(output, "sentinel.txt"), "utf8")).toBe("keep-me");
  });
});
