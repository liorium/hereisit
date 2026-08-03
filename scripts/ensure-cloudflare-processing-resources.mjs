import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCloudflareProcessingResourceApi } from "./cloudflare-processing-resource-api.mjs";
import {
  parseCliArguments,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const accountPattern = /^[0-9a-f]{32}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const queueIdPattern = /^[0-9a-f]{32}$/;
const expectedLogpushFields = [
  "CPUTimeMs",
  "Entrypoint",
  "EventTimestampMs",
  "EventType",
  "Outcome",
  "ScriptName",
  "ScriptVersion",
];

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function validateConfig(value) {
  const config = assertObject(value, "resource configuration");
  if (config.phase !== "provision") throw new TypeError("resource phase must be provision");
  if (config.environment !== "staging" && config.environment !== "production") {
    throw new TypeError("resource environment is invalid");
  }
  if (typeof config.accountId !== "string" || !accountPattern.test(config.accountId)) {
    throw new TypeError("resource account ID is invalid");
  }
  if (config.location !== "apac") throw new TypeError("processing D1 location must be apac");
  const suffix = config.environment;
  const expected = {
    workerScriptName: `hereisit-processing-${suffix}`,
    databaseName: `hereisit-processing-${suffix}`,
    bucketName: `hereisit-processing-${suffix}`,
    usageLogBucketName: `hereisit-processing-usage-${suffix}`,
    usageAnalyticsDatasetName: `hereisit_processing_usage_${suffix}`,
    queueName: `hereisit-image-jobs-${suffix}`,
    dlqName: `hereisit-image-jobs-dlq-${suffix}`,
  };
  for (const [key, name] of Object.entries(expected)) {
    if (config[key] !== name) throw new TypeError(`${key} does not match ${suffix}`);
  }
  return config;
}

function exactNamed(entries, name, label, nameField = "name") {
  const matches = assertArray(entries, label).filter(
    (entry) => assertObject(entry, `${label} entry`)[nameField] === name,
  );
  if (matches.length > 1) throw new TypeError(`duplicate ${label} named ${name}`);
  return matches[0] ?? null;
}

function assertAccount(resource, accountId, label) {
  if (resource.accountId !== accountId) throw new TypeError(`${label} account does not match`);
}

function validateD1(resource, config) {
  assertAccount(resource, config.accountId, "D1");
  if (typeof resource.id !== "string" || !uuidPattern.test(resource.id)) {
    throw new TypeError("D1 ID is invalid");
  }
  if (resource.location !== "apac") throw new TypeError("D1 location does not match");
}

function validateR2(resource, config, lifecycleDays) {
  assertAccount(resource, config.accountId, "R2");
  if (resource.lifecycleDays !== lifecycleDays) throw new TypeError("R2 lifecycle does not match");
  if (!Array.isArray(resource.cors) || resource.cors.length !== 0) {
    throw new TypeError("R2 CORS must be empty");
  }
  if (!Array.isArray(resource.customDomains) || resource.customDomains.length !== 0) {
    throw new TypeError("R2 custom domains must be empty");
  }
  if (resource.r2DevEnabled !== false) throw new TypeError("R2 r2.dev access must be disabled");
  if (resource.sippyEnabled !== false) throw new TypeError("R2 Sippy must be disabled");
}

function validateQueue(resource, config) {
  assertAccount(resource, config.accountId, "Queue");
  if (typeof resource.id !== "string" || !queueIdPattern.test(resource.id)) {
    throw new TypeError("Queue ID is invalid");
  }
  if (typeof resource.deliveryPaused !== "boolean") {
    throw new TypeError("processing Queue delivery state is invalid");
  }
  if (
    !Array.isArray(resource.consumerScriptNames) ||
    resource.consumerCount !== resource.consumerScriptNames.length ||
    resource.consumerCount > 1 ||
    resource.consumerScriptNames.some((name) => name !== config.workerScriptName)
  ) {
    throw new TypeError("processing Queues may only use the exact processing Worker consumer");
  }
}

function validateLogpush(resource, config) {
  assertAccount(resource, config.accountId, "Logpush");
  if (!Number.isSafeInteger(resource.id) || resource.id < 1) {
    throw new TypeError("Logpush job ID is invalid");
  }
  if (resource.enabled !== true || resource.dataset !== "workers_trace_events") {
    throw new TypeError("Logpush job dataset or state does not match");
  }
  if (resource.workerScriptName !== config.workerScriptName) {
    throw new TypeError("Logpush Worker filter does not match");
  }
  if (resource.outputValid !== true) {
    throw new TypeError("Logpush output format does not match");
  }
  if (
    !Array.isArray(resource.fields) ||
    resource.fields.length !== expectedLogpushFields.length ||
    resource.fields.some((field, index) => field !== expectedLogpushFields[index])
  ) {
    throw new TypeError("Logpush field allowlist does not match");
  }
  if (resource.samplingRate !== null) throw new TypeError("Logpush sampling is prohibited");
}

export function planProcessingResources({ config: configValue, inventory: inventoryValue }) {
  const config = validateConfig(configValue);
  const inventory = assertObject(inventoryValue, "resource inventory");
  const actions = [];

  const d1 = exactNamed(inventory.d1, config.databaseName, "D1");
  if (d1 === null) {
    actions.push({ type: "create-d1", name: config.databaseName, location: "apac" });
  } else validateD1(d1, config);

  for (const [name, lifecycleDays] of [
    [config.bucketName, 1],
    [config.usageLogBucketName, 3],
  ]) {
    const bucket = exactNamed(inventory.r2, name, "R2");
    if (bucket === null) actions.push({ type: "create-r2", name, lifecycleDays });
    else validateR2(bucket, config, lifecycleDays);
  }

  for (const name of [config.dlqName, config.queueName]) {
    const queue = exactNamed(inventory.queues, name, "Queue");
    if (queue === null) {
      actions.push({ type: "create-queue", name, deliveryPaused: true });
    } else {
      validateQueue(queue, config);
      if (!queue.deliveryPaused) actions.push({ type: "pause-queue", id: queue.id, name });
    }
  }

  const logpushMatches = assertArray(inventory.logpush, "Logpush").filter((entryValue) => {
    const entry = assertObject(entryValue, "Logpush entry");
    return (
      entry.dataset === "workers_trace_events" && entry.workerScriptName === config.workerScriptName
    );
  });
  if (logpushMatches.length > 1) throw new TypeError("duplicate processing Logpush jobs");
  if (logpushMatches.length === 0) {
    actions.push({
      type: "create-logpush",
      dataset: "workers_trace_events",
      workerScriptName: config.workerScriptName,
    });
  } else {
    const logpush = logpushMatches[0];
    validateLogpush(logpush, config);
    if (logpush.destinationValid !== true) {
      actions.push({ type: "update-logpush-destination", id: logpush.id });
    }
  }

  return {
    version: 1,
    phase: "provision",
    environment: config.environment,
    analyticsDataset: config.usageAnalyticsDatasetName,
    actions,
  };
}

export async function convergeProcessingResources({
  config,
  readInventory,
  verifyLogpushStatus,
  applyAction,
}) {
  if (
    typeof readInventory !== "function" ||
    typeof verifyLogpushStatus !== "function" ||
    typeof applyAction !== "function"
  ) {
    throw new TypeError("resource convergence dependencies are invalid");
  }
  const maximumActions = 16;
  for (let applied = 0; applied <= maximumActions; applied += 1) {
    const inventory = await readInventory();
    const plan = planProcessingResources({ config, inventory });
    if (plan.actions.length === 0) {
      const logpush = inventory.logpush.find(
        (entry) =>
          entry.dataset === "workers_trace_events" &&
          entry.workerScriptName === config.workerScriptName,
      );
      if (logpush === undefined) throw new Error("converged Logpush job is missing");
      await verifyLogpushStatus(logpush.id);
      return {
        version: 1,
        phase: "provision",
        environment: plan.environment,
        analyticsDataset: plan.analyticsDataset,
        inventory,
      };
    }
    if (applied === maximumActions) {
      throw new Error("resource provisioning did not converge within its action bound");
    }
    const action = plan.actions[0];
    await applyAction(action);
    const nextInventory = await readInventory();
    const next = planProcessingResources({ config, inventory: nextInventory });
    if (JSON.stringify(next.actions[0]) === JSON.stringify(action)) {
      throw new Error("resource provisioning action did not converge");
    }
  }
  throw new Error("resource provisioning did not converge");
}

export function buildProcessingProvisionManifest({ config, inventory, verifiedAt }) {
  const plan = planProcessingResources({ config, inventory });
  if (plan.actions.length !== 0) throw new Error("resource inventory is not converged");
  if (
    typeof verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(verifiedAt)) ||
    new Date(verifiedAt).toISOString() !== verifiedAt
  ) {
    throw new TypeError("resource verification time is invalid");
  }
  const d1 = exactNamed(inventory.d1, config.databaseName, "D1");
  const jobsBucket = exactNamed(inventory.r2, config.bucketName, "R2");
  const usageBucket = exactNamed(inventory.r2, config.usageLogBucketName, "R2");
  const primaryQueue = exactNamed(inventory.queues, config.queueName, "Queue");
  const deadLetterQueue = exactNamed(inventory.queues, config.dlqName, "Queue");
  const logpush = inventory.logpush.find(
    (entry) =>
      entry.dataset === "workers_trace_events" &&
      entry.workerScriptName === config.workerScriptName,
  );
  if (
    d1 === null ||
    jobsBucket === null ||
    usageBucket === null ||
    primaryQueue === null ||
    deadLetterQueue === null ||
    logpush === undefined
  ) {
    throw new Error("resource inventory is incomplete after convergence");
  }
  const unsigned = {
    schema: "hereisit-processing-resource-provision@1",
    version: 1,
    phase: "provision",
    environment: config.environment,
    accountId: config.accountId,
    verifiedAt,
    d1: { databaseId: d1.id, name: d1.name, requestedLocationHint: config.location },
    r2: {
      jobs: { name: jobsBucket.name, lifecycleDays: jobsBucket.lifecycleDays, private: true },
      usage: { name: usageBucket.name, lifecycleDays: usageBucket.lifecycleDays, private: true },
    },
    queues: {
      primary: { id: primaryQueue.id, name: primaryQueue.name, deliveryPaused: true },
      dlq: { id: deadLetterQueue.id, name: deadLetterQueue.name, deliveryPaused: true },
    },
    analytics: { datasetName: config.usageAnalyticsDatasetName, state: "binding-deferred" },
    logpush: {
      jobId: logpush.id,
      configSha256: sha256Canonical({
        dataset: logpush.dataset,
        workerScriptName: logpush.workerScriptName,
        fields: logpush.fields,
        samplingRate: logpush.samplingRate,
      }),
    },
  };
  return { ...unsigned, verificationSha256: sha256Canonical(unsigned) };
}

