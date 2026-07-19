export function resolveRunnerModuleUrl(serverModuleUrl: string): URL {
  return new URL("./job/job-runner.mjs", serverModuleUrl);
}
