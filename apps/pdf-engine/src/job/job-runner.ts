import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type EngineCreatePdfJobRequest,
  engineCreatePdfJobRequestSchema,
  type PdfEngineJobStatus,
  pdfEngineJobStatusSchema,
} from "@hereisit/server-contracts";
import { qpdfArgs } from "./qpdf-command";
import {
  createPdfJobWorkspace,
  hashExactPdfInput,
  type PdfJobWorkspace,
  publishOutputAtomic,
  removePdfJobWorkspace,
  writeExactPdfInput,
  writeJsonAtomic,
} from "./workspace";

export interface QpdfUsage {
  readonly cpuMs: number;
  readonly peakRssBytes: number;
  readonly memoryByteMilliseconds: number;
}
export type QpdfProcessResult =
  | {
      readonly kind: "ok" | "invalid";
      readonly stdout: string;
      readonly diagnostic: Buffer;
      readonly usage?: QpdfUsage;
      readonly cleanupFailed?: boolean;
    }
  | {
      readonly kind: "failed" | "timeout" | "oom";
      readonly stdout: string;
      readonly diagnostic: Buffer;
      readonly usage?: QpdfUsage;
      readonly cleanupFailed?: boolean;
    };
export type QpdfRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<QpdfProcessResult>;

const EMPTY = { cpuMs: 0, memoryByteMilliseconds: 0, peakMemoryBytes: 0 } as const;

async function processRss(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
  if (rss === undefined) throw new Error("process memory is unavailable");
  return Number(rss) * 1024;
}

export interface ProcessTreeDependencies {
  readonly listPids: () => Promise<readonly number[]>;
  readonly readStat: (pid: number) => Promise<string>;
}

function parseProcessStat(value: string): {
  readonly parentPid: number;
  readonly processGroup: number;
} {
  const close = value.lastIndexOf(")");
  if (close < 2) throw new Error("process stat is invalid");
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroup))
    throw new Error("process stat is invalid");
  return { parentPid, processGroup };
}

