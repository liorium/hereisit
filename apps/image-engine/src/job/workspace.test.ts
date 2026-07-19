import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureBoundedDiagnostic,
  createJobWorkspace,
  scrubWorkspaceRoot,
  writeExactInput,
  writeJsonAtomic,
} from "./workspace";

describe("engine workspace", () => {
  let root = "";
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("uses opaque private paths and records its own streamed SHA-256", async () => {
    root = await mkdtemp(join(tmpdir(), "hereisit-engine-workspace-"));
    const workspace = await createJobWorkspace(root, "123e4567-e89b-42d3-a456-426614174001");
    expect((await stat(workspace.root)).mode & 0o777).toBe(0o700);
    expect((await stat(workspace.home)).mode & 0o777).toBe(0o700);
    expect((await stat(workspace.tmp)).mode & 0o777).toBe(0o700);
    expect(workspace.input).not.toContain("photo.jpg");
    const digest = await writeExactInput({
      path: workspace.input,
      stream: Readable.from([Uint8Array.of(1), Uint8Array.of(2, 3)]),
      expectedBytes: 3,
    });
    expect(digest).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    expect(new Uint8Array(await readFile(workspace.input))).toEqual(Uint8Array.of(1, 2, 3));
    expect((await lstat(workspace.input)).mode & 0o077).toBe(0);
  });

  it("removes startup orphans without following symlinks", async () => {
    root = await mkdtemp(join(tmpdir(), "hereisit-engine-scrub-"));
    const external = await mkdtemp(join(tmpdir(), "hereisit-engine-external-"));
    const orphan = join(root, "orphan");
    await mkdir(orphan);
    await writeFile(join(orphan, "input.bin"), "secret");
    await writeFile(join(external, "keep.txt"), "keep");
    await symlink(external, join(root, "external-link"));
    await scrubWorkspaceRoot(root);
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(external, "keep.txt"), "utf8")).resolves.toBe("keep");
    await rm(external, { recursive: true, force: true });
  });

  it("publishes state atomically and caps process-local diagnostics", async () => {
    root = await mkdtemp(join(tmpdir(), "hereisit-engine-state-"));
    const workspace = await createJobWorkspace(root, "123e4567-e89b-42d3-a456-426614174001");
    await writeJsonAtomic(workspace.status, { state: "ready", sequence: 2 });
    expect(JSON.parse(await readFile(workspace.status, "utf8"))).toEqual({
      state: "ready",
      sequence: 2,
    });
    expect((await readdir(workspace.root)).some((name) => name.includes("partial"))).toBe(false);
    await captureBoundedDiagnostic(
      Readable.from([Buffer.alloc(6_000, 1), Buffer.alloc(6_000, 2)]),
      workspace.diagnostic,
    );
    expect((await stat(workspace.diagnostic)).size).toBe(8 * 1024);
    expect((await stat(workspace.diagnostic)).mode & 0o077).toBe(0);
  });
});
