import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import type { EngineCreatePdfJobRequest } from "@hereisit/server-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQpdfJobBudget,
  createQpdfProcessRunner,
  listDescendantProcessGroups,
  measureProcessTreeUsage,
  normalizeQpdfUsage,
  PdfEngineUnavailableError,
  PdfJobController,
  type QpdfProcessResult,
  qpdfEnvironment,
  runPdfOptimization,
  settleProcessTermination,
  terminateProcessGroups,
  validateTerminalRunnerStatus,
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
  it("normalizes sampled usage to the integer server contract without understating it", () => {
    expect(
      normalizeQpdfUsage({ cpuMs: 1.1, peakRssBytes: 2.1, memoryByteMilliseconds: 3.1 }),
    ).toEqual({ cpuMs: 2, peakRssBytes: 3, memoryByteMilliseconds: 4 });
  });
  it("settles as a sanitized failure when process cleanup itself rejects", async () => {
    await expect(
      settleProcessTermination(Promise.reject(new Error("private cleanup detail"))),
    ).resolves.toBe(false);
  });

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

  it("cleans every observed detached group even after a normal runner exit", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([21]);
    await terminateProcessGroups({
      runnerPgid: 20,
      registeredProcessGroups: [21],
      enumerate: async () => {
        throw Object.assign(new Error("exited"), { code: "ENOENT" });
      },
      signal: async (pgid, value) => {
        signals.push([pgid, value]);
        if (value === "SIGKILL") alive.delete(pgid);
      },
      wait: async () => undefined,
      alive: async (pgid) => alive.has(pgid),
    });
    expect(signals).toContainEqual([21, "SIGTERM"]);
    expect(signals).toContainEqual([21, "SIGKILL"]);
  });

  it("cleans the runner group when its parent exited and enumeration fails", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([20]);
    await terminateProcessGroups({
      runnerPgid: 20,
      enumerate: async () => {
        throw Object.assign(new Error("parent exited"), { code: "ENOENT" });
      },
      signal: async (pgid, value) => {
        signals.push([pgid, value]);
        if (value === "SIGKILL") alive.delete(pgid);
      },
      wait: async () => undefined,
      alive: async (pgid) => alive.has(pgid),
    });
    expect(signals).toEqual([
      [20, "SIGTERM"],
      [20, "SIGKILL"],
    ]);
  });

  it("sums RSS and CPU across the complete descendant tree", async () => {
    const stats = new Map([
      [20, { stat: "20 (qpdf) S 1 20 20 0 0 0 0 0 0 0 10 20", rss: 100 }],
      [21, { stat: "21 (child) S 20 21 20 0 0 0 0 0 0 0 30 40", rss: 200 }],
      [30, { stat: "30 (other) S 1 30 30 0 0 0 0 0 0 0 90 90", rss: 900 }],
    ]);
    await expect(
      measureProcessTreeUsage(20, {
        listPids: async () => [...stats.keys()],
        readStat: async (pid) => stats.get(pid)?.stat ?? "",
        readRss: async (pid) => stats.get(pid)?.rss ?? 0,
      }),
    ).resolves.toEqual({ rssBytes: 300, cpuMs: 1000, processGroups: [21] });
  });

  it("captures a nonzero usage sample even when qpdf exits before the periodic sampler", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-fast-usage-"));
    roots.push(root);
    const runner = createQpdfProcessRunner({
      maxWallMs: 5000,
      maxRssBytes: 128 * 1024 * 1024,
      workspaceRoot: root,
      workspaceHome: root,
      workspaceTmp: root,
      qpdfPath: process.execPath,
    });
    const result = await runner(["-e", "setTimeout(() => process.exit(0), 25)"]);
    expect(result.kind).toBe("ok");
    expect(result.usage?.peakRssBytes).toBeGreaterThan(0);
  });

  it("accepts qpdf exit 3 as parsed output with recoverable warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-warning-exit-"));
    roots.push(root);
    const runner = createQpdfProcessRunner({
      maxWallMs: 5000,
      maxRssBytes: 128 * 1024 * 1024,
      workspaceRoot: root,
      workspaceHome: root,
      workspaceTmp: root,
      qpdfPath: process.execPath,
    });
    const result = await runner(["-e", "process.stdout.write('{}'); process.exit(3)"]);
    expect(result).toMatchObject({ kind: "ok", stdout: "{}", stdoutBytes: 2 });
  });

  it("terminates oversized stdout as a clean deterministic output-limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-output-limit-"));
    roots.push(root);
    const runner = createQpdfProcessRunner({
      maxWallMs: 5000,
      maxRssBytes: 128 * 1024 * 1024,
      workspaceRoot: root,
      workspaceHome: root,
      workspaceTmp: root,
      qpdfPath: process.execPath,
    });
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const result = await runner(
        ["-e", "process.stdout.write(Buffer.alloc(20 * 1024 * 1024))"],
        undefined,
        { maximumStdoutBytes: 16 * 1024 * 1024, captureStdoutBytes: 0 },
      );
      expect(result).toMatchObject({
        kind: "output-limit",
        cleanupFailed: false,
      });
      expect(result.stdoutBytes).toBeGreaterThan(16 * 1024 * 1024);
      expect(result.usage).toBeDefined();
      for (const measurement of Object.values(result.usage ?? {})) {
        expect(Number.isSafeInteger(measurement)).toBe(true);
      }
    }
  });

  it("fails closed on persistent or non-race resource measurement errors", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      measureProcessTreeUsage(20, {
        listPids: async () => [20],
        readStat: async () => {
          throw denied;
        },
        readRss: async () => 0,
      }),
    ).rejects.toBe(denied);
    await expect(
      measureProcessTreeUsage(20, {
        listPids: async () => [20],
        readStat: async () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        readRss: async () => 0,
      }),
    ).rejects.toThrow("gone");
  });

  it("tolerates only a descendant RSS ENOENT exit race", async () => {
    await expect(
      measureProcessTreeUsage(20, {
        listPids: async () => [20, 21],
        readStat: async (pid) =>
          pid === 20
            ? "20 (qpdf) S 1 20 20 0 0 0 0 0 0 0 10 20"
            : "21 (child) S 20 21 20 0 0 0 0 0 0 0 30 40",
        readRss: async (pid) => {
          if (pid === 21) throw Object.assign(new Error("gone"), { code: "ENOENT" });
          return 100;
        },
      }),
    ).resolves.toEqual({ rssBytes: 100, cpuMs: 300, processGroups: [] });
  });

  it("uses only the job-private HOME and TMPDIR", () => {
    expect(qpdfEnvironment({ home: "/safe/job/home", tmp: "/safe/job/tmp" })).toMatchObject({
      LD_LIBRARY_PATH: "/usr/local/lib",
      HOME: "/safe/job/home",
      TMPDIR: "/safe/job/tmp",
    });
  });

  it("shares one wall deadline and cumulative CPU budget across every qpdf invocation", () => {
    let now = 1_000;
    const budget = createQpdfJobBudget({ maxWallMs: 100, maxCpuMs: 50, now: () => now });
    expect(budget.remaining()).toEqual({ wallMs: 100, cpuMs: 50 });
    budget.recordCpu(30);
    now = 1_060;
    expect(budget.remaining()).toEqual({ wallMs: 40, cpuMs: 20 });
    budget.recordCpu(25);
    expect(budget.remaining()).toEqual({ wallMs: 40, cpuMs: 0 });
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
    if (args[0] === "--json=2")
      return {
        kind: "ok",
        stdout: JSON.stringify({ qpdf: [{}, {}] }),
        stdoutBytes: 23,
        diagnostic: Buffer.alloc(0),
      } as const;
    return options.process ?? ({ kind: "ok", stdout: "", diagnostic: Buffer.alloc(0) } as const);
  });
}