function exited(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

export async function listDescendantProcessGroups(
  rootPid: number,
  dependencies?: ProcessTreeDependencies,
): Promise<readonly number[]> {
  const source = dependencies ?? {
    listPids: async () =>
      (await readdir("/proc", { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => Number(entry.name)),
    readStat: async (pid: number) => readFile(`/proc/${pid}/stat`, "utf8"),
  };
  const processes = new Map<number, ReturnType<typeof parseProcessStat>>();
  for (const pid of await source.listPids()) {
    try {
      processes.set(pid, parseProcessStat(await source.readStat(pid)));
    } catch (error) {
      if (pid === rootPid || !exited(error)) throw error;
    }
  }
  if (!processes.has(rootPid)) throw new Error("qpdf process is not measurable");
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, current] of processes) {
      if (!descendants.has(pid) && descendants.has(current.parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  const groups = new Set<number>();
  for (const pid of descendants) {
    if (pid === rootPid) continue;
    const group = processes.get(pid)?.processGroup;
    if (group !== undefined && group !== rootPid) groups.add(group);
  }
  return [...groups].sort((left, right) => left - right);
}

export async function measureProcessTreeUsage(
  rootPid: number,
  dependencies: ProcessTreeDependencies & { readonly readRss: (pid: number) => Promise<number> },
): Promise<{
  readonly rssBytes: number;
  readonly cpuMs: number;
  readonly processGroups: readonly number[];
}> {
  const processes = new Map<
    number,
    ReturnType<typeof parseProcessStat> & { readonly cpuMs: number }
  >();
  for (const pid of await dependencies.listPids()) {
    try {
      const value = await dependencies.readStat(pid);
      const parsed = parseProcessStat(value);
      const fields = value
        .slice(value.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const cpuMs = ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
      if (!Number.isFinite(cpuMs)) throw new Error("process CPU is invalid");
      processes.set(pid, { ...parsed, cpuMs });
    } catch (error) {
      if (pid === rootPid || !exited(error)) throw error;
    }
  }
  if (!processes.has(rootPid)) throw new Error("qpdf process is not measurable");
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, current] of processes) {
      if (!descendants.has(pid) && descendants.has(current.parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  let rssBytes = 0;
  let cpuMs = 0;
  const processGroups = new Set<number>();
  for (const pid of descendants) {
    try {
      rssBytes += await dependencies.readRss(pid);
    } catch (error) {
      if (pid !== rootPid && exited(error)) continue;
      throw error;
    }
    cpuMs += processes.get(pid)?.cpuMs ?? 0;
    const group = processes.get(pid)?.processGroup;
    if (pid !== rootPid && group !== undefined && group !== rootPid) processGroups.add(group);
  }
  return { rssBytes, cpuMs, processGroups: [...processGroups].sort((left, right) => left - right) };
}

export interface ProcessTerminationInput {
  readonly runnerPgid: number;
  readonly registeredProcessGroups?: readonly number[];
  readonly enumerate: () => Promise<readonly number[]>;
  readonly signal: (pgid: number, signal: NodeJS.Signals) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly alive: (pgid: number) => Promise<boolean>;
}

export async function terminateProcessGroups(input: ProcessTerminationInput): Promise<void> {
  const known = new Set(input.registeredProcessGroups ?? []);
  const enumerate = async () => {
    try {
      for (const pgid of await input.enumerate()) known.add(pgid);
    } catch {
      // Continue with the runner and every group observed before enumeration failed.
    }
  };
  const signal = async (pgid: number, value: NodeJS.Signals) => {
    await input.signal(pgid, value).catch(() => undefined);
  };
  await enumerate();
  for (const pgid of known) await signal(pgid, "SIGTERM");
  await signal(input.runnerPgid, "SIGTERM");
  await input.wait(250);
  await enumerate();
  for (const pgid of new Set([...known, input.runnerPgid])) {
    if (await input.alive(pgid)) await signal(pgid, "SIGKILL");
  }
  await input.wait(25);
  await enumerate();
  for (const pgid of new Set([...known, input.runnerPgid])) {
    if (await input.alive(pgid)) throw new Error("qpdf process group cleanup failed");
  }
}

async function killGroup(pid: number, registeredProcessGroups: readonly number[]): Promise<void> {
  const alive = async (pgid: number) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await terminateProcessGroups({
    runnerPgid: pid,
    registeredProcessGroups,
    enumerate: () => listDescendantProcessGroups(pid),
    signal: async (pgid, value) => {
      process.kill(-pgid, value);
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    alive,
  });
}

export async function settleProcessTermination(termination: Promise<void>): Promise<boolean> {
  try {
    await termination;
    return true;
  } catch {
    return false;
  }
}

export function qpdfEnvironment(workspace: { readonly home: string; readonly tmp: string }) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: workspace.home,
    TMPDIR: workspace.tmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  } as const;
}

export function createQpdfJobBudget(input: {
  readonly maxWallMs: number;
  readonly maxCpuMs: number;
  readonly now?: () => number;
}) {
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  let consumedCpuMs = 0;
  return {
    remaining: () => ({
      wallMs: Math.max(0, input.maxWallMs - Math.max(0, now() - startedAt)),
      cpuMs: Math.max(0, input.maxCpuMs - consumedCpuMs),
    }),
    recordCpu: (cpuMs: number) => {
      consumedCpuMs += Math.max(0, cpuMs);
    },
  };
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      total += info.size;
      return;
    }
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
  return total;
}

export function createQpdfProcessRunner(options: {
  readonly maxWallMs: number;
  readonly maxRssBytes: number;
  readonly maxCpuMs?: number;
  readonly maxWorkspaceBytes?: number;
  readonly workspaceRoot?: string;
  readonly workspaceHome: string;
  readonly workspaceTmp: string;
  readonly qpdfPath?: string;
}): QpdfRunner {
  const budget = createQpdfJobBudget({
    maxWallMs: options.maxWallMs,
    maxCpuMs: options.maxCpuMs ?? options.maxWallMs,
  });
  return async (args, signal) => {
    const available = budget.remaining();
    if (available.wallMs <= 0 || available.cpuMs <= 0)
      return { kind: "timeout", stdout: "", diagnostic: Buffer.alloc(0) };
    return new Promise((resolve) => {
      const child = spawn(options.qpdfPath ?? "/usr/local/bin/qpdf", [...args], {
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: qpdfEnvironment({ home: options.workspaceHome, tmp: options.workspaceTmp }),
      });
      if (child.pid === undefined || child.stdout === null || child.stderr === null)
        throw new Error("qpdf spawn failed");
      const pid = child.pid;
      let settled = false;
      let forced: Exclude<QpdfProcessResult["kind"], "ok"> | null = null;
      let termination = Promise.resolve(true);
      const stdout: Buffer[] = [];
      const diagnostics: Buffer[] = [];
      let stdoutBytes = 0;
      let diagnosticBytes = 0;
      let observedCpuMs = 0;
      let peakRssBytes = 0;
      let memoryByteMilliseconds = 0;
      let lastSampleAt = performance.now();
      const processGroups = new Set<number>();
      child.stdout.on("data", (raw: Buffer) => {
        if (stdoutBytes >= 1024) return;
        const chunk = Buffer.from(raw).subarray(0, 1024 - stdoutBytes);
        stdout.push(chunk);
        stdoutBytes += chunk.byteLength;
      });
      child.stderr.on("data", (raw: Buffer) => {
        if (diagnosticBytes >= 8192) return;
        const chunk = Buffer.from(raw).subarray(0, 8192 - diagnosticBytes);
        diagnostics.push(chunk);
        diagnosticBytes += chunk.byteLength;
      });
      const stop = (reason: "timeout" | "oom" | "failed") => {
        if (forced !== null) return;
        forced = reason;
        termination = settleProcessTermination(killGroup(pid, [...processGroups]));
      };
      const sample = async () => {
        const [usage, workspaceBytes] = await Promise.all([
          measureProcessTreeUsage(pid, {
            listPids: async () =>
              (await readdir("/proc", { withFileTypes: true }))
                .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
                .map((entry) => Number(entry.name)),
            readStat: (current) => readFile(`/proc/${current}/stat`, "utf8"),
            readRss: processRss,
          }),
          options.workspaceRoot === undefined
            ? Promise.resolve(0)
            : directoryBytes(options.workspaceRoot),
        ]);
        const sampledAt = performance.now();
        memoryByteMilliseconds += usage.rssBytes * Math.max(0, sampledAt - lastSampleAt);
        lastSampleAt = sampledAt;
        observedCpuMs = Math.max(observedCpuMs, usage.cpuMs);
        peakRssBytes = Math.max(peakRssBytes, usage.rssBytes);
        for (const pgid of usage.processGroups) processGroups.add(pgid);
        if (usage.rssBytes > options.maxRssBytes) stop("oom");
        else if (usage.cpuMs > available.cpuMs) stop("timeout");
        else if (workspaceBytes > (options.maxWorkspaceBytes ?? Number.MAX_SAFE_INTEGER))
          stop("oom");
      };
      const timeout = setTimeout(() => stop("timeout"), available.wallMs);
      const sampler = setInterval(() => {
        void sample().catch(async () => {
          try {
            process.kill(-pid, 0);
            stop("failed");
          } catch {
            // The close event is racing the final sample; close performs survivor cleanup.
          }
        });
      }, 100);
      void processRss(pid)
        .then((rssBytes) => {
          peakRssBytes = Math.max(peakRssBytes, rssBytes);
          if (rssBytes > options.maxRssBytes) stop("oom");
        })
        .catch(() => undefined);
      const abort = () => stop("failed");
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => stop("failed"));
      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(sampler);
        signal?.removeEventListener("abort", abort);
        const normalCleanup =
          forced === null
            ? settleProcessTermination(
                terminateProcessGroups({
                  runnerPgid: pid,
                  registeredProcessGroups: [...processGroups],
                  enumerate: () => listDescendantProcessGroups(pid),
                  signal: async (pgid, value) => {
                    process.kill(-pgid, value);
                  },
                  wait: (milliseconds) =>
                    new Promise((resolve) => setTimeout(resolve, milliseconds)),
                  alive: async (pgid) => {
                    try {
                      process.kill(-pgid, 0);
                      return true;
                    } catch {
                      return false;
                    }
                  },
                }),
              )
            : termination;
        const cleaned = await normalCleanup;
        budget.recordCpu(observedCpuMs);
        resolve({
          kind:
            code === 0 && forced === null && !signal?.aborted && cleaned
              ? "ok"
              : code !== 0 && forced === null && !signal?.aborted && cleaned
                ? "invalid"
                : (forced ?? "failed"),
          stdout: Buffer.concat(stdout).toString("utf8"),
          diagnostic: Buffer.concat(diagnostics),
          usage: { cpuMs: observedCpuMs, peakRssBytes, memoryByteMilliseconds },
          cleanupFailed: !cleaned,
        });
      });
    });
  };
}

function envelope(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) &&
    /%%EOF\s*$/u.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1"))
  );
}

