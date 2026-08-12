import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureBoundedDiagnostic,
  createPdfJobWorkspace,
  publishOutputAtomic,
  scrubPdfWorkspaceRoot,
  writeExactPdfInput,
} from "./workspace";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("PDF engine workspace", () => {
  it("creates private opaque paths and exact input", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-workspace-"));
    roots.push(root);
    const workspace = await createPdfJobWorkspace(root, "123e4567-e89b-42d3-a456-426614174001");
    expect((await stat(workspace.root)).mode & 0o777).toBe(0o700);
    expect(workspace.input.endsWith("input.bin")).toBe(true);
    await writeExactPdfInput({
      path: workspace.input,
      stream: Readable.from([Buffer.from("%PDF-x%%EOF")]),
      expectedBytes: 11,
    });
    expect((await lstat(workspace.input)).mode & 0o077).toBe(0);
    await expect(
      writeExactPdfInput({
        path: workspace.output,
        stream: Readable.from([Buffer.from("x")]),
        expectedBytes: 2,
      }),
    ).rejects.toThrow(/length/u);
  });

  it("scrubs orphans without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-scrub-"));
    const outside = await mkdtemp(join(tmpdir(), "hereisit-pdf-outside-"));
    roots.push(root, outside);
    await writeFile(join(root, "orphan"), "private");
    await writeFile(join(outside, "keep"), "keep");
    await symlink(outside, join(root, "link"));
    await scrubPdfWorkspaceRoot(root);
    expect(await readdir(root)).toEqual([]);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
  });

  it("bounds private diagnostics and publishes with an atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-publish-"));
    roots.push(root);
    const workspace = await createPdfJobWorkspace(root, "123e4567-e89b-42d3-a456-426614174001");
    await captureBoundedDiagnostic(Readable.from([Buffer.alloc(9000, 1)]), workspace.diagnostic);
    expect((await stat(workspace.diagnostic)).size).toBe(8192);
    expect((await stat(workspace.diagnostic)).mode & 0o077).toBe(0);
    await writeFile(workspace.structuralCandidate, "%PDF-a%%EOF", { mode: 0o600 });
    await publishOutputAtomic(workspace.structuralCandidate, workspace.output);
    expect(await readFile(workspace.output, "utf8")).toBe("%PDF-a%%EOF");
    expect((await readdir(workspace.root)).some((name) => name.includes("partial"))).toBe(false);
  });
});
