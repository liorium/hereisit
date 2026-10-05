import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { queryContainerUsageHour } from "../apps/api-worker/src/container-provider-usage.ts";
import { checkLogpushHour, queryAnalyticsHour } from "../apps/api-worker/src/provider-usage.ts";
import {
  assertExactKeys,
  assertObject,
  canonicalJson,
  parseCliArguments,
} from "./image-lab-common.mjs";
import { readEnvelope } from "./inspect-cloudflare-token-identities.mjs";

const accountIdPattern = /^[0-9a-f]{32}$/;
const versionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const containerIdPattern = versionIdPattern;
const sha256Pattern = /^[0-9a-f]{64}$/;
const datasetPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function plainTextBinding(workerVersion, name) {
  const resources = assertObject(workerVersion.resources, "Worker version resources");
  if (!Array.isArray(resources.bindings) || resources.bindings.length > 256) {
    throw new TypeError("Worker version bindings are invalid");
  }
  const matches = resources.bindings.filter(
    (binding) => binding !== null && typeof binding === "object" && binding.name === name,
  );
  if (
    matches.length !== 1 ||
    matches[0].type !== "plain_text" ||
    typeof matches[0].text !== "string"
  ) {
    throw new TypeError(`Worker ${name} binding is invalid`);
  }
  return matches[0].text;
}

function trackedFetch(fetchImpl, captureErrorCodes = false) {
  let httpStatus;
  let providerErrorCodes;
  return {
    fetch: async (input, init) => {
      const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(8000) });
      httpStatus = response.status;
      if (captureErrorCodes && !response.ok) {
        try {
          // The runtime rejects non-OK responses before reading their bodies. Consume only that
          // error body here, bounded to 64 KiB, without cloning/retaining a second stream.
          const envelope = await readEnvelope(response);
          const codes = Array.isArray(envelope?.errors)
            ? envelope.errors
                .slice(0, 8)
                .map((error) => error?.code)
                .filter((code) => Number.isSafeInteger(code) && code >= 1000 && code <= 999999)
            : [];
          if (codes.length > 0) providerErrorCodes = [...new Set(codes)];
        } catch {
          // Original errors can contain credentials or destination URLs. Never print them.
        }
      }
      return response;
    },
    httpStatus: () => httpStatus,
    errorEvidence: () => (providerErrorCodes === undefined ? {} : { providerErrorCodes }),
  };
}

function failureKind(error, status) {
  if (status !== undefined && status >= 400) return "http-error";
  if (error instanceof Error && error.name === "ZodError") return "schema";
  if (!(error instanceof Error)) return "unknown";
  // Classify only our fixed messages; never include provider values or raw errors.
  if (
    /^Container (?:CPU time|allocated memory|allocated disk|(?:regional )?transmitted bytes) exceeds signed 64-bit storage\.$/.test(
      error.message,
    )
  )
    return "numeric-overflow";
  return (
    new Map([
      [
        "Configured provider usage schema does not match the runtime contract.",
        "contract-mismatch",
      ],
      ["Analytics response row count is inconsistent.", "row-count"],
      ["Sampled Analytics results cannot seal provider usage.", "sampled"],
      ["Container provider GraphQL response contains errors.", "provider-error"],
      ["Container provider pagination envelope is invalid.", "pagination"],
      ["Container provider resource envelope is invalid.", "resource"],
      ["Container provider resource ordering is invalid.", "resource"],
      ["Container provider usage response must be JSON.", "content-type"],
      ["Provider usage response must be JSON.", "content-type"],
    ]).get(error.message) ?? (status === undefined ? "no-response" : "invalid-response")
  );
}

async function projected(promise, project, httpStatus) {
  try {
    return { reachable: true, ...project(await promise) };
  } catch (error) {
    const status = httpStatus();
    const schemaIssues =
      error instanceof Error &&
      error.name === "ZodError" &&
      Array.isArray(error.issues) &&
      error.issues.length > 0
        ? error.issues
            .slice(0, 8)
            .map((issue) => `${String(issue.code)}:${issue.path.map(String).join(".")}`)
        : undefined;
    return {
      reachable: false,
      ...(status === undefined ? {} : { httpStatus: status }),
      failure: failureKind(error, status),
      ...(schemaIssues === undefined ? {} : { schemaIssues }),
    };
  }
}