async function regularFile(path: string, expectedBytes?: number): Promise<number | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (expectedBytes !== undefined && info.size !== expectedBytes)
    )
      return null;
    return info.size;
  } catch {
    return null;
  }
}

function failedStatus(
  request: EngineCreatePdfJobRequest,
  code: Extract<PdfEngineJobStatus, { state: "failed" }>["error"]["code"],
  processingMs: number,
  testedCandidates = 0,
): Extract<PdfEngineJobStatus, { state: "failed" }> {
  return {
    protocol: 1,
    jobId: request.jobId,
    state: "failed",
    phase: null,
    fraction: null,
    sequence: 4,
    measurements: {
      processedInputBytes: request.input.byteLength,
      ...EMPTY,
      testedCandidates,
      processingMs,
    },
    inspection: null,
    error: {
      code,
      retryable: code === "ENGINE_TIMEOUT" || code === "ENGINE_OOM" || code === "ENGINE_CRASH",
    },
  };
}

function processFailure(
  result: QpdfProcessResult,
): "ENGINE_TIMEOUT" | "ENGINE_OOM" | "ENGINE_CRASH" | null {
  if (result.kind === "ok" || result.kind === "invalid") return null;
  return result.kind === "timeout"
    ? "ENGINE_TIMEOUT"
    : result.kind === "oom"
      ? "ENGINE_OOM"
      : "ENGINE_CRASH";
}

