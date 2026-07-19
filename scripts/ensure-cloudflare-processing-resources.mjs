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

function validateQueue(resource, config, deadLetterQueueName) {
  assertAccount(resource, config.accountId, "Queue");
  if (typeof resource.id !== "string" || !queueIdPattern.test(resource.id)) {
    throw new TypeError("Queue ID is invalid");
  }
  if (resource.deliveryPaused !== true) {
    throw new TypeError("new processing Queues must remain paused during provisioning");
  }
  if (resource.deadLetterQueueName !== deadLetterQueueName) {
    throw new TypeError("Queue dead-letter role does not match");
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

  for (const [name, deadLetterQueueName] of [
    [config.dlqName, null],
    [config.queueName, config.dlqName],
  ]) {
    const queue = exactNamed(inventory.queues, name, "Queue");
    if (queue === null) {
      actions.push({ type: "create-queue", name, deadLetterQueueName, deliveryPaused: true });
    } else validateQueue(queue, config, deadLetterQueueName);
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
  } else validateLogpush(logpushMatches[0], config);

  return {
    version: 1,
    phase: "provision",
    environment: config.environment,
    analyticsDataset: config.usageAnalyticsDatasetName,
    actions,
  };
}
