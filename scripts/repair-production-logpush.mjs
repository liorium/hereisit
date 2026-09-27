import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCloudflareProcessingResourceApi,
  logpushDestinationMatches,
} from "./cloudflare-processing-resource-api.mjs";
import { assertExactKeys, canonicalJson, parseCliArguments } from "./image-lab-common.mjs";

const workerScriptName = "hereisit-processing-production";
const usageLogBucketName = "hereisit-processing-usage-production";
const fields = [
  "CPUTimeMs",
  "Entrypoint",
  "EventTimestampMs",
  "EventType",
  "Outcome",
  "ScriptName",
  "ScriptVersion",
];

export async function repairProductionLogpush({
  api,
  config,
  credentials,
  expectedJobId,
  repairMissing,
}) {
  if (
    !/^[0-9a-f]{32}$/.test(config.accountId) ||
    config.environment !== "production" ||
    config.workerScriptName !== workerScriptName ||
    config.usageLogBucketName !== usageLogBucketName ||
    !Number.isSafeInteger(expectedJobId) ||
    expectedJobId < 1 ||
    typeof repairMissing !== "boolean"
  ) {
    throw new Error("Invalid production Logpush recovery scope");
  }
  const matchingJobs = async () => {
    const jobs = await api.readLogpushJobs();
    if (!Array.isArray(jobs) || jobs.length > 1000)
      throw new Error("Invalid Logpush job inventory");
    const matches = [];
    for (const job of jobs) {
      if (!job || !Number.isSafeInteger(job.id) || job.id < 1 || typeof job.dataset !== "string") {
        throw new Error("Invalid Logpush job entry");
      }
      let filter;
      try {
        filter = job.filter ? JSON.parse(job.filter) : null;
      } catch {
        throw new Error("Invalid Logpush filter");
      }
      const target =
        filter?.where?.key === "ScriptName" &&
        filter.where.operator === "eq" &&
        filter.where.value === workerScriptName;
      // An unfiltered or complex Workers job could already include this Worker. Do not duplicate it.
      if (
        job.dataset === "workers_trace_events" &&
        (!filter?.where ||
          Object.keys(filter).join() !== "where" ||
          Object.keys(filter.where).sort().join() !== "key,operator,value" ||
          filter.where.key !== "ScriptName" ||
          filter.where.operator !== "eq" ||
          typeof filter.where.value !== "string" ||
          filter.where.value.length === 0)
      ) {
        throw new Error("Ambiguous account-wide Workers Logpush job");
      }
      if (job.id === expectedJobId || job.name === `${workerScriptName}-usage-ledger` || target)
        matches.push(job);
    }
    if (matches.length > 1) throw new Error("Duplicate production Logpush jobs");
    return { job: matches[0], jobCount: jobs.length };
  };
  let { job, jobCount } = await matchingJobs();
  let state = "existing";
  if (!job) {
    if (!repairMissing) return { state: "missing", expectedJobId, jobCount };
    // Recheck immediately before creating. The workflow also shares production's concurrency lock.
    ({ job } = await matchingJobs());
    if (!job) {
      await api.applyAction({ type: "create-logpush" });
      state = "created";
      ({ job } = await matchingJobs());
      if (!job) throw new Error("Created Logpush job was not found; inspect before retrying");
    }
  }
  const output = job.output_options;
  const expectedFilter = { where: { key: "ScriptName", operator: "eq", value: workerScriptName } };
  if (
    job.dataset !== "workers_trace_events" ||
    job.enabled !== true ||
    canonicalJson(JSON.parse(job.filter)) !== canonicalJson(expectedFilter) ||
    output?.output_type !== "ndjson" ||
    output.record_template !== undefined ||
    !Array.isArray(output.field_names) ||
    output.field_names.join() !== fields.join() ||
    output.sample_rate !== 1 ||
    (job.logpull_options != null && job.logpull_options !== "") ||
    !logpushDestinationMatches(job.destination_conf, {
      ...credentials,
      accountId: config.accountId,
      bucketName: usageLogBucketName,
      environment: "production",
    })
  ) {
    throw new Error("Existing Logpush configuration differs; no automatic overwrite is allowed");
  }
  await api.verifyLogpushStatus(job.id);
  return { state, expectedJobId, jobId: job.id, bindingUpdateRequired: job.id !== expectedJobId };
}

export async function runProductionLogpushRepair(
  argv,
  { env = process.env, fetchImpl = fetch, stdout = process.stdout } = {},
) {
  const args = parseCliArguments(argv);
  assertExactKeys(
    args,
    ["account-id", "expected-job-id", "repair-missing", "state", "worker-version"],
    "Logpush recovery arguments",
  );
  if (
    !/^[1-9][0-9]*$/.test(args["expected-job-id"]) ||
    !["true", "false"].includes(args["repair-missing"])
  )
    throw new Error("Invalid recovery inputs");
  const state = JSON.parse(await readFile(resolve(args.state), "utf8"));
  const version = JSON.parse(await readFile(resolve(args["worker-version"]), "utf8"));
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.activeVersionId) ||
    version.id !== state.activeVersionId ||
    !Array.isArray(version.resources?.bindings)
  )
    throw new Error("Worker does not match the inspected active version");
  const expected = {
    CLOUDFLARE_ACCOUNT_ID: args["account-id"],
    ENVIRONMENT: "production",
    WORKER_SCRIPT_NAME: workerScriptName,
    USAGE_LOG_BUCKET_NAME: usageLogBucketName,
    USAGE_LOG_PREFIX: "workers-trace-events/production/",
    LOGPUSH_JOB_ID: args["expected-job-id"],
  };
  for (const [name, value] of Object.entries(expected)) {
    const bindings = version.resources.bindings.filter((binding) => binding.name === name);
    if (bindings.length !== 1 || bindings[0].type !== "plain_text" || bindings[0].text !== value)
      throw new Error("Active Worker recovery binding mismatch");
  }
  const config = {
    accountId: args["account-id"],
    environment: "production",
    workerScriptName,
    usageLogBucketName,
  };
  const credentials = {
    accessKeyId: env.LOGPUSH_R2_ACCESS_KEY_ID,
    secretAccessKey: env.LOGPUSH_R2_SECRET_ACCESS_KEY,
  };
  const token = env.CLOUDFLARE_LOGPUSH_API_TOKEN;
  const api = createCloudflareProcessingResourceApi({
    config,
    fetcher: (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(15000) }),
    // This recovery calls only the Logpush methods, never D1/Workers/R2 management APIs.
    apiToken: token,
    d1ApiToken: token,
    logpushApiToken: token,
    logpushR2AccessKeyId: credentials.accessKeyId,
    logpushR2SecretAccessKey: credentials.secretAccessKey,
  });
  const result = await repairProductionLogpush({
    api,
    config,
    credentials,
    expectedJobId: Number(args["expected-job-id"]),
    repairMissing: args["repair-missing"] === "true",
  });
  stdout.write(canonicalJson(result));
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runProductionLogpushRepair(process.argv.slice(2));
  } catch (error) {
    // Provider bodies, destinations, and credentials must never reach logs.
    const safe =
      error instanceof Error &&
      /^Cloudflare Logpush API (failed with HTTP \d{3}( \(code \d+\))?|rejected the request( \(code \d+\))?)$/.test(
        error.message,
      );
    process.stderr.write(
      `${safe ? error.message : "Production Logpush recovery failed; no unsafe details were logged"}\n`,
    );
    process.exitCode = 1;
  }
}