async function inspectPdf(
  path: string,
  runQpdf: QpdfRunner,
  signal: AbortSignal | undefined,
): Promise<{ readonly pageCount: number; readonly encrypted: boolean } | QpdfProcessResult> {
  const check = await runQpdf(["--check", "--", path], signal);
  if (signal?.aborted) return { kind: "failed", stdout: "", diagnostic: Buffer.alloc(0) };
  if (check.kind !== "ok") return check;
  const pages = await runQpdf(["--show-npages", "--", path], signal);
  if (signal?.aborted) return { kind: "failed", stdout: "", diagnostic: Buffer.alloc(0) };
  if (pages.kind !== "ok") return pages;
  const pageCount = Number(pages.stdout.trim());
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100)
    return { kind: "invalid", stdout: "", diagnostic: Buffer.alloc(0) };
  const encryption = await runQpdf(["--show-encryption", "--", path], signal);
  if (signal?.aborted) return { kind: "failed", stdout: "", diagnostic: Buffer.alloc(0) };
  if (encryption.kind !== "ok") return encryption;
  return { pageCount, encrypted: !/not encrypted/iu.test(encryption.stdout) };
}

async function sensitiveCleanup(workspace: PdfJobWorkspace): Promise<void> {
  await Promise.all([
    rm(workspace.input, { force: true }),
    rm(workspace.structuralCandidate, { force: true }),
    rm(workspace.optimizedCandidate, { force: true }),
    rm(workspace.diagnostic, { force: true }),
    rm(workspace.home, { recursive: true, force: true }),
    rm(workspace.tmp, { recursive: true, force: true }),
  ]);
}

