import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/create-deterministic-tree-archive.mjs");
const temporaryRoots: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hereisit-tree-archive-"));
  temporaryRoots.push(directory);
  return directory;
}

async function runCreator(root: string, output: string, extra: string[] = []) {
  return execFileAsync(process.execPath, [script, "--root", root, "--output", output, ...extra], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("deterministic tree archive creator", () => {
  it("produces identical canonical USTAR bytes despite host metadata drift", async () => {
    const temporary = await temporaryDirectory();
    const first = join(temporary, "first");
    const second = join(temporary, "second");
    await mkdir(join(first, "assets"), { recursive: true });
    await mkdir(join(second, "assets"), { recursive: true });
    await writeFile(join(first, "index.html"), "<h1>HereIsIt</h1>\n");
    await writeFile(join(first, "assets", "앱.js"), "export const ready = true;\n");
    await writeFile(join(second, "index.html"), "<h1>HereIsIt</h1>\n");
    await writeFile(join(second, "assets", "앱.js"), "export const ready = true;\n");
    await chmod(join(first, "index.html"), 0o600);
    await chmod(join(second, "index.html"), 0o644);
    await utimes(join(first, "index.html"), new Date(1_000), new Date(2_000));
    await utimes(join(second, "index.html"), new Date(3_000), new Date(4_000));

    const firstArchive = join(temporary, "first.tar");
    const secondArchive = join(temporary, "second.tar");
    const firstResult = JSON.parse((await runCreator(first, firstArchive)).stdout);
    const secondResult = JSON.parse((await runCreator(second, secondArchive)).stdout);
    const firstBytes = await readFile(firstArchive);
    const secondBytes = await readFile(secondArchive);

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(firstBytes.byteLength % 512).toBe(0);
    expect(firstBytes.subarray(-1024).equals(Buffer.alloc(1024))).toBe(true);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({ fileCount: 2, format: "ustar", version: 1 });
    expect(firstResult.archiveSha256).toBe(createHash("sha256").update(firstBytes).digest("hex"));
    expect(firstResult.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes only executable files to portable 0755 mode", async () => {
    const temporary = await temporaryDirectory();
    const root = join(temporary, "root");
    await mkdir(root);
    await writeFile(join(root, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "run.sh"), 0o711);
    const output = join(temporary, "tree.tar");

    await runCreator(root, output);
    const header = (await readFile(output)).subarray(0, 512);

    expect(header.subarray(100, 108).toString("ascii")).toBe("0000755\0");
    expect(header.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    expect(header.subarray(263, 265).toString("ascii")).toBe("00");
  });

  it.each([
    ["symbolic link", async (root: string) => symlink("target.txt", join(root, "link.txt"))],
    [
      "hard link",
      async (root: string) => {
        await writeFile(join(root, "target.txt"), "same inode");
        await link(join(root, "target.txt"), join(root, "hard.txt"));
      },
    ],
  ])("rejects a %s without leaving an archive", async (_label, arrange) => {
    const temporary = await temporaryDirectory();
    const root = join(temporary, "root");
    await mkdir(root);
    await writeFile(join(root, "plain.txt"), "plain");
    await arrange(root);
    const output = join(temporary, "tree.tar");

    await expect(runCreator(root, output)).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symbolic-link root", async () => {
    const temporary = await temporaryDirectory();
    const realRoot = join(temporary, "real-root");
    const linkedRoot = join(temporary, "linked-root");
    await mkdir(realRoot);
    await writeFile(join(realRoot, "index.html"), "safe");
    await symlink(realRoot, linkedRoot);
    const output = join(temporary, "tree.tar");

    await expect(runCreator(linkedRoot, output)).rejects.toMatchObject({
      stderr: expect.stringContaining("archive root must be a real directory"),
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects per-file and total-size limits before publishing output", async () => {
    const temporary = await temporaryDirectory();
    const root = join(temporary, "root");
    await mkdir(root);
    await writeFile(join(root, "large.bin"), Buffer.alloc(5, 1));
    const output = join(temporary, "tree.tar");

    await expect(runCreator(root, output, ["--max-file-bytes", "4"])).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runCreator(root, output, ["--max-tree-bytes", "4"])).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an output inside the source tree or an existing output", async () => {
    const temporary = await temporaryDirectory();
    const root = join(temporary, "root");
    await mkdir(root);
    await writeFile(join(root, "index.html"), "ok");
    await expect(runCreator(root, join(root, "nested.tar"))).rejects.toThrow();

    const output = join(temporary, "tree.tar");
    await writeFile(output, "keep-me");
    await expect(runCreator(root, output)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("keep-me");
  });

  it("rejects unknown CLI arguments", async () => {
    const temporary = await temporaryDirectory();
    const root = join(temporary, "root");
    const output = join(temporary, "tree.tar");
    await mkdir(dirname(join(root, "file.txt")), { recursive: true });
    await writeFile(join(root, "file.txt"), "data");

    await expect(runCreator(root, output, ["--surprise", "yes"])).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
