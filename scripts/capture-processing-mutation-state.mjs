import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCloudflareProcessingResourceApi } from "./cloudflare-processing-resource-api.mjs";
import {
  assertExactKeys,
  assertObject,
  canonicalJson,
  parseCliArguments,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const accountPattern = /^[0-9a-f]{32}$/;
const environmentNames = new Set(["staging", "production"]);

function exactNamed(entries, name, label, field = "name") {
  if (!Array.isArray(entries)) throw new TypeError(`${label} inventory is invalid`);
  const matches = entries.filter((value) => assertObject(value, `${label} entry`)[field] === name);
  if (matches.length > 1) throw new TypeError(`${label} inventory is ambiguous`);
  return matches[0] ?? null;
}

function validateConfig(value) {
  const config = assertObject(value, "mutation state config");
  assertExactKeys(
    config,
    [
      "environment",
      "accountId",
      "databaseName",
      "bucketName",
      "usageLogBucketName",
      "workerScriptName",
      "queueName",
      "dlqName",
      "pdfQueueName",
      "pdfDlqName",
    ],
    "mutation state config",
  );
  if (!environmentNames.has(config.environment) || !accountPattern.test(config.accountId ?? ""))
    throw new TypeError("mutation state identity is invalid");
  const suffix = config.environment;
  const expected = {
    databaseName: `hereisit-processing-${suffix}`,
    bucketName: `hereisit-processing-${suffix}`,
    usageLogBucketName: `hereisit-processing-usage-${suffix}`,
    workerScriptName: `hereisit-processing-${suffix}`,
    queueName: `hereisit-image-jobs-${suffix}`,
    dlqName: `hereisit-image-jobs-dlq-${suffix}`,
    pdfQueueName: `hereisit-pdf-jobs-${suffix}`,
    pdfDlqName: `hereisit-pdf-jobs-dlq-${suffix}`,
  };
  for (const [key, name] of Object.entries(expected)) {
    if (config[key] !== name) throw new TypeError(`${key} does not match the environment`);
  }
  return config;
}

export function captureProcessingMutationState({ config: configValue, inventory, capturedAt }) {
  const config = validateConfig(configValue);
  const source = assertObject(inventory, "pre-mutation inventory");
  const timestamp = new Date(capturedAt);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== capturedAt)
    throw new TypeError("pre-mutation capture time is invalid");
  const d1 = exactNamed(source.d1, config.databaseName, "D1");
  const jobs = exactNamed(source.r2, config.bucketName, "jobs R2");
  const usage = exactNamed(source.r2, config.usageLogBucketName, "usage R2");
  const imagePrimary = exactNamed(source.queues, config.queueName, "image primary Queue");
  const imageDlq = exactNamed(source.queues, config.dlqName, "image DLQ");
  const pdfPrimary = exactNamed(source.queues, config.pdfQueueName, "PDF primary Queue");
  const pdfDlq = exactNamed(source.queues, config.pdfDlqName, "PDF DLQ");
  const logpush = exactNamed(
    source.logpush,
    config.workerScriptName,
    "Logpush",
    "workerScriptName",
  );
  const worker = exactNamed(source.workers, config.workerScriptName, "Worker");
  const imageContainerName = `${config.workerScriptName}-imageenginecontainer`;
  const pdfContainerName = `${config.workerScriptName}-pdfenginecontainer`;
  const imageContainer = exactNamed(
    source.containers,
    imageContainerName,
    "image Container application",
  );
  const pdfContainer = exactNamed(source.containers, pdfContainerName, "PDF Container application");
  const queue = (value) =>
    value === null
      ? null
      : {
          id: value.id,
          name: value.name,
          state: value.deliveryPaused === true ? "paused" : "resumed",
        };
  const resources = {
    d1: d1 === null ? null : { id: d1.id, name: d1.name },
    r2: {
      jobs: jobs === null ? null : { name: jobs.name },
      usage: usage === null ? null : { name: usage.name },
    },
    queues: {
      image: { primary: queue(imagePrimary), dlq: queue(imageDlq) },
      pdf: { primary: queue(pdfPrimary), dlq: queue(pdfDlq) },
    },
    logpush:
      logpush === null ? null : { id: logpush.id, workerScriptName: logpush.workerScriptName },
    worker: worker === null ? null : { name: worker.name },
    containers: {
      image: imageContainer === null ? null : { id: imageContainer.id, name: imageContainer.name },
      pdf: pdfContainer === null ? null : { id: pdfContainer.id, name: pdfContainer.name },
    },
  };
  const absentResources = [
    ["d1", d1],
    ["r2.jobs", jobs],
    ["r2.usage", usage],
    ["queue.image.primary", imagePrimary],
    ["queue.image.dlq", imageDlq],
    ["queue.pdf.primary", pdfPrimary],
    ["queue.pdf.dlq", pdfDlq],
    ["logpush", logpush],
    ["worker", worker],
    ["container.image", imageContainer],
    ["container.pdf", pdfContainer],
  ]
    .filter(([, value]) => value === null)
    .map(([key]) => key)
    .sort();
  return {
    schema: "hereisit-processing-pre-mutation-state@1",
    version: 1,
    capturedAt,
    config,
    absentResources,
    resources,
  };
}