export async function runPdfOptimization(input: {
  readonly request: EngineCreatePdfJobRequest;
  readonly workspace: PdfJobWorkspace;
  readonly runQpdf: QpdfRunner;
  readonly signal?: AbortSignal;
  readonly engineBuildId?: string;
}): Promise<PdfEngineJobStatus> {
  const startedAt = performance.now();
  let testedCandidates = 0;
  let cpuMs = 0;
  let peakMemoryBytes = 0;
  let memoryByteMilliseconds = 0;
  const runQpdf: QpdfRunner = async (args, signal) => {
    const result = await input.runQpdf(args, signal);
    if (result.cleanupFailed) throw new PdfProcessCleanupError();
    cpuMs += result.usage?.cpuMs ?? 0;
    peakMemoryBytes = Math.max(peakMemoryBytes, result.usage?.peakRssBytes ?? 0);
    memoryByteMilliseconds += result.usage?.memoryByteMilliseconds ?? 0;
    return result;
  };
  const duration = () => Math.max(0, Math.round(performance.now() - startedAt));
  const terminalCleanup = async (status: PdfEngineJobStatus) => {
    await sensitiveCleanup(input.workspace);
    if (status.state !== "succeeded" || status.result.kind !== "download")
      await rm(input.workspace.output, { force: true });
    return "measurements" in status
      ? {
          ...status,
          measurements: {
            ...status.measurements,
            cpuMs,
            peakMemoryBytes,
            memoryByteMilliseconds,
          },
        }
      : status;
  };
  const cancelled = (): Extract<PdfEngineJobStatus, { state: "cancelled" }> => ({
    protocol: 1,
    jobId: input.request.jobId,
    state: "cancelled",
    phase: null,
    fraction: null,
    sequence: 4,
    measurements: {
      processedInputBytes: input.request.input.byteLength,
      ...EMPTY,
      testedCandidates,
      processingMs: duration(),
    },
    inspection: null,
    error: { code: "CANCELLED", retryable: false },
  });
  try {
    if (input.signal?.aborted) return terminalCleanup(cancelled());
    if ((await regularFile(input.workspace.input, input.request.input.byteLength)) === null)
      return terminalCleanup(failedStatus(input.request, "INPUT_LIMIT_EXCEEDED", duration()));
    const source = await readFile(input.workspace.input);
    if (!envelope(source))
      return terminalCleanup(failedStatus(input.request, "UNSUPPORTED_INPUT", duration()));
    const sourceInspection = await inspectPdf(input.workspace.input, runQpdf, input.signal);
    const inputFailure = "kind" in sourceInspection ? processFailure(sourceInspection) : null;
    if (input.signal?.aborted) return terminalCleanup(cancelled());
    if (inputFailure !== null)
      return terminalCleanup(failedStatus(input.request, inputFailure, duration()));
    if ("kind" in sourceInspection)
      return terminalCleanup(failedStatus(input.request, "UNSUPPORTED_INPUT", duration()));
    if (sourceInspection.encrypted)
      return terminalCleanup(failedStatus(input.request, "UNSUPPORTED_FEATURE", duration()));
    if (sourceInspection.pageCount !== input.request.input.pageCount)
      return terminalCleanup(failedStatus(input.request, "VERIFICATION_FAILED", duration()));
    const candidates = [
      {
        profile: "structural" as const,
        path: input.workspace.structuralCandidate,
        args: qpdfArgs("structural", input.workspace.input, input.workspace.structuralCandidate),
      },
      {
        profile: "image-optimized" as const,
        path: input.workspace.optimizedCandidate,
        args: qpdfArgs(
          input.request.spec.preset,
          input.workspace.input,
          input.workspace.optimizedCandidate,
        ),
      },
    ];
    const accepted: Array<{
      readonly profile: "structural" | "image-optimized";
      readonly path: string;
      readonly size: number;
    }> = [];
    for (const candidate of candidates) {
      if (input.signal?.aborted) return terminalCleanup(cancelled());
      testedCandidates += 1;
      const execution = await runQpdf(candidate.args, input.signal);
      const failure = execution.kind === "invalid" ? "ENGINE_CRASH" : processFailure(execution);
      if (input.signal?.aborted) return terminalCleanup(cancelled());
      if (failure !== null)
        return terminalCleanup(failedStatus(input.request, failure, duration(), testedCandidates));
      const size = await regularFile(candidate.path);
      const maximum =
        input.request.input.byteLength -
        Math.max(1, Math.ceil(input.request.input.byteLength / 100));
      if (size === null || size > maximum || size < 10) {
        await rm(candidate.path, { force: true });
        continue;
      }
      const bytes = await readFile(candidate.path);
      if (!envelope(bytes)) {
        await rm(candidate.path, { force: true });
        continue;
      }
      const inspection = await inspectPdf(candidate.path, runQpdf, input.signal);
      if (input.signal?.aborted) return terminalCleanup(cancelled());
      const inspectionFailure = "kind" in inspection ? processFailure(inspection) : null;
      if (inspectionFailure !== null)
        return terminalCleanup(
          failedStatus(input.request, inspectionFailure, duration(), testedCandidates),
        );
      if (
        "kind" in inspection ||
        inspection.encrypted !== sourceInspection.encrypted ||
        inspection.pageCount !== sourceInspection.pageCount
      ) {
        await rm(candidate.path, { force: true });
        continue;
      }
      accepted.push({ profile: candidate.profile, path: candidate.path, size });
    }
    accepted.sort((left, right) => left.size - right.size);
    const selected = accepted[0];
    const build = input.engineBuildId ?? process.env.ENGINE_BUILD_ID ?? "hereisit-pdf-engine-v1";
    if (selected === undefined)
      return terminalCleanup({
        protocol: 1,
        jobId: input.request.jobId,
        state: "succeeded",
        phase: "preparing-output",
        fraction: 1,
        sequence: 4,
        result: {
          kind: "original-retained",
          sourceByteLength: input.request.input.byteLength,
          pageCount: sourceInspection.pageCount,
          engineBuildId: build,
          warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
        },
        inspection: {
          verifiedInputMime: "application/pdf",
          verifiedPageCount: sourceInspection.pageCount,
          encrypted: false,
        },
        measurements: {
          processedInputBytes: input.request.input.byteLength,
          ...EMPTY,
          testedCandidates,
          processingMs: duration(),
        },
      });
    await publishOutputAtomic(selected.path, input.workspace.output);
    const result =
      selected.profile === "structural"
        ? {
            kind: "download" as const,
            mime: "application/pdf" as const,
            sourceByteLength: input.request.input.byteLength,
            byteLength: selected.size,
            pageCount: sourceInspection.pageCount,
            profile: "structural" as const,
            engineBuildId: build,
            warnings: ["SIGNATURES_INVALIDATED"] as const,
          }
        : {
            kind: "download" as const,
            mime: "application/pdf" as const,
            sourceByteLength: input.request.input.byteLength,
            byteLength: selected.size,
            pageCount: sourceInspection.pageCount,
            profile: "image-optimized" as const,
            engineBuildId: build,
            warnings: ["SIGNATURES_INVALIDATED", "EMBEDDED_IMAGE_QUALITY_CHANGED"] as const,
          };
    return terminalCleanup({
      protocol: 1,
      jobId: input.request.jobId,
      state: "succeeded",
      phase: "preparing-output",
      fraction: 1,
      sequence: 4,
      result,
      inspection: {
        verifiedInputMime: "application/pdf",
        verifiedPageCount: sourceInspection.pageCount,
        encrypted: false,
      },
      measurements: {
        processedInputBytes: input.request.input.byteLength,
        ...EMPTY,
        testedCandidates,
        processingMs: duration(),
      },
    });
  } catch (error) {
    const status = await terminalCleanup(
      input.signal?.aborted
        ? cancelled()
        : failedStatus(input.request, "ENGINE_CRASH", duration(), testedCandidates),
    );
    if (error instanceof PdfProcessCleanupError) throw error;
    return status;
  }
}

