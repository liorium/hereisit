import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateVulnerabilityExceptions } from "./verify-image-engine-licenses.mjs";

export function checkSecurityExceptionExpiry(documents, now = new Date()) {
  const exceptions = documents.flatMap((document) =>
    validateVulnerabilityExceptions(document, now, {
      allowedScopes: ["engine", "web-staging", "web-production", "worker", "lockfile"],
    }),
  );
  return exceptions.map(({ cve, affectedScope, expiresAt }) => ({
    cve,
    scope: affectedScope,
    expiresAt,
    due: Date.parse(expiresAt) - now.getTime() <= 72 * 60 * 60 * 1000,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const documents = await Promise.all(
      [
        "apps/image-engine/security/vulnerability-exceptions.json",
        "security/application-vulnerability-exceptions.json",
      ].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    const checks = checkSecurityExceptionExpiry(documents);
    const due = checks.some((check) => check.due);
    process.stdout.write(`${JSON.stringify({ healthy: !due, checks })}\n`);
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone monitor is not a cached Turbo task.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      await appendFile(
        summaryPath,
        `\n## Security exception deadlines\n\n${checks.map((check) => `- ${check.cve} (${check.scope}): ${check.expiresAt}${check.due ? " — ACTION REQUIRED within 72 hours" : ""}`).join("\n") || "No active exceptions."}\n\nThis check does not change running service admission or renew approvals.\n`,
      );
    }
    if (due) {
      process.stderr.write(
        "::error::Security exception expires within 72 hours; replace the affected component or obtain fresh bounded approval.\n",
      );
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write(
      "::error::Security exception deadline check failed; verify exception validity and expiry.\n",
    );
    process.exitCode = 1;
  }
}
