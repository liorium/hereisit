import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineCreatePdfJobRequest } from "@hereisit/server-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listDescendantProcessGroups,
  type QpdfProcessResult,
  runPdfOptimization,
  terminateProcessGroups,
} from "./job-runner";
import { createPdfJobWorkspace } from "./workspace";

const request: EngineCreatePdfJobRequest = {
  protocol: 1,
  jobId: "123e4567-e89b-42d3-a456-426614174001",
  attempt: 1,
  tool: "pdf.optimize",
  toolVersion: 1,
  spec: { version: 1, preset: "balanced" },
  specHash: "a".repeat(64),
  input: { byteLength: 1000, etag: "opaque", mimeHint: "application/pdf", pageCount: 2 },
  resourceClass: "pdf-standard-v1",
};

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("detached qpdf process cleanup", () => {
  it("discovers descendant process groups from a complete proc snapshot", async () => {
    const files = new Map([
      [20, "20 (qpdf runner) S 1 20 20 0 0"],
      [21, "21 (late child) S 20 21 20 0 0"],
      [22, "22 (same group helper) S 21 21 20 0 0"],
      [30, "30 (unrelated) S 1 30 30 0 0"],
    ]);
    await expect(
      listDescendantProcessGroups(20, {
        listPids: async () => [20, 21, 22, 30],
        readStat: async (pid) => files.get(pid) ?? "",
      }),
    ).resolves.toEqual([21]);
  });

  it("re-enumerates and kills a late child group before declaring cleanup complete", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([20, 21, 22]);
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce([21])
      .mockResolvedValueOnce([21, 22])
      .mockResolvedValueOnce([]);
    await terminateProcessGroups({
      runnerPgid: 20,
      enumerate,
      signal: async (pgid, value) => {
        signals.push([pgid, value]);
        if (value === "SIGKILL") alive.delete(pgid);
      },
      wait: async () => undefined,
      alive: async (pgid) => alive.has(pgid),
    });
    expect(signals).toEqual([
      [21, "SIGTERM"],
      [20, "SIGTERM"],
      [21, "SIGKILL"],
      [22, "SIGKILL"],
      [20, "SIGKILL"],
    ]);
  });
});

function pdf(size: number) {
  const prefix = Buffer.from("%PDF-1.7\n");
  const suffix = Buffer.from("\n%%EOF\n");
  return Buffer.concat([prefix, Buffer.alloc(size - prefix.length - suffix.length, 32), suffix]);
}

async function fixture(input = request) {
  const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-runner-"));
  roots.push(root);
  const workspace = await createPdfJobWorkspace(root, input.jobId);
  await writeFile(workspace.input, pdf(input.input.byteLength), { mode: 0o600 });
  return workspace;
}

function runner(
  options: {
    structural?: number;
    optimized?: number;
    pageCount?: number;
    encrypted?: boolean;
    process?: QpdfProcessResult;
  } = {},
) {
  return vi.fn(async (args: readonly string[], _signal?: AbortSignal) => {
    const output = args.at(-1);
    if (output?.endsWith("structural.pdf"))
      await writeFile(output, pdf(options.structural ?? 950), { mode: 0o600 });
    if (output?.endsWith("optimized.pdf"))
      await writeFile(output, pdf(options.optimized ?? 800), { mode: 0o600 });
    if (args[0] === "--show-npages")
      return {
        kind: "ok",
        stdout: String(options.pageCount ?? 2),
        diagnostic: Buffer.alloc(0),
      } as const;
    if (args[0] === "--show-encryption")
      return {
        kind: "ok",
        stdout: options.encrypted ? "R = 6" : "File is not encrypted",
        diagnostic: Buffer.alloc(0),
      } as const;
    return options.process ?? ({ kind: "ok", stdout: "", diagnostic: Buffer.alloc(0) } as const);
  });
}

