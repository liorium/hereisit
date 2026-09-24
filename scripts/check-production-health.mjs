import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { imageOptimizePolicyResponseSchema } from "../packages/tool-contracts/src/image-optimize.ts";

async function readJson(response, signal) {
  if (response.body === null) throw new Error("missing body");
  const reader = response.body.getReader();
  // Keep the deadline attached to the body even if native fetch loses its abort listener.
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error("response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function checkProductionHealth({ fetchImpl = fetch } = {}) {
  const probes = [
    { name: "home-page", url: "https://hereisit.app/", kind: "page" },
    { name: "image-compress-page", url: "https://hereisit.app/image/compress", kind: "page" },
    {
      name: "api-job-readiness",
      url: "https://api.hereisit.app/health?requireJobs=1",
      kind: "health",
    },
    { name: "anonymous-image-policy", url: "https://api.hereisit.app/v1/policy", kind: "policy" },
  ];
  const checks = await Promise.all(
    probes.map(async ({ name, url, kind }) => {
      let response;
      let code = null;
      const signal = AbortSignal.timeout(10_000);
      try {
        response = await fetchImpl(url, {
          redirect: "error",
          cache: "no-store",
          signal,
          ...(kind !== "policy"
            ? {}
            : {
                method: "POST",
                headers: { "content-type": "application/json", origin: "https://hereisit.app" },
                body: JSON.stringify({
                  contract: "tool-job@1",
                  toolContract: "image.optimize@1",
                  anonymousSessionId: randomUUID(),
                }),
              }),
        });
        if (response.status !== 200) code = "HTTP_ERROR";
        else if (kind === "page") {
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "text/html"
          ) {
            code = "INVALID_RESPONSE";
          }
        } else {
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
          ) {
            throw new Error("unexpected content type");
          }
          const body = await readJson(response, signal);
          if (kind === "health") {
            if (body?.status !== "ok" || body.serverJobsEnabled !== true) code = "JOBS_UNAVAILABLE";
          } else {
            const policy = imageOptimizePolicyResponseSchema.parse(body);
            if (policy.maintainer) code = "UNEXPECTED_MAINTAINER_POLICY";
            else if (policy.execution !== "server") code = policy.reason;
          }
        }
      } catch {
        // Never copy response bodies, request identifiers, or transport errors into logs.
        code = response === undefined ? "REQUEST_FAILED" : "INVALID_RESPONSE";
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
      return { name, ok: code === null, status: response?.status ?? null, code };
    }),
  );
  return { schemaVersion: 1, healthy: checks.every((check) => check.ok), checks };
}

export async function runProductionHealthCheck({
  fetchImpl,
  stdout = process.stdout,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone monitor is not a cached Turbo task.
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  const report = await checkProductionHealth({ fetchImpl });
  stdout.write(`${JSON.stringify(report)}\n`);
  if (summaryPath) {
    const lines = report.checks.map(
      (check) =>
        `- ${check.name}: ${check.ok ? "PASS" : check.code} (HTTP ${check.status ?? "unavailable"})`,
    );
    await appendFile(
      summaryPath,
      [
        "## Production readiness",
        "",
        ...lines,
        "",
        "Read-only availability/admission checks. No file upload, compression job, deployment, or security exception is performed.",
        "This does not prove compression correctness, cost accounting, or artifact deletion.",
        "",
      ].join("\n"),
    );
  }
  return report.healthy ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProductionHealthCheck()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write("production readiness monitor failed\n");
      process.exitCode = 1;
    });
}
