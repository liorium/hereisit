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

function trackedFetch(fetchImpl) {
  let httpStatus;
  return {
    fetch: async (...args) => {
      const response = await fetchImpl(...args);
      httpStatus = response.status;
      return response;
    },
    httpStatus: () => httpStatus,
  };
}

function failureKind(error, status) {
  if (status !== undefined && status >= 400) return "http-error";
  if (error instanceof Error && error.name === "ZodError") return "schema";
  if (!(error instanceof Error)) return "unknown";
  return (
    new Map([
      ["Analytics response row count is inconsistent.", "row-count"],
      ["Sampled Analytics results cannot seal provider usage.", "sampled"],
      ["Container provider GraphQL response contains errors.", "provider-error"],
      ["Container provider pagination envelope is invalid.", "pagination"],
      ["Container provider resource envelope is invalid.", "resource"],
      ["Container provider resource ordering is invalid.", "resource"],
    ]).get(error.message) ?? "invalid-response"
  );
}

async function projected(promise, project, httpStatus) {
  try {
    return { reachable: true, ...project(await promise) };
  } catch (error) {
    const status = httpStatus();
    return status === undefined
      ? { reachable: false }
      : { reachable: false, httpStatus: status, failure: failureKind(error, status) };
  }
}

export async function inspectProcessingCostProviders({
  state: stateValue,
  workerVersion: workerVersionValue,
  accountId,
  analyticsReadToken,
  logpushStatusToken,
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

  const logpushFetch = trackedFetch(fetchImpl);
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
  return { targetHourKey: state.targetHourKey, logpush, analytics, container };
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
