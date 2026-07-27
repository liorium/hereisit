const apiOrigin = "https://api.cloudflare.com";
const maximumResponseBytes = 1024 * 1024;
const credentialPattern = /^[!-~]{1,4096}$/;
const expectedFields = [
  "CPUTimeMs",
  "Entrypoint",
  "EventTimestampMs",
  "EventType",
  "Outcome",
  "ScriptName",
  "ScriptVersion",
];

function assertCredential(value, label) {
  if (typeof value !== "string" || !credentialPattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function asObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function asArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function serviceForPath(path) {
  if (path.includes("/d1/")) return "D1";
  if (path.includes("/r2/")) return "R2";
  if (path.includes("/queues")) return "Queues";
  if (path.includes("/logpush/")) return "Logpush";
  return "resource";
}

async function readEnvelope(response, service) {
  if (!response.ok)
    throw new Error(`Cloudflare ${service} API failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json")
    throw new TypeError("Cloudflare resource API was not JSON");
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumResponseBytes) {
    throw new RangeError("Cloudflare resource API response exceeded its bound");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Cloudflare resource API response was invalid JSON");
  }
  const envelope = asObject(parsed, "Cloudflare resource API envelope");
  if (
    envelope.success !== true ||
    !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0
  ) {
    const providerError = Array.isArray(envelope.errors)
      ? envelope.errors.find(
          (error) =>
            error !== null &&
            typeof error === "object" &&
            !Array.isArray(error) &&
            Number.isSafeInteger(error.code),
        )
      : undefined;
    const code = providerError === undefined ? "" : ` (code ${providerError.code})`;
    throw new Error(`Cloudflare ${service} API rejected the request${code}`);
  }
  return envelope.result;
}

function lifecycleDays(result) {
  const rules = asArray(
    asObject(result, "R2 lifecycle response").rules ?? [],
    "R2 lifecycle rules",
  );
  if (rules.length !== 1) return -1;
  const rule = asObject(rules[0], "R2 lifecycle rule");
  const conditions = asObject(rule.conditions, "R2 lifecycle conditions");
  const transition = asObject(rule.deleteObjectsTransition, "R2 delete transition");
  const condition = asObject(transition.condition, "R2 delete condition");
  if (
    rule.enabled !== true ||
    conditions.prefix !== "" ||
    condition.type !== "Age" ||
    !Number.isSafeInteger(condition.maxAge) ||
    condition.maxAge <= 0 ||
    condition.maxAge % 86_400 !== 0 ||
    rule.abortMultipartUploadsTransition !== undefined ||
    (rule.storageClassTransitions !== undefined &&
      asArray(rule.storageClassTransitions, "R2 storage transitions").length !== 0)
  ) {
    return -1;
  }
  return condition.maxAge / 86_400;
}

function resultArray(result, key, label) {
  if (Array.isArray(result)) return result;
  return asArray(asObject(result, label)[key], label);
}

function parseLogpushFilter(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const filter = asObject(JSON.parse(value), "Logpush filter");
    const where = asObject(filter.where, "Logpush where filter");
    if (
      Object.keys(filter).length !== 1 ||
      Object.keys(where).sort().join(",") !== "key,operator,value"
    ) {
      return null;
    }
    if (where.key !== "ScriptName" || where.operator !== "eq" || typeof where.value !== "string") {
      return null;
    }
    return where.value;
  } catch {
    return null;
  }
}

export function logpushDestinationMatches(
  value,
  { accountId, bucketName, environment, accessKeyId, secretAccessKey },
) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const destination = new URL(value);
    const keys = Array.from(destination.searchParams.keys()).sort();
    return (
      destination.protocol === "r2:" &&
      destination.hostname === bucketName &&
      decodeURIComponent(destination.pathname) === `/workers-trace-events/${environment}/{DATE}` &&
      keys.join(",") === "access-key-id,account-id,secret-access-key" &&
      destination.searchParams.get("account-id") === accountId &&
      destination.searchParams.get("access-key-id") === accessKeyId &&
      destination.searchParams.get("secret-access-key") === secretAccessKey
    );
  } catch {
    return false;
  }
}

export function createCloudflareProcessingResourceApi({
  config,
  fetcher = fetch,
  apiToken,
  d1ApiToken,
  logpushApiToken,
  logpushR2AccessKeyId,
  logpushR2SecretAccessKey,
}) {
  const accountId = config.accountId;
  const resourceToken = assertCredential(apiToken, "Cloudflare resource token");
  const d1Token = assertCredential(d1ApiToken, "Cloudflare D1 token");
  const logsToken = assertCredential(logpushApiToken, "Cloudflare Logs token");
  const accessKeyId = assertCredential(logpushR2AccessKeyId, "Logpush R2 access key ID");
  const secretAccessKey = assertCredential(
    logpushR2SecretAccessKey,
    "Logpush R2 secret access key",
  );
  const accountPath = `/client/v4/accounts/${accountId}`;

  const request = async (path, token, { method = "GET", body } = {}) =>
    readEnvelope(
      await fetcher(`${apiOrigin}${path}`, {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      serviceForPath(path),
    );

  const readR2Bucket = async (name) => {
    const path = `${accountPath}/r2/buckets/${encodeURIComponent(name)}`;
    const [lifecycle, cors, custom, managed, sippy] = await Promise.all([
      request(`${path}/lifecycle`, resourceToken),
      request(`${path}/cors`, resourceToken),
      request(`${path}/domains/custom`, resourceToken),
      request(`${path}/domains/managed`, resourceToken),
      request(`${path}/sippy`, resourceToken),
    ]);
    const corsRules = asArray(asObject(cors, "R2 CORS response").rules ?? [], "R2 CORS rules");
    const domains = resultArray(custom, "domains", "R2 custom domains");
    return {
      accountId,
      name,
      lifecycleDays: lifecycleDays(lifecycle),
      cors: corsRules,
      customDomains: domains,
      r2DevEnabled: asObject(managed, "R2 managed domain").enabled,
      sippyEnabled: asObject(sippy, "R2 Sippy response").enabled,
    };
  };

  const readInventory = async () => {
    const [d1Result, r2Result, queueResult, logpushResult] = await Promise.all([
      request(
        `${accountPath}/d1/database?name=${encodeURIComponent(config.databaseName)}&per_page=100`,
        d1Token,
      ),
      request(`${accountPath}/r2/buckets`, resourceToken),
      request(`${accountPath}/queues?page=1`, resourceToken),
      request(`${accountPath}/logpush/jobs`, logsToken),
    ]);
    const databases = asArray(d1Result, "D1 inventory")
      .filter((entry) => asObject(entry, "D1 entry").name === config.databaseName)
      .map((entryValue) => {
        const entry = asObject(entryValue, "D1 entry");
        return { id: entry.uuid, accountId, name: entry.name, location: config.location };
      });
    const listedBuckets = resultArray(r2Result, "buckets", "R2 inventory");
    const r2 = [];
    for (const name of [config.bucketName, config.usageLogBucketName]) {
      const matches = listedBuckets.filter((entry) => asObject(entry, "R2 bucket").name === name);
      if (matches.length > 1) throw new TypeError(`duplicate R2 bucket named ${name}`);
      if (matches.length === 1) {
        r2.push(await readR2Bucket(name));
      }
    }
    const queues = resultArray(queueResult, "queues", "Queue inventory").map((entryValue) => {
      const entry = asObject(entryValue, "Queue entry");
      const settings = asObject(entry.settings, "Queue settings");
      return {
        id: entry.queue_id,
        accountId,
        name: entry.queue_name,
        deliveryPaused: settings.delivery_paused,
        consumerCount: entry.consumers_total_count,
      };
    });
    const logpush = asArray(logpushResult, "Logpush inventory").map((entryValue) => {
      const entry = asObject(entryValue, "Logpush entry");
      const output = asObject(entry.output_options, "Logpush output options");
      const workerScriptName = parseLogpushFilter(entry.filter);
      const destinationValid = logpushDestinationMatches(entry.destination_conf, {
        accountId,
        bucketName: config.usageLogBucketName,
        environment: config.environment,
        accessKeyId,
        secretAccessKey,
      });
      return {
        id: entry.id,
        accountId,
        enabled:
          entry.enabled === true &&
          destinationValid &&
          output.output_type === "ndjson" &&
          output.record_template === undefined,
        dataset: entry.dataset,
        workerScriptName,
        fields: output.field_names,
        samplingRate: output.sample_rate === 1 ? null : output.sample_rate,
      };
    });
    return { d1: databases, r2, queues, logpush };
  };

  const applyAction = async (action) => {
    if (action.type === "create-d1") {
      await request(`${accountPath}/d1/database`, d1Token, {
        method: "POST",
        body: { name: action.name, primary_location_hint: action.location },
      });
      return;
    }
    if (action.type === "create-r2") {
      await request(`${accountPath}/r2/buckets`, resourceToken, {
        method: "POST",
        body: { name: action.name, location: config.location, storage_class: "Standard" },
      });
      await request(
        `${accountPath}/r2/buckets/${encodeURIComponent(action.name)}/lifecycle`,
        resourceToken,
        {
          method: "PUT",
          body: {
            rules: [
              {
                id: `hereisit-expire-${action.lifecycleDays}d`,
                conditions: { prefix: "" },
                enabled: true,
                deleteObjectsTransition: {
                  condition: { type: "Age", maxAge: action.lifecycleDays * 86_400 },
                },
              },
            ],
          },
        },
      );
      return;
    }
    if (action.type === "create-queue") {
      const created = asObject(
        await request(`${accountPath}/queues`, resourceToken, {
          method: "POST",
          body: { queue_name: action.name },
        }),
        "created Queue",
      );
      if (typeof created.queue_id !== "string" || !/^[0-9a-f]{32}$/.test(created.queue_id)) {
        throw new TypeError("created Queue ID is invalid");
      }
      await request(`${accountPath}/queues/${created.queue_id}`, resourceToken, {
        method: "PATCH",
        body: { settings: { delivery_paused: true } },
      });
      return;
    }
    if (action.type === "create-logpush") {
      const destination = new URL(
        `r2://${config.usageLogBucketName}/workers-trace-events/${config.environment}/{DATE}`,
      );
      destination.searchParams.set("account-id", accountId);
      destination.searchParams.set("access-key-id", accessKeyId);
      destination.searchParams.set("secret-access-key", secretAccessKey);
      const destinationConfiguration = destination.href.replace("%7BDATE%7D", "{DATE}");
      await request(`${accountPath}/logpush/jobs`, logsToken, {
        method: "POST",
        body: {
          name: `${config.workerScriptName}-usage-ledger`,
          destination_conf: destinationConfiguration,
          dataset: "workers_trace_events",
          enabled: true,
          filter: JSON.stringify({
            where: { key: "ScriptName", operator: "eq", value: config.workerScriptName },
          }),
          max_upload_interval_seconds: 300,
          output_options: {
            field_names: expectedFields,
            output_type: "ndjson",
            sample_rate: 1,
          },
        },
      });
      return;
    }
    throw new TypeError("unknown processing resource action");
  };

  return { readInventory, applyAction };
}