function resourceForInventory(inventory, state, key) {
  const config = state.config;
  const lookups = {
    d1: [inventory.d1, config.databaseName, "name"],
    "r2.jobs": [inventory.r2, config.bucketName, "name"],
    "r2.usage": [inventory.r2, config.usageLogBucketName, "name"],
    "queue.image.primary": [inventory.queues, config.queueName, "name"],
    "queue.image.dlq": [inventory.queues, config.dlqName, "name"],
    "queue.pdf.primary": [inventory.queues, config.pdfQueueName, "name"],
    "queue.pdf.dlq": [inventory.queues, config.pdfDlqName, "name"],
    logpush: [inventory.logpush, config.workerScriptName, "workerScriptName"],
    worker: [inventory.workers, config.workerScriptName, "name"],
    "container.image": [
      inventory.containers,
      `${config.workerScriptName}-imageenginecontainer`,
      "name",
    ],
    "container.pdf": [
      inventory.containers,
      `${config.workerScriptName}-pdfenginecontainer`,
      "name",
    ],
  };
  const [entries, name, field] = lookups[key];
  return exactNamed(entries, name, `${key} restore`, field);
}

export async function restoreAbsentProcessingResources({
  state: stateValue,
  inventory,
  applyAction,
}) {
  const state = assertObject(stateValue, "pre-mutation state");
  if (
    state.schema !== "hereisit-processing-pre-mutation-state@1" ||
    state.version !== 1 ||
    !Array.isArray(state.absentResources)
  )
    throw new TypeError("pre-mutation state identity is invalid");
  validateConfig(state.config);
  const current = assertObject(inventory, "current resource inventory");
  const deleteOrder = [
    "worker",
    "container.image",
    "container.pdf",
    "logpush",
    "queue.image.primary",
    "queue.image.dlq",
    "queue.pdf.primary",
    "queue.pdf.dlq",
    "r2.jobs",
    "r2.usage",
    "d1",
  ];
  for (const key of deleteOrder) {
    if (!state.absentResources.includes(key)) continue;
    const resource = resourceForInventory(current, state, key);
    if (resource === null) continue;
    const type =
      key === "d1"
        ? "delete-d1"
        : key.startsWith("r2.")
          ? "delete-r2"
          : key.startsWith("queue.")
            ? "delete-queue"
            : key.startsWith("container.")
              ? "delete-container"
              : key === "worker"
                ? "delete-worker"
                : "delete-logpush";
    await applyAction({ type, id: resource.id, name: resource.name });
  }
}

export function verifyAbsentProcessingResources({ state: stateValue, inventory }) {
  const state = assertObject(stateValue, "pre-mutation state");
  validateConfig(state.config);
  for (const key of state.absentResources) {
    if (resourceForInventory(inventory, state, key) !== null)
      throw new Error(`${key} was absent before mutation but still exists`);
  }
  return true;
}

function configFromArgs(args) {
  return {
    environment: args.environment,
    accountId: args["account-id"],
    databaseName: args["database-name"],
    bucketName: args["bucket-name"],
    usageLogBucketName: args["usage-log-bucket-name"],
    workerScriptName: args["worker-script-name"],
    queueName: args["queue-name"],
    dlqName: args["dlq-name"],
    pdfQueueName: args["pdf-queue-name"],
    pdfDlqName: args["pdf-dlq-name"],
  };
}

function apiConfig(config) {
  return {
    ...config,
    phase: "provision",
    location: "apac",
    usageAnalyticsDatasetName: `hereisit_processing_usage_${config.environment}`,
  };
}

function apiFor(config, environment) {
  return createCloudflareProcessingResourceApi({
    config: apiConfig(config),
    apiToken: environment.CLOUDFLARE_API_TOKEN,
    d1ApiToken: environment.CLOUDFLARE_D1_API_TOKEN,
    logpushApiToken: environment.CLOUDFLARE_LOGPUSH_API_TOKEN,
    logpushStatusToken: environment.LOGPUSH_STATUS_TOKEN,
    logpushR2AccessKeyId: environment.LOGPUSH_R2_ACCESS_KEY_ID,
    logpushR2SecretAccessKey: environment.LOGPUSH_R2_SECRET_ACCESS_KEY,
  });
}

export async function runProcessingMutationStateCli(argv, environment = process.env) {
  const args = parseCliArguments(argv);
  const mode = args.mode;
  const config = configFromArgs(args);
  const api = apiFor(validateConfig(config), environment);
  if (mode === "capture") {
    const state = captureProcessingMutationState({
      config,
      inventory: await api.readInventory(),
      capturedAt: new Date().toISOString(),
    });
    await writeCanonicalJsonAtomic(resolve(args.output), state, {
      refuseOverwrite: true,
      mode: 0o600,
    });
    return state;
  }
  if (mode === "restore-absent") {
    const state = JSON.parse(await readFile(resolve(args.input), "utf8"));
    await restoreAbsentProcessingResources({
      state,
      inventory: await api.readInventory(),
      applyAction: api.applyAction,
    });
    verifyAbsentProcessingResources({ state, inventory: await api.readInventory() });
    return { restored: true };
  }
  throw new TypeError("mutation state mode is invalid");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await runProcessingMutationStateCli(process.argv.slice(2));
    process.stdout.write(canonicalJson(result));
  } catch {
    process.stderr.write("processing mutation state operation failed\n");
    process.exitCode = 1;
  }
}