export type PdfOptimizationRunner = (input: {
  readonly request: EngineCreatePdfJobRequest;
  readonly workspace: PdfJobWorkspace;
  readonly signal: AbortSignal;
}) => Promise<PdfEngineJobStatus>;

export function validateTerminalRunnerStatus(
  jobId: string,
  previousSequence: number,
  raw: unknown,
): PdfEngineJobStatus {
  const status = pdfEngineJobStatusSchema.parse(raw) as PdfEngineJobStatus;
  if (
    status.jobId !== jobId ||
    status.sequence <= previousSequence ||
    (status.state !== "succeeded" && status.state !== "failed" && status.state !== "cancelled")
  )
    throw new TypeError("runner status is invalid");
  return status;
}

interface Job {
  readonly request: EngineCreatePdfJobRequest;
  readonly identity: string;
  readonly workspace: PdfJobWorkspace;
  status: PdfEngineJobStatus;
  inputSha256: string | null;
  abort: AbortController | null;
  upload: { readonly promise: Promise<string>; readonly cancel: () => void } | null;
  completion: Promise<void> | null;
  removal: Promise<void> | null;
}
interface PdfControllerPersistence {
  readonly writeJson: typeof writeJsonAtomic;
  readonly removeWorkspace: typeof removePdfJobWorkspace;
}
export class PdfJobController {
  readonly #jobs = new Map<string, Job>();
  readonly #root: string;
  readonly #runner: PdfOptimizationRunner;
  readonly #persistence: PdfControllerPersistence;
  readonly #pending = new Map<
    string,
    { readonly identity: string; readonly promise: Promise<PdfEngineJobStatus> }
  >();
  #active: string | null = null;
  #accepting = true;
  constructor(input: {
    readonly workspaceRoot: string;
    readonly runner: PdfOptimizationRunner;
    readonly persistence?: Partial<PdfControllerPersistence>;
  }) {
    this.#root = input.workspaceRoot;
    this.#runner = input.runner;
    this.#persistence = {
      writeJson: input.persistence?.writeJson ?? writeJsonAtomic,
      removeWorkspace: input.persistence?.removeWorkspace ?? removePdfJobWorkspace,
    };
  }
  async create(
    raw: unknown,
  ): Promise<{ readonly replay: boolean; readonly status: PdfEngineJobStatus }> {
    if (!this.#accepting) throw new PdfEngineUnavailableError();
    const request = engineCreatePdfJobRequestSchema.parse(raw) as EngineCreatePdfJobRequest;
    const identity = JSON.stringify(request);
    const existing = this.#jobs.get(request.jobId);
    if (existing !== undefined) {
      if (existing.removal !== null) {
        await existing.removal;
        return this.create(raw);
      }
      if (existing.identity !== identity) throw new PdfJobConflictError();
      return { replay: true, status: existing.status };
    }
    const pending = this.#pending.get(request.jobId);
    if (pending !== undefined) {
      if (pending.identity !== identity) throw new PdfJobConflictError();
      return { replay: true, status: await pending.promise };
    }
    const promise = (async () => {
      const workspace = await createPdfJobWorkspace(this.#root, request.jobId);
      const status: PdfEngineJobStatus = {
        protocol: 1,
        jobId: request.jobId,
        state: "created",
        phase: null,
        fraction: null,
        sequence: 0,
      };
      const writes = await Promise.allSettled([
        this.#persistence.writeJson(workspace.request, request),
        this.#persistence.writeJson(workspace.status, status),
      ]);
      const rejected = writes.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        await this.#persistence.removeWorkspace(workspace);
        throw rejected.reason;
      }
      this.#jobs.set(request.jobId, {
        request,
        identity,
        workspace,
        status,
        inputSha256: null,
        abort: null,
        upload: null,
        completion: null,
        removal: null,
      });
      return status;
    })();
    this.#pending.set(request.jobId, { identity, promise });
    try {
      return { replay: false, status: await promise };
    } finally {
      if (this.#pending.get(request.jobId)?.promise === promise)
        this.#pending.delete(request.jobId);
    }
  }
  get(jobId: string) {
    return this.#jobs.get(jobId)?.status ?? null;
  }
  expectedInput(jobId: string) {
    return this.#jobs.get(jobId)?.request.input ?? null;
  }
  async upload(jobId: string, stream: Readable) {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new PdfJobNotFoundError();
    if (job.inputSha256 !== null) {
      const replay = await hashExactPdfInput(stream, job.request.input.byteLength);
      if (replay !== job.inputSha256) throw new PdfJobConflictError();
      return;
    }
    if (job.status.state !== "created") throw new PdfJobConflictError();
    if (job.upload !== null) {
      const replay = await hashExactPdfInput(stream, job.request.input.byteLength);
      const accepted = await job.upload.promise;
      if (replay !== accepted) throw new PdfJobConflictError();
      return;
    }
    const upload = (async () => {
      await writeExactPdfInput({
        path: job.workspace.input,
        stream,
        expectedBytes: job.request.input.byteLength,
      });
      const hash = createHash("sha256")
        .update(await readFile(job.workspace.input))
        .digest("hex");
      job.inputSha256 = hash;
      job.status = { protocol: 1, jobId, state: "ready", phase: null, fraction: null, sequence: 2 };
      await this.#persistence.writeJson(job.workspace.status, job.status);
      return hash;
    })();
    const pendingUpload = { promise: upload, cancel: () => stream.destroy() };
    job.upload = pendingUpload;
    try {
      await upload;
    } finally {
      if (job.upload === pendingUpload) job.upload = null;
    }
  }
  async run(jobId: string) {
    if (!this.#accepting) throw new PdfEngineUnavailableError();
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new PdfJobNotFoundError();
    if (job.status.state === "running" || job.status.state === "succeeded") return;
    if (job.status.state !== "ready") throw new PdfJobConflictError();
    if (this.#active !== null) throw new PdfEngineBusyError();
    this.#active = jobId;
    job.abort = new AbortController();
    job.status = {
      protocol: 1,
      jobId,
      state: "running",
      phase: "validating",
      fraction: null,
      sequence: 3,
    };
    const abort = job.abort;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const completion = (async () => {
      try {
        try {
          await this.#persistence.writeJson(job.workspace.status, job.status);
        } catch {
          await this.#recordCrash(job);
          return;
        } finally {
          markStarted();
        }
        const status = await this.#runner({
          request: job.request,
          workspace: job.workspace,
          signal: abort.signal,
        });
        const parsed = validateTerminalRunnerStatus(jobId, job.status.sequence, status);
        await this.#persistence.writeJson(job.workspace.status, parsed);
        job.status = parsed;
      } catch (error) {
        if (error instanceof PdfProcessCleanupError) this.#accepting = false;
        await this.#recordCrash(job);
      } finally {
        if (this.#active === jobId) this.#active = null;
        job.abort = null;
        job.completion = null;
      }
    })();
    job.completion = completion;
    void completion;
    await started;
  }
  async #recordCrash(job: Job) {
    const crash = failedStatus(job.request, "ENGINE_CRASH", 0);
    let persisted = true;
    await this.#persistence.writeJson(job.workspace.status, crash).catch(() => {
      persisted = false;
    });
    if (persisted)
      await Promise.all([
        sensitiveCleanup(job.workspace),
        rm(job.workspace.output, { force: true }),
      ]).catch(() => undefined);
    else await this.#persistence.removeWorkspace(job.workspace).catch(() => undefined);
    job.status = crash;
  }
  async output(jobId: string) {
    const job = this.#jobs.get(jobId);
    if (job?.status.state !== "succeeded" || job.status.result.kind !== "download") return null;
    const file = await open(job.workspace.output, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size !== job.status.result.byteLength) {
      await file.close();
      throw new Error("verified output mismatch");
    }
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return {
      stream: file.createReadStream({ autoClose: true, start: 0, end: info.size - 1 }),
      byteLength: info.size,
      digest: `sha-256=${hash.digest("base64")}`,
    };
  }
  async remove(jobId: string) {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    if (job.removal !== null) return job.removal;
    const removal = (async () => {
      job.abort?.abort();
      const upload = job.upload;
      if (upload !== null) {
        upload.cancel();
        const settled = await settleWithin(upload.promise, 1_000);
        if (!settled) {
          this.#accepting = false;
          throw new PdfEngineUnavailableError();
        }
      }
      await job.completion;
      if (this.#jobs.get(jobId) === job) this.#jobs.delete(jobId);
      await this.#persistence.removeWorkspace(job.workspace);
      if (this.#active === jobId) this.#active = null;
    })();
    job.removal = removal;
    return removal;
  }
  stopAccepting() {
    this.#accepting = false;
  }
  async waitForIdle(graceMs: number) {
    const end = Date.now() + graceMs;
    while (this.#active !== null && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return this.#active === null;
  }
  async cancelActive() {
    if (this.#active !== null) await this.remove(this.#active);
  }
}
export class PdfJobNotFoundError extends Error {}
export class PdfJobConflictError extends Error {}
export class PdfEngineBusyError extends Error {}
export class PdfEngineUnavailableError extends Error {}
class PdfProcessCleanupError extends Error {}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), milliseconds);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}