export async function inspectProcessingCostProviders({
  state: stateValue,
  workerVersion: workerVersionValue,
  accountId,
  analyticsReadToken,
  logpushStatusToken,
  logpushRecoveryToken,
  fetchImpl = fetch,
}) {
  const state = assertObject(stateValue, "processing state");
  const workerVersion = assertObject(workerVersionValue, "Worker version");
  if (!accountIdPattern.test(accountId)) throw new TypeError("Cloudflare account ID is invalid");
  if (!versionIdPattern.test(state.activeVersionId) || workerVersion.id !== state.activeVersionId) {
    throw new TypeError("Worker version does not match the active processing state");
  }
  if (!Number.isSafeInteger(state.targetHourKey) || state.targetHourKey < 0) {
    throw new TypeError("processing target hour is invalid");
  }
  const jobIdSource = plainTextBinding(workerVersion, "LOGPUSH_JOB_ID");
  const jobId = Number(jobIdSource);
  if (!/^[1-9][0-9]*$/.test(jobIdSource) || !Number.isSafeInteger(jobId)) {
    throw new TypeError("Worker LOGPUSH_JOB_ID binding is invalid");
  }
  const applicationId = plainTextBinding(workerVersion, "CONTAINER_APPLICATION_ID");
  const dataset = plainTextBinding(workerVersion, "USAGE_ANALYTICS_DATASET_NAME");
  const providerUsageSchemaSha256 = plainTextBinding(workerVersion, "PROVIDER_USAGE_SCHEMA_SHA256");
  if (!containerIdPattern.test(applicationId)) {
    throw new TypeError("Worker CONTAINER_APPLICATION_ID binding is invalid");
  }
  if (!datasetPattern.test(dataset)) {
    throw new TypeError("Worker USAGE_ANALYTICS_DATASET_NAME binding is invalid");
  }
  if (!sha256Pattern.test(providerUsageSchemaSha256)) {
    throw new TypeError("Worker PROVIDER_USAGE_SCHEMA_SHA256 binding is invalid");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  const logpushFetch = trackedFetch(fetchImpl, true);
  const analyticsFetch = trackedFetch(fetchImpl);
  const containerFetch = trackedFetch(fetchImpl);
  const [logpush, analytics, container] = await Promise.all([
    projected(
      checkLogpushHour(logpushFetch.fetch, {
        accountId,
        token: logpushStatusToken,
        jobId,
        hourKey: state.targetHourKey,
      }),
      (result) => result,
      logpushFetch.httpStatus,
    ),
    projected(
      queryAnalyticsHour(analyticsFetch.fetch, {
        accountId,
        token: analyticsReadToken,
        dataset,
        environment: "production",
        hourKey: state.targetHourKey,
      }),
      (result) => ({
        handlerInvocationCount: result.handlerInvocationCount,
        groupCount: result.groups.length,
      }),
      analyticsFetch.httpStatus,
    ),
    projected(
      queryContainerUsageHour(containerFetch.fetch, {
        accountId,
        token: analyticsReadToken,
        applicationId,
        hourKey: state.targetHourKey,
        expectedSchemaSha256: providerUsageSchemaSha256,
      }),
      (result) => ({
        hasUsage:
          result.cpuMicroseconds !== "0" ||
          result.allocatedMemoryByteMilliseconds !== "0" ||
          result.allocatedDiskByteMilliseconds !== "0" ||
          result.transmittedBytes !== "0",
        regionCount: result.transmittedBytesByRegion.length,
      }),
      containerFetch.httpStatus,
    ),
  ]);
  const result = { targetHourKey: state.targetHourKey, logpush, analytics, container };
  Object.assign(logpush, logpushFetch.errorEvidence());
  if (
    [401, 403].includes(logpush.httpStatus) &&
    typeof logpushRecoveryToken === "string" &&
    logpushRecoveryToken.length > 0 &&
    logpushRecoveryToken !== logpushStatusToken
  ) {
    // Read-only A/B diagnosis. Never substitute recovery credentials into the runtime or mark
    // the primary credential healthy just because a different credential can read the same job.
    const recoveryFetch = trackedFetch(fetchImpl, true);
    result.logpushRecoveryComparison = await projected(
      checkLogpushHour(recoveryFetch.fetch, {
        accountId,
        token: logpushRecoveryToken,
        jobId,
        hourKey: state.targetHourKey,
      }),
      (value) => value,
      recoveryFetch.httpStatus,
    );
    Object.assign(result.logpushRecoveryComparison, recoveryFetch.errorEvidence());
  }
  if (analytics.failure === "sampled") {
    // Read-only A/B diagnosis: retain the original failure and never use these results to seal costs.
    const hourStart = new Date(state.targetHourKey * 3_600_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    result.analyticsQueryComparison = {};
    for (const [name, filter] of [
      ["indexed", "index1 = 'production:usage-v1'"],
      [
        "indexedSinceHour",
        `index1 = 'production:usage-v1' AND timestamp >= toDateTime('${hourStart}')`,
      ],
    ]) {
      const diagnosticFetch = trackedFetch((url, init) =>
        fetchImpl(url, { ...init, body: init.body.replace("WHERE ", `WHERE ${filter} AND `) }),
      );
      // No upper timestamp bound: delayed outbox writes still belong to their original event hour.
      result.analyticsQueryComparison[name] = await projected(
        queryAnalyticsHour(diagnosticFetch.fetch, {
          accountId,
          token: analyticsReadToken,
          dataset,
          environment: "production",
          hourKey: state.targetHourKey,
        }),
        (value) => ({
          handlerInvocationCount: value.handlerInvocationCount,
          groupCount: value.groups.length,
        }),
        diagnosticFetch.httpStatus,
      );
    }
  }
  return result;
}

export async function runProcessingCostProviderInspectionCli(
  argv,
  { env = process.env, fetchImpl = fetch, stdout = process.stdout } = {},
) {
  const args = parseCliArguments(argv);
  assertExactKeys(args, ["account-id", "state", "worker-version"], "provider inspection arguments");
  if (!env.PRODUCTION_ANALYTICS_READ_TOKEN || !env.PRODUCTION_LOGPUSH_STATUS_TOKEN) {
    throw new TypeError("production provider read tokens are required");
  }
  const result = await inspectProcessingCostProviders({
    state: JSON.parse(await readFile(resolve(args.state), "utf8")),
    workerVersion: JSON.parse(await readFile(resolve(args["worker-version"]), "utf8")),
    accountId: args["account-id"],
    analyticsReadToken: env.PRODUCTION_ANALYTICS_READ_TOKEN,
    logpushStatusToken: env.PRODUCTION_LOGPUSH_STATUS_TOKEN,
    logpushRecoveryToken: env.CLOUDFLARE_LOGPUSH_CLEANUP_API_TOKEN,
    fetchImpl,
  });
  stdout.write(canonicalJson(result));
  return result;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingCostProviderInspectionCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "processing provider inspection failed"}\n`,
    );
    process.exitCode = 1;
  }
}
