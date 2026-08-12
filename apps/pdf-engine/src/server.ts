import { createServer } from "node:http";
import { readPdfEngineConfig } from "./config";
import { createPdfEngineRequestHandler } from "./http/router";
import { createQpdfProcessRunner, PdfJobController, runPdfOptimization } from "./job/job-runner";
import { scrubPdfWorkspaceRoot } from "./job/workspace";
import { runPdfEngineSelfTest } from "./self-test";

async function startServer(): Promise<void> {
  const config = readPdfEngineConfig();
  await scrubPdfWorkspaceRoot(config.workspaceRoot);
  const controller = new PdfJobController({
    workspaceRoot: config.workspaceRoot,
    runner: ({ request, workspace, signal }) =>
      runPdfOptimization({
        request,
        workspace,
        signal,
        engineBuildId: config.build.engineBuildId,
        runQpdf: createQpdfProcessRunner({
          maxWallMs: config.maxWallMs,
          maxCpuMs: config.maxWallMs,
          maxRssBytes: config.maxRssBytes,
          maxWorkspaceBytes: config.maxWorkspaceBytes,
          workspaceRoot: workspace.root,
          workspaceHome: workspace.home,
          workspaceTmp: workspace.tmp,
        }),
      }),
  });
  const server = createServer(createPdfEngineRequestHandler({ controller, build: config.build }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      controller.stopAccepting();
      if (!(await controller.waitForIdle(config.shutdownGraceMs))) await controller.cancelActive();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    })().catch(() => {
      process.exitCode = 1;
      server.closeAllConnections();
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...(await runPdfEngineSelfTest()) })}\n`);
} else {
  await startServer();
}