function requiredArgument(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`--${key} is required`);
  }
  return value;
}

export async function runProcessingResourceProvisioner(
  argv,
  environment = process.env,
  stdout = process.stdout,
) {
  const args = parseCliArguments(argv);
  const keys = new Set([
    "phase",
    "account-id",
    "environment",
    "location",
    "bucket-name",
    "usage-log-bucket-name",
    "usage-analytics-dataset-name",
    "worker-script-name",
    "database-name",
    "queue-name",
    "dlq-name",
    "output",
  ]);
  if (Object.keys(args).some((key) => !keys.has(key))) {
    throw new TypeError("unknown resource provisioner argument");
  }
  const config = validateConfig({
    phase: requiredArgument(args, "phase"),
    accountId: requiredArgument(args, "account-id"),
    environment: requiredArgument(args, "environment"),
    location: requiredArgument(args, "location"),
    bucketName: requiredArgument(args, "bucket-name"),
    usageLogBucketName: requiredArgument(args, "usage-log-bucket-name"),
    usageAnalyticsDatasetName: requiredArgument(args, "usage-analytics-dataset-name"),
    workerScriptName: requiredArgument(args, "worker-script-name"),
    databaseName: requiredArgument(args, "database-name"),
    queueName: requiredArgument(args, "queue-name"),
    dlqName: requiredArgument(args, "dlq-name"),
  });
  const api = createCloudflareProcessingResourceApi({
    config,
    apiToken: environment.CLOUDFLARE_API_TOKEN,
    d1ApiToken: environment.CLOUDFLARE_D1_API_TOKEN,
    logpushApiToken: environment.CLOUDFLARE_LOGPUSH_API_TOKEN,
    logpushStatusToken: environment.LOGPUSH_STATUS_TOKEN,
    logpushR2AccessKeyId: environment.LOGPUSH_R2_ACCESS_KEY_ID,
    logpushR2SecretAccessKey: environment.LOGPUSH_R2_SECRET_ACCESS_KEY,
  });
  const result = await convergeProcessingResources({
    config,
    readInventory: api.readInventory,
    verifyLogpushStatus: api.verifyLogpushStatus,
    applyAction: api.applyAction,
  });
  const manifest = buildProcessingProvisionManifest({
    config,
    inventory: result.inventory,
    verifiedAt: new Date().toISOString(),
  });
  await writeCanonicalJsonAtomic(resolve(requiredArgument(args, "output")), manifest, {
    refuseOverwrite: true,
  });
  stdout.write(`${manifest.d1.databaseId}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingResourceProvisioner(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "resource provisioning failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