function streamDiscovery(...objects: Array<[number, string | string[]]>) {
  return JSON.stringify({
    qpdf: [
      {},
      Object.fromEntries(
        objects.map(([number, filter]) => [
          `obj:${number} 0 R`,
          { stream: { dict: { "/Filter": filter, "/Length": "99 0 R" } } },
        ]),
      ),
    ],
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

  it("aggregates actual qpdf CPU, peak RSS, and memory-time usage", async () => {
    const workspace = await fixture();
    const base = runner();
    let invocation = 0;
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => ({
      ...(await base(args, signal)),
      usage: {
        cpuMs: ++invocation,
        peakRssBytes: invocation * 100,
        memoryByteMilliseconds: invocation * 1000,
      },
    }));
    const result = await runPdfOptimization({ request, workspace, runQpdf });
    expect(result).toMatchObject({
      state: "succeeded",
      measurements: {
        cpuMs: 78,
        peakMemoryBytes: 1200,
        memoryByteMilliseconds: 78_000,
      },
    });
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
    await expect(stat(workspace.input)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["corrupt", Buffer.alloc(1000), "UNSUPPORTED_INPUT"],
    ["truncated", Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(992)]), "UNSUPPORTED_INPUT"],
  ])("rejects %s input", async (_name, bytes, code) => {
    const workspace = await fixture();
    await writeFile(workspace.input, bytes);
    const result = await runPdfOptimization({ request, workspace, runQpdf: runner() });
    expect(result).toMatchObject({ state: "failed", error: { code } });
    await expect(stat(workspace.input)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a compressed-stream expansion beyond the bounded admission ceiling", async () => {
    const workspace = await fixture();
    const compressed = deflateSync(Buffer.alloc(2 * 1024 * 1024, 65));
    const source = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n`,
      ),
      compressed,
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);
    await writeFile(workspace.input, source);
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      if (args[0] === "--json=2") {
        const stdout = streamDiscovery([6, "/FlateDecode"]);
        return {
          kind: "ok",
          stdout,
          stdoutBytes: Buffer.byteLength(stdout),
          diagnostic: Buffer.alloc(0),
        } as const;
      }
      if (args[0] === "--show-object=6,0")
        return {
          kind: "output-limit",
          stdout: "",
          stdoutBytes: 100 * 1024 * 1024 + 1,
          diagnostic: Buffer.alloc(0),
        } as const;
      return base(args, signal);
    });
    const result = await runPdfOptimization({
      request: { ...request, input: { ...request.input, byteLength: source.byteLength } },
      workspace,
      runQpdf,
    });
    expect(result).toMatchObject({
      state: "failed",
      error: { code: "INPUT_LIMIT_EXCEEDED", retryable: false },
      measurements: { testedCandidates: 0 },
    });
  });

  it("uses qpdf parsing for indirect Length, filter arrays, and CR-delimited Flate streams", async () => {
    const workspace = await fixture();
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      if (args[0] === "--json=2") {
        const stdout = streamDiscovery([9, ["/ASCIIHexDecode", "/FlateDecode"]]);
        return {
          kind: "ok",
          stdout,
          stdoutBytes: Buffer.byteLength(stdout),
          diagnostic: Buffer.alloc(0),
        } as const;
      }
      if (args[0] === "--show-object=9,0")
        return {
          kind: "output-limit",
          stdout: "",
          stdoutBytes: 100 * 1024 * 1024 + 1,
          diagnostic: Buffer.alloc(0),
        } as const;
      return base(args, signal);
    });
    await expect(runPdfOptimization({ request, workspace, runQpdf })).resolves.toMatchObject({
      state: "failed",
      error: { code: "INPUT_LIMIT_EXCEEDED" },
      measurements: { testedCandidates: 0 },
    });
    expect(runQpdf).toHaveBeenCalledWith(
      ["--show-object=9,0", "--filtered-stream-data", "--", workspace.input],
      undefined,
      { maximumStdoutBytes: 16 * 1024 * 1024 + 1, captureStdoutBytes: 0 },
    );
  });

  it("rejects cumulative decoded stream output across many individually bounded streams", async () => {
    const largeRequest = {
      ...request,
      input: { ...request.input, byteLength: 1024 * 1024 },
    };
    const workspace = await fixture(largeRequest);
    const base = runner();
    const decoded = 60 * 1024 * 1024;
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      if (args[0] === "--json=2") {
        const stdout = streamDiscovery([9, "/FlateDecode"], [10, "/FlateDecode"]);
        return {
          kind: "ok",
          stdout,
          stdoutBytes: Buffer.byteLength(stdout),
          diagnostic: Buffer.alloc(0),
        } as const;
      }
      if (args[0] === "--show-object=9,0")
        return {
          kind: "ok",
          stdout: "",
          stdoutBytes: decoded,
          diagnostic: Buffer.alloc(0),
        } as const;
      if (args[0] === "--show-object=10,0")
        return {
          kind: "output-limit",
          stdout: "",
          stdoutBytes: decoded,
          diagnostic: Buffer.alloc(0),
        } as const;
      return base(args, signal);
    });
    await expect(
      runPdfOptimization({ request: largeRequest, workspace, runQpdf }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "INPUT_LIMIT_EXCEEDED" },
    });
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

  it("rejects one invalid candidate and keeps the other valid candidate", async () => {
    const workspace = await fixture();
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await base(args, signal);
      if (args[0] === "--check" && args.at(-1)?.endsWith("optimized.pdf"))
        return { ...result, kind: "invalid" as const };
      return result;
    });
    await expect(runPdfOptimization({ request, workspace, runQpdf })).resolves.toMatchObject({
      state: "succeeded",
      result: { kind: "download", profile: "structural" },
    });
  });

  it("returns original-retained when every candidate is invalid", async () => {
    const workspace = await fixture();
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await base(args, signal);
      if (args[0] === "--check" && !args.at(-1)?.endsWith("input.bin"))
        return { ...result, kind: "invalid" as const };
      return result;
    });
    await expect(runPdfOptimization({ request, workspace, runQpdf })).resolves.toMatchObject({
      state: "succeeded",
      result: { kind: "original-retained" },
    });
  });

  it.each([
    "structural",
    "image",
  ] as const)("maps a nonzero %s transform with partial output to terminal engine failure", async (failedTransform) => {
    const workspace = await fixture();
    const base = runner({ structural: failedTransform === "image" ? 991 : 950 });
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await base(args, signal);
      const output = args.at(-1) ?? "";
      if (
        (failedTransform === "structural" && output.endsWith("structural.pdf")) ||
        (failedTransform === "image" && output.endsWith("optimized.pdf"))
      )
        return { ...result, kind: "invalid" as const };
      return result;
    });
    await expect(runPdfOptimization({ request, workspace, runQpdf })).resolves.toMatchObject({
      state: "failed",
      error: { code: "ENGINE_CRASH" },
    });
    await expect(stat(workspace.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps invalid source inspection to unsupported input", async () => {
    const workspace = await fixture();
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await base(args, signal);
      return args[0] === "--check" && args.at(-1)?.endsWith("input.bin")
        ? { ...result, kind: "invalid" as const }
        : result;
    });
    await expect(runPdfOptimization({ request, workspace, runQpdf })).resolves.toMatchObject({
      state: "failed",
      error: { code: "UNSUPPORTED_INPUT" },
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
      if (args[0] === "--json=2")
        return {
          kind: "ok",
          stdout: JSON.stringify({ qpdf: [{}, {}] }),
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
    await expect(stat(workspace.input)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["timeout", "ENGINE_TIMEOUT"],
    ["oom", "ENGINE_OOM"],
    ["failed", "ENGINE_CRASH"],
  ] as const)("maps candidate inspection %s to a terminal failure", async (kind, code) => {
    const workspace = await fixture();
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await base(args, signal);
      if (args[0] === "--check" && args.at(-1)?.endsWith("structural.pdf"))
        return { kind, stdout: "", diagnostic: Buffer.alloc(0) } as const;
      return result;
    });
    const result = await runPdfOptimization({ request, workspace, runQpdf });
    expect(result).toMatchObject({ state: "failed", error: { code } });
    expect(runQpdf.mock.calls.some(([args]) => args.at(-1)?.endsWith("optimized.pdf"))).toBe(false);
  });

  it("rechecks cancellation immediately after candidate inspection", async () => {
    const workspace = await fixture();
    const abort = new AbortController();
    const base = runner();
    const runQpdf = vi.fn(async (args: readonly string[], signal?: AbortSignal) => {
      const result = await base(args, signal);
      if (args[0] === "--check" && args.at(-1)?.endsWith("structural.pdf")) abort.abort();
      return result;
    });
    const result = await runPdfOptimization({ request, workspace, runQpdf, signal: abort.signal });
    expect(result).toMatchObject({ state: "cancelled", error: { code: "CANCELLED" } });
    expect(
      runQpdf.mock.calls.some(
        ([args]) => args[0] === "--show-npages" && args.at(-1)?.endsWith("structural.pdf"),
      ),
    ).toBe(false);
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
    await expect(stat(workspace.input)).rejects.toMatchObject({ code: "ENOENT" });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("PDF controller failure and concurrency boundaries", () => {
  async function createController(
    runner: ConstructorParameters<typeof PdfJobController>[0]["runner"],
  ) {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-controller-"));
    roots.push(root);
    const controller = new PdfJobController({ workspaceRoot: root, runner });
    await controller.create(request);
    return { root, controller };
  }

  it("serializes concurrent first uploads and rejects a conflicting body", async () => {
    const { controller } = await createController(async () => {
      throw new Error("not run");
    });
    const first = controller.upload(request.jobId, Readable.from([pdf(1000)]));
    const second = controller.upload(request.jobId, Readable.from([Buffer.alloc(1000, 1)]));
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("installs the run transition before awaiting running-status persistence", async () => {
    const blocked = deferred<void>();
    let writes = 0;
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-run-transition-"));
    roots.push(root);
    const controller = new PdfJobController({
      workspaceRoot: root,
      runner: async () => {
        throw new Error("runner must not start");
      },
      persistence: {
        writeJson: async (path, value) => {
          writes += 1;
          if (writes === 4) await blocked.promise;
          const { writeJsonAtomic } = await import("./workspace");
          await writeJsonAtomic(path, value);
        },
      },
    });
    await controller.create(request);
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    const running = controller.run(request.jobId);
    await vi.waitFor(() => expect(writes).toBe(4));
    const removal = controller.remove(request.jobId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(stat(join(root, request.jobId))).resolves.toBeDefined();
    blocked.resolve();
    await Promise.all([running, removal]);
    expect(controller.get(request.jobId)).toBeNull();
  });

  it("cancels and awaits a pending upload before deletion and same-ID recreation", async () => {
    const blocked = deferred<void>();
    const stream = Readable.from(
      (async function* () {
        yield pdf(500);
        await blocked.promise;
        yield pdf(500);
      })(),
    );
    const { controller } = await createController(async () => {
      throw new Error("not run");
    });
    const upload = controller.upload(request.jobId, stream);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const removal = controller.remove(request.jobId);
    const recreation = controller.create(request);
    await expect(
      Promise.race([recreation.then(() => "created"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    blocked.resolve();
    await Promise.allSettled([upload, removal]);
    await expect(recreation).resolves.toMatchObject({
      replay: false,
      status: { state: "created" },
    });
  });

  it("cancels a never-ending PUT so deletion and same-ID recreation stay bounded", async () => {
    const stream = new PassThrough();
    stream.write(pdf(500));
    const { controller, root } = await createController(async () => {
      throw new Error("not run");
    });
    const upload = controller.upload(request.jobId, stream);
    const uploadOutcome = upload.then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const removal = controller.remove(request.jobId);
    try {
      await expect(
        Promise.race([
          removal.then(() => "removed"),
          new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
        ]),
      ).resolves.toBe("removed");
    } finally {
      stream.destroy();
    }
    await expect(uploadOutcome).resolves.toBeInstanceOf(Error);
    await expect(controller.create(request)).resolves.toMatchObject({ replay: false });
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    await expect(readFile(join(root, request.jobId, "input.bin"))).resolves.toEqual(pdf(1000));
  });

  it("poisons the engine after survivor cleanup failure so no new job overlaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-poisoned-"));
    roots.push(root);
    const controller = new PdfJobController({
      workspaceRoot: root,
      runner: ({ request: current, workspace, signal }) =>
        runPdfOptimization({
          request: current,
          workspace,
          signal,
          runQpdf: async () => ({
            kind: "failed",
            stdout: "",
            diagnostic: Buffer.alloc(0),
            cleanupFailed: true,
          }),
        }),
    });
    await controller.create(request);
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    await controller.run(request.jobId);
    await expect.poll(() => controller.get(request.jobId)).toMatchObject({ state: "failed" });
    await expect(
      controller.create({
        ...request,
        jobId: "223e4567-e89b-42d3-a456-426614174002",
      }),
    ).rejects.toBeInstanceOf(PdfEngineUnavailableError);
  });

  it.each([
    "reject",
    "invalid",
  ] as const)("persists a sanitized crash when the runner returns %s", async (kind) => {
    const { controller, root } = await createController(async () => {
      if (kind === "reject") throw new Error("private runner detail");
      return { private: "invalid status" } as never;
    });
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    await controller.run(request.jobId);
    await expect
      .poll(() => controller.get(request.jobId))
      .toMatchObject({
        state: "failed",
        error: { code: "ENGINE_CRASH" },
      });
    expect(JSON.stringify(controller.get(request.jobId))).not.toContain("private");
    await expect(
      JSON.parse(await readFile(join(root, request.jobId, "status.json"), "utf8")),
    ).toMatchObject({ state: "failed", error: { code: "ENGINE_CRASH" } });
    await expect(stat(join(root, request.jobId, "input.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes output and candidates when a post-output runner failure is sanitized", async () => {
    const { controller, root } = await createController(async ({ workspace }) => {
      await Promise.all([
        writeFile(workspace.output, pdf(800)),
        writeFile(workspace.structuralCandidate, pdf(900)),
      ]);
      throw new Error("after output");
    });
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    await controller.run(request.jobId);
    await expect.poll(() => controller.get(request.jobId)).toMatchObject({ state: "failed" });
    await expect(readdir(join(root, request.jobId))).resolves.toEqual([
      "request.json",
      "status.json",
    ]);
  });

  it.each([
    [
      "wrong job",
      (status: Awaited<ReturnType<typeof runPdfOptimization>>) => ({
        ...status,
        jobId: "223e4567-e89b-42d3-a456-426614174002",
      }),
    ],
    [
      "non-terminal",
      () => ({
        protocol: 1,
        jobId: request.jobId,
        state: "running",
        phase: "validating",
        fraction: null,
        sequence: 3,
      }),
    ],
    [
      "non-monotonic",
      (status: Awaited<ReturnType<typeof runPdfOptimization>>) => ({ ...status, sequence: 3 }),
    ],
  ] as const)("rejects a %s runner status before persistence", async (_name, mutate) => {
    const terminal = {
      protocol: 1,
      jobId: request.jobId,
      state: "cancelled",
      phase: null,
      fraction: null,
      sequence: 4,
      measurements: {
        processedInputBytes: 1000,
        cpuMs: 0,
        memoryByteMilliseconds: 0,
        peakMemoryBytes: 0,
        testedCandidates: 0,
        processingMs: 0,
      },
      inspection: null,
      error: { code: "CANCELLED", retryable: false },
    } as const;
    expect(validateTerminalRunnerStatus(request.jobId, 3, terminal)).toEqual(terminal);
    expect(() => validateTerminalRunnerStatus(request.jobId, 3, mutate(terminal as never))).toThrow(
      "runner status is invalid",
    );
  });

  it("keeps a sanitized in-memory crash and cleans up when terminal status persistence fails", async () => {
    let writes = 0;
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-status-failure-"));
    roots.push(root);
    const controller = new PdfJobController({
      workspaceRoot: root,
      runner: async ({ request }) => ({
        protocol: 1,
        jobId: request.jobId,
        state: "cancelled",
        phase: null,
        fraction: null,
        sequence: 4,
        measurements: {
          processedInputBytes: 1000,
          cpuMs: 0,
          memoryByteMilliseconds: 0,
          peakMemoryBytes: 0,
          testedCandidates: 0,
          processingMs: 0,
        },
        inspection: null,
        error: { code: "CANCELLED", retryable: false },
      }),
      persistence: {
        writeJson: async (path, value) => {
          writes += 1;
          if (writes >= 5) throw new Error("private disk detail");
          const { writeJsonAtomic } = await import("./workspace");
          await writeJsonAtomic(path, value);
        },
      },
    });
    await controller.create(request);
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    await controller.run(request.jobId);
    await expect
      .poll(() => controller.get(request.jobId))
      .toMatchObject({
        state: "failed",
        error: { code: "ENGINE_CRASH" },
      });
    await expect(stat(join(root, request.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for runner cancellation before deleting and releasing the active job", async () => {
    const completion =
      deferred<ReturnType<typeof runPdfOptimization> extends Promise<infer T> ? T : never>();
    const { controller, root } = await createController(async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return completion.promise;
    });
    await controller.upload(request.jobId, Readable.from([pdf(1000)]));
    await controller.run(request.jobId);
    const removing = controller.remove(request.jobId);
    await expect(
      Promise.race([removing.then(() => "removed"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    completion.resolve({
      protocol: 1,
      jobId: request.jobId,
      state: "cancelled",
      phase: null,
      fraction: null,
      sequence: 4,
      measurements: {
        processedInputBytes: 1000,
        cpuMs: 0,
        memoryByteMilliseconds: 0,
        peakMemoryBytes: 0,
        testedCandidates: 0,
        processingMs: 0,
      },
      inspection: null,
      error: { code: "CANCELLED", retryable: false },
    });
    await removing;
    expect(controller.get(request.jobId)).toBeNull();
    await expect(stat(join(root, request.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a newly-created workspace when initial persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-create-failure-"));
    roots.push(root);
    const controller = new PdfJobController({
      workspaceRoot: root,
      runner: async () => {
        throw new Error("not run");
      },
      persistence: {
        writeJson: async () => {
          throw new Error("disk failure");
        },
      },
    });
    await expect(controller.create(request)).rejects.toThrow("disk failure");
    expect(await readdir(root)).toEqual([]);
    await expect(stat(join(root, request.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
