import { z } from "zod";
import providerUsageContract from "../../../docs/deployment/provider-usage-schema.v1.json" with {
  type: "json",
};

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[!-~]{1,4096}$/;
const INT64_MAXIMUM = 9_223_372_036_854_775_807n;
const PROVIDER_NUMBER_KEYS = new Set(["cpuTimeSec", "allocatedMemory", "allocatedDisk", "txBytes"]);

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
interface JsonParseContext {
  readonly source?: string;
}
interface SourceNumber {
  readonly source: string;
}

const sourceNumberSchema = z.object({ source: z.string().min(1).max(128) }).strict();
const providerRowSchema = z
  .object({
    dimensions: z
      .object({
        datetimeHour: z.string().min(1).max(64),
        applicationId: z.string().regex(UUID_PATTERN),
        instanceId: z.string().regex(UUID_PATTERN),
        region: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
      })
      .strict(),
    sum: z
      .object({
        cpuTimeSec: sourceNumberSchema,
        allocatedMemory: sourceNumberSchema,
        allocatedDisk: sourceNumberSchema,
        txBytes: sourceNumberSchema,
      })
      .strict(),
  })
  .strict();
const envelopeSchema = z
  .object({
    data: z
      .object({
        viewer: z
          .object({
            accounts: z
              .array(
                z
                  .object({
                    containersUsageAdaptiveGroups: z
                      .array(providerRowSchema)
                      .max(providerUsageContract.limit),
                  })
                  .strict(),
              )
              .length(1),
          })
          .strict(),
      })
      .strict(),
    errors: z.null(),
  })
  .strict();

export interface ContainerUsageHourQueryInput {
  readonly accountId: string;
  readonly token: string;
  readonly applicationId: string;
  readonly instanceId: string;
  readonly hourKey: number;
  readonly expectedSchemaSha256: string;
}

export interface ContainerUsageHourResult {
  readonly cpuMicroseconds: string;
  readonly allocatedMemoryByteMilliseconds: string;
  readonly allocatedDiskByteMilliseconds: string;
  readonly transmittedBytes: string;
  readonly transmittedBytesByRegion: readonly {
    readonly region: string;
    readonly transmittedBytes: string;
  }[];
}

let contractHashPromise: Promise<string> | undefined;

export function providerUsageContractSha256(): Promise<string> {
  contractHashPromise ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(JSON.stringify(providerUsageContract)))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  return contractHashPromise;
}

async function readBoundedProviderText(response: Response): Promise<string> {
  if (!response.ok) throw new Error("Container provider usage request failed.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new TypeError("Container provider usage response must be JSON.");
  }
  if (response.body === null) throw new TypeError("Container provider usage response is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total) || total > providerUsageContract.maximumResponseBytes) {
        await reader.cancel("Container provider response exceeded its bound.");
        throw new RangeError("Container provider response exceeded its bound.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function parseProviderJson(text: string): unknown {
  const parseWithSource = JSON.parse as (
    input: string,
    reviver: (this: unknown, key: string, value: unknown, context: JsonParseContext) => unknown,
  ) => unknown;
  return parseWithSource(text, (_key, value, context) => {
    if (!PROVIDER_NUMBER_KEYS.has(_key)) return value;
    if (typeof value !== "number" || typeof context.source !== "string") {
      throw new TypeError("Container provider numeric source is unavailable.");
    }
    return { source: context.source } satisfies SourceNumber;
  });
}

function fixedInteger(source: string, scale: number, label: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?(?:0|[1-9][0-9]*)))?$/.exec(source);
  if (!match) throw new TypeError(`${label} is not a canonical non-negative decimal.`);
  const integer = match[1];
  const fraction = match[2] ?? "";
  const exponentSource = match[3] ?? "0";
  if (integer === undefined || exponentSource.length > 4) {
    throw new RangeError(`${label} exponent exceeds its bound.`);
  }
  const exponent = Number(exponentSource);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 128) {
    throw new RangeError(`${label} exponent exceeds its bound.`);
  }
  const coefficient = BigInt(`${integer}${fraction}`);
  const decimalShift = exponent - fraction.length + scale;
  let result: bigint;
  if (decimalShift >= 0) {
    result = coefficient * 10n ** BigInt(decimalShift);
  } else {
    const divisor = 10n ** BigInt(-decimalShift);
    if (coefficient % divisor !== 0n) {
      throw new RangeError(`${label} precision exceeds its target integer unit.`);
    }
    result = coefficient / divisor;
  }
  if (result > INT64_MAXIMUM) throw new RangeError(`${label} exceeds signed 64-bit storage.`);
  return result.toString();
}

function checkedInt64Sum(left: string, right: string, label: string): string {
  const sum = BigInt(left) + BigInt(right);
  if (sum > INT64_MAXIMUM) throw new RangeError(`${label} exceeds signed 64-bit storage.`);
  return sum.toString();
}

function parseHourTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function validateInput(input: ContainerUsageHourQueryInput): void {
  if (!ACCOUNT_ID_PATTERN.test(input.accountId))
    throw new TypeError("Cloudflare account ID is invalid.");
  if (!TOKEN_PATTERN.test(input.token)) throw new TypeError("Analytics read token is invalid.");
  if (!UUID_PATTERN.test(input.applicationId) || !UUID_PATTERN.test(input.instanceId)) {
    throw new TypeError("Container provider resource ID is invalid.");
  }
  if (!Number.isSafeInteger(input.hourKey) || input.hourKey < 0) {
    throw new RangeError("Container provider hour is invalid.");
  }
  if (!SHA256_PATTERN.test(input.expectedSchemaSha256)) {
    throw new TypeError("Provider usage schema hash is invalid.");
  }
}

export async function queryContainerUsageHour(
  fetcher: ProviderFetch,
  input: ContainerUsageHourQueryInput,
): Promise<ContainerUsageHourResult> {
  validateInput(input);
  if ((await providerUsageContractSha256()) !== input.expectedSchemaSha256) {
    throw new Error("Configured provider usage schema does not match the runtime contract.");
  }
  const hourStart = input.hourKey * 3_600_000;
  const hourEnd = (input.hourKey + 1) * 3_600_000;
  if (!Number.isSafeInteger(hourStart) || !Number.isSafeInteger(hourEnd)) {
    throw new RangeError("Container provider hour exceeded its timestamp bound.");
  }
  const variables = {
    accountTag: input.accountId,
    datetimeStart: new Date(hourStart).toISOString(),
    datetimeEnd: new Date(hourEnd).toISOString(),
    applicationId: input.applicationId,
    instanceId: input.instanceId,
  };
  const response = await fetcher(providerUsageContract.endpoint, {
    method: providerUsageContract.method,
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: providerUsageContract.query, variables }),
  });
  const parsedJson = parseProviderJson(await readBoundedProviderText(response));
  const errorEnvelope = z.object({ errors: z.unknown() }).passthrough().safeParse(parsedJson);
  if (!errorEnvelope.success || errorEnvelope.data.errors !== null) {
    throw new Error("Container provider GraphQL response contains errors.");
  }
  const envelope = envelopeSchema.parse(parsedJson);
  const rows = envelope.data.viewer.accounts[0]?.containersUsageAdaptiveGroups ?? [];
  if (rows.length === 0) {
    return {
      cpuMicroseconds: "0",
      allocatedMemoryByteMilliseconds: "0",
      allocatedDiskByteMilliseconds: "0",
      transmittedBytes: "0",
      transmittedBytesByRegion: [],
    };
  }
  if (rows.length >= providerUsageContract.limit) {
    throw new Error("Container provider pagination envelope is invalid.");
  }
  let cpuMicroseconds = "0";
  let allocatedMemoryByteMilliseconds = "0";
  let allocatedDiskByteMilliseconds = "0";
  let transmittedBytes = "0";
  let previousRegion: string | null = null;
  const transmittedBytesByRegion: { region: string; transmittedBytes: string }[] = [];
  for (const row of rows) {
    if (
      parseHourTimestamp(row.dimensions.datetimeHour) !== hourStart ||
      row.dimensions.applicationId !== input.applicationId ||
      row.dimensions.instanceId !== input.instanceId
    ) {
      throw new Error("Container provider resource envelope is invalid.");
    }
    if (previousRegion !== null && row.dimensions.region <= previousRegion) {
      throw new Error("Container provider region ordering is invalid.");
    }
    previousRegion = row.dimensions.region;
    const rowCpuMicroseconds = fixedInteger(
      row.sum.cpuTimeSec.source,
      providerUsageContract.integerScales.cpuTimeSecToMicroseconds,
      "Container CPU time",
    );
    const rowMemoryByteMilliseconds = fixedInteger(
      row.sum.allocatedMemory.source,
      providerUsageContract.integerScales.allocatedMemoryToByteMilliseconds,
      "Container allocated memory",
    );
    const rowDiskByteMilliseconds = fixedInteger(
      row.sum.allocatedDisk.source,
      providerUsageContract.integerScales.allocatedDiskToByteMilliseconds,
      "Container allocated disk",
    );
    const rowTransmittedBytes = fixedInteger(
      row.sum.txBytes.source,
      providerUsageContract.integerScales.txBytes,
      "Container transmitted bytes",
    );
    cpuMicroseconds = checkedInt64Sum(cpuMicroseconds, rowCpuMicroseconds, "Container CPU time");
    allocatedMemoryByteMilliseconds = checkedInt64Sum(
      allocatedMemoryByteMilliseconds,
      rowMemoryByteMilliseconds,
      "Container allocated memory",
    );
    allocatedDiskByteMilliseconds = checkedInt64Sum(
      allocatedDiskByteMilliseconds,
      rowDiskByteMilliseconds,
      "Container allocated disk",
    );
    transmittedBytes = checkedInt64Sum(
      transmittedBytes,
      rowTransmittedBytes,
      "Container transmitted bytes",
    );
    transmittedBytesByRegion.push({
      region: row.dimensions.region,
      transmittedBytes: rowTransmittedBytes,
    });
  }
  return {
    cpuMicroseconds,
    allocatedMemoryByteMilliseconds,
    allocatedDiskByteMilliseconds,
    transmittedBytes,
    transmittedBytesByRegion,
  };
}