describe("bounded PDF optimization", () => {
  it("selects the smallest valid candidate and exact profile warnings", async () => {
    const workspace = await fixture();
    const result = await runPdfOptimization({ request, workspace, runQpdf: runner() });
    expect(result).toMatchObject({
      state: "succeeded",
      result: {
        kind: "download",
        byteLength: 800,
        profile: "image-optimized",
        warnings: ["SIGNATURES_INVALIDATED", "EMBEDDED_IMAGE_QUALITY_CHANGED"],
      },
      inspection: { verifiedPageCount: 2, encrypted: false },
    });
    expect((await stat(workspace.output)).size).toBe(800);
    await expect(stat(workspace.input)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(workspace.structuralCandidate)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns original-retained when candidates expand or miss the 1% threshold", async () => {
    const workspace = await fixture();
    const result = await runPdfOptimization({
      request,
      workspace,
      runQpdf: runner({ structural: 991, optimized: 1001 }),
    });
    expect(result).toMatchObject({
      state: "succeeded",
      result: {
        kind: "original-retained",
        sourceByteLength: 1000,
        pageCount: 2,
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
      },
    });
    await expect(stat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["corrupt", Buffer.alloc(1000), "UNSUPPORTED_INPUT"],
    ["truncated", Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(992)]), "UNSUPPORTED_INPUT"],
  ])("rejects %s input", async (_name, bytes, code) => {
    const workspace = await fixture();
    await writeFile(workspace.input, bytes);
    const result = await runPdfOptimization({ request, workspace, runQpdf: runner() });
    expect(result).toMatchObject({ state: "failed", error: { code } });
    await expect(stat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects encrypted input and declared page mismatch", async () => {
    for (const options of [{ encrypted: true }, { pageCount: 3 }]) {
      const workspace = await fixture();
      const result = await runPdfOptimization({ request, workspace, runQpdf: runner(options) });
      expect(result).toMatchObject({
        state: "failed",
        error: { code: options.encrypted ? "UNSUPPORTED_FEATURE" : "VERIFICATION_FAILED" },
      });
    }
  });

  it("rejects a page-count-changing candidate and keeps a valid structural result", async () => {
    const workspace = await fixture();
    let calls = 0;
    const runQpdf = runner();
    const wrapped = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await runQpdf(args, signal);
      if (args[0] === "--show-npages" && ++calls === 3) return { ...result, stdout: "3" };
      return result;
    });
    const result = await runPdfOptimization({ request, workspace, runQpdf: wrapped });
    expect(result).toMatchObject({
      state: "succeeded",
      result: { kind: "download", profile: "structural", byteLength: 950 },
    });
  });

  it("rejects symlink candidates", async () => {
    const workspace = await fixture();
    const outside = join(workspace.root, "outside.pdf");
    await writeFile(outside, pdf(800));
    const runQpdf = vi.fn(async (args: readonly string[]) => {
      const output = args.at(-1);
      if (output?.endsWith("structural.pdf")) await writeFile(output, pdf(950));
      if (output?.endsWith("optimized.pdf")) await symlink(outside, output);
      if (args[0] === "--show-npages")
        return { kind: "ok", stdout: "2", diagnostic: Buffer.alloc(0) } as const;
      if (args[0] === "--show-encryption")
        return {
          kind: "ok",
          stdout: "File is not encrypted",
          diagnostic: Buffer.alloc(0),
        } as const;
      return { kind: "ok", stdout: "", diagnostic: Buffer.alloc(0) } as const;
    });
    const result = await runPdfOptimization({ request, workspace, runQpdf });
    expect(result).toMatchObject({ state: "succeeded", result: { profile: "structural" } });
  });

  it.each([
    ["timeout", "ENGINE_TIMEOUT"],
    ["oom", "ENGINE_OOM"],
    ["failed", "ENGINE_CRASH"],
  ] as const)("maps %s and cleans the terminal workspace", async (kind, code) => {
    const workspace = await fixture();
    const result = await runPdfOptimization({
      request,
      workspace,
      runQpdf: runner({ process: { kind, stdout: "", diagnostic: Buffer.alloc(20_000) } }),
    });
    expect(result).toMatchObject({ state: "failed", error: { code } });
    await expect(stat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels, terminates work, and removes private files", async () => {
    const workspace = await fixture();
    const abort = new AbortController();
    abort.abort();
    const result = await runPdfOptimization({
      request,
      workspace,
      runQpdf: runner(),
      signal: abort.signal,
    });
    expect(result).toMatchObject({ state: "cancelled", error: { code: "CANCELLED" } });
    await expect(stat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps diagnostics without exposing them in the public status", async () => {
    const workspace = await fixture();
    const result = await runPdfOptimization({
      request,
      workspace,
      runQpdf: runner({
        process: { kind: "failed", stdout: "", diagnostic: Buffer.alloc(20_000, 65) },
      }),
    });
    expect(JSON.stringify(result)).not.toContain("AAAA");
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  });
});
