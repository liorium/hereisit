import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { EngineJobStatus } from "@hereisit/server-contracts";
import { readEngineConfig } from "./config";
import { createEngineRequestHandler } from "./http/router";
import {
  type EngineRunner,
  JobController,
  listDescendantProcessGroups,
  terminateProcessGroups,
} from "./job/job-controller";
import { captureCgroupBaseline, createLinuxResourceSampler } from "./job/resource-monitor";
import { resolveRunnerModuleUrl } from "./job/runner-path";
import {
  finalizeRunnerStatus,
  parseRunnerRecord,
  resourceFailureStatus,
  startResourceSupervisor,
} from "./job/runner-supervisor";
import { captureBoundedDiagnostic, scrubWorkspaceRoot } from "./job/workspace";
import { shutdownEngine } from "./lifecycle";
import { runEngineSelfTest } from "./self-test";

async function processGroupAlive(pgid: number): Promise<boolean> {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  const config = readEngineConfig();
  await scrubWorkspaceRoot(config.workspaceRoot);
  const runnerPath = fileURLToPath(resolveRunnerModuleUrl(import.meta.url));
  const runner: EngineRunner = {
    async start(input) {
      const cgroupBaseline = await captureCgroupBaseline();
      const startNs = process.hrtime.bigint();
      const child = spawn(
        process.execPath,
        [runnerPath, "--workspace", input.workspace.root, "--job-id", input.request.jobId],
        {
          cwd: input.workspace.root,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            TZ: "UTC",
            NODE_ENV: "production",
            ENGINE_BUILD_ID: config.build.engineBuildId,
            HOME: input.workspace.home,
            TMPDIR: input.workspace.tmp,
            TMP: input.workspace.tmp,
            TEMP: input.workspace.tmp,
          },
        },
      );
      if (child.pid === undefined || child.stdout === null || child.stderr === null) {
        throw new Error("runner spawn failed");
      }
      const runnerPgid = child.pid;
      const codecPgids = new Set<number>();
      const register = (pgid: number) => {
        codecPgids.add(pgid);
        input.onProcessGroup(pgid);
      };
      const unregister = (pgid: number) => {
        codecPgids.delete(pgid);
        input.onProcessGroupRemoved(pgid);
      };
      const terminate = async () => {
        if (!(await processGroupAlive(runnerPgid))) return;
        await terminateProcessGroups({
          runnerPgid,
          registeredCodecPgids: [...codecPgids],
          enumerate: () => listDescendantProcessGroups(runnerPgid),
          signal: async (pgid, signal) => {
            process.kill(-pgid, signal);
          },
          wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          alive: processGroupAlive,
        });
      };
      void captureBoundedDiagnostic(child.stderr, input.workspace.diagnostic).catch(
        () => undefined,
      );
      let runnerSequence = 3;
      let runnerReportedTerminal = false;
      const terminalCompletion = new Promise<EngineJobStatus>((resolve, reject) => {
        let terminal: EngineJobStatus | null = null;
        let protocolError: Error | null = null;
        let lastSequence = 0;
        let progressWrites = Promise.resolve();
        const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
        lines.on("line", (line) => {
          try {
            const record = parseRunnerRecord(line);
            if ("type" in record) {
              if (record.type === "process-group:add") register(record.pgid);
              else unregister(record.pgid);
              return;
            }
            if (record.sequence <= lastSequence)
              throw new Error("runner sequence is not increasing");
            lastSequence = record.sequence;
            runnerSequence = record.sequence;
            if (record.state === "running") {
              if (terminal !== null)
                throw new Error("runner emitted progress after terminal status");
              progressWrites = progressWrites.then(() => input.onProgress(record));
              progressWrites.catch((error) => {
                protocolError =
                  error instanceof Error
                    ? error
                    : new Error("runner progress could not be persisted");
                lines.close();
              });
              return;
            }
            if (
              record.state !== "succeeded" &&
              record.state !== "failed" &&
              record.state !== "cancelled"
            ) {
              throw new Error("runner emitted an inactive status");
            }
            if (terminal !== null) throw new Error("runner emitted multiple terminal statuses");
            runnerReportedTerminal = true;
            terminal = record;
          } catch (error) {
            protocolError = error instanceof Error ? error : new Error("runner output is invalid");
            lines.close();
          }
        });
        child.once("error", reject);
        child.once("close", (code) => {
          void progressWrites.then(
            () => {
              if (protocolError !== null) return reject(protocolError);
              if (code !== 0 || terminal === null) {
                return reject(new Error("runner exited without status"));
              }
              resolve(terminal);
            },
            (error) => reject(error),
          );
        });
      });
      const sampler = createLinuxResourceSampler({
        resourceClass: input.request.resourceClass,
        runnerPid: runnerPgid,
        workspaceRoot: input.workspace.root,
        outputPath: input.workspace.output,
        sourceBytes: input.request.input.byteLength,
        startNs,
        cgroupBaseline,
      });
      let latestObservation: Awaited<ReturnType<typeof sampler.sample>> | null = null;
      const supervisor = startResourceSupervisor({
        sample: () => sampler.sample(),
        onProcessGroup: register,
        acceptObservation: async (observation) => {
          if (observation.exceeded === null) latestObservation = observation;
          if (runnerReportedTerminal) return false;
          if (observation.exceeded?.exceeded !== "measurement") return true;
          return processGroupAlive(runnerPgid);
        },
      });
      const completion = Promise.race([
        terminalCompletion
          .then((status) => finalizeRunnerStatus(input.request, status, latestObservation))
          .catch(async (error) => {
            await terminate();
            throw error;
          }),
        supervisor.completion.then(async (observation) => {
          await terminate();
          return resourceFailureStatus(input.request, observation, runnerSequence + 1);
        }),
      ]).finally(() => supervisor.stop());
      return { runnerPgid, completion };
    },
  };

  const controller = new JobController({ workspaceRoot: config.workspaceRoot, runner });
  const server = createServer(createEngineRequestHandler({ controller, build: config.build }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  let shutdown: Promise<void> | null = null;
  const beginShutdown = () => {
    if (shutdown !== null) return;
    shutdown = shutdownEngine({
      graceMs: config.shutdownGraceMs,
      controller,
      closeServer: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    }).catch(() => {
      process.exitCode = 1;
      server.closeAllConnections();
    });
  };
  process.once("SIGTERM", beginShutdown);
  process.once("SIGINT", beginShutdown);
}

if (process.argv.includes("--self-test")) {
  const result = await runEngineSelfTest();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} else {
  await startServer();
}
