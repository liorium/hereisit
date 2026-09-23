import { z } from "zod";
import {
  type RecordParsedUsageLogInput,
  type RecordParsedUsageLogResult,
  recordParsedUsageLog,
} from "./usage-log-ledger";
import {
  type ParsedTraceEvents,
  parseGzipTraceEvents,
  type TraceEventParserOptions,
} from "./usage-log-parser";

const MAXIMUM_PAGE_OBJECTS = 128;
const MAXIMUM_COMPRESSED_OBJECT_BYTES = 64 * 1024 * 1024;

const inputSchema = z
  .object({
    observedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    prefix: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\0")),
    cursor: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0"))
      .optional(),
    maximumObjects: z.number().int().min(1).max(MAXIMUM_PAGE_OBJECTS).optional(),
    minimumHourKey: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export interface UsageLogBucket {
  readonly list: (options: R2ListOptions) => Promise<R2Objects>;
  readonly get: (
    key: string,
    options: { readonly onlyIf: { readonly etagMatches: string } },
  ) => Promise<R2ObjectBody | R2Object | null>;
}

export type UsageLogCircuitReason = "USAGE_LOG_IMPORT_INVALID" | "USAGE_LOG_OBJECT_CHANGED";

export interface UsageLogImporterDependencies {
  readonly bucket: UsageLogBucket;
  readonly database: D1Database;
  readonly parserOptions: TraceEventParserOptions;
  readonly record?: (
    database: D1Database,
    input: RecordParsedUsageLogInput,
  ) => Promise<RecordParsedUsageLogResult>;
  readonly openCircuit?: (
    database: D1Database,
    observedAt: number,
    reason: UsageLogCircuitReason,
  ) => Promise<void>;
}

export interface ImportUsageLogPageInput {
  readonly observedAt: number;
  readonly prefix: string;
  readonly cursor?: string;
  readonly maximumObjects?: number;
  readonly minimumHourKey?: number;
}

export type ImportUsageLogPageResult =
  | {
      readonly kind: "complete";
      readonly importedObjects: number;
      readonly replayedObjects: number;
      readonly metadataRowsRead: number;
    }
  | {
      readonly kind: "partial";
      readonly importedObjects: number;
      readonly replayedObjects: number;
      readonly metadataRowsRead: number;
      readonly cursor: string;
    }
  | {
      readonly kind: "failed-closed";
      readonly importedObjects: number;
      readonly replayedObjects: number;
      readonly metadataRowsRead: number;
    };

function isSafeMetadata(object: R2Object, prefix: string): boolean {
  return (
    object.key.startsWith(prefix) &&
    object.key.length >= 1 &&
    object.key.length <= 1_024 &&
    !object.key.includes("\0") &&
    object.etag.length >= 1 &&
    object.etag.length <= 256 &&
    !object.etag.includes("\0") &&
    Number.isSafeInteger(object.size) &&
    object.size >= 0 &&
    object.size <= MAXIMUM_COMPRESSED_OBJECT_BYTES
  );
}

function isOwnershipChallenge(object: R2Object, prefix: string): boolean {
  return (
    object.key.startsWith(prefix) && /^\d{8}\/test\.txt\.gz$/.test(object.key.slice(prefix.length))
  );
}

function hasBody(object: R2ObjectBody | R2Object | null): object is R2ObjectBody {
  return object !== null && "body" in object && object.body instanceof ReadableStream;
}

export async function openUsageLogCircuit(
  database: D1Database,
  observedAt: number,
  reason: UsageLogCircuitReason,
): Promise<void> {
  await database
    .withSession("first-primary")
    .prepare(
      `UPDATE rollout_control
       SET circuit_open = 1,
           reason = CASE WHEN circuit_open = 1 THEN reason ELSE ? END,
           opened_at = COALESCE(opened_at, ?)
       WHERE id = 1`,
    )
    .bind(reason, observedAt)
    .run();
}

export async function importUsageLogPage(
  dependencies: UsageLogImporterDependencies,
  rawInput: ImportUsageLogPageInput,
): Promise<ImportUsageLogPageResult> {
  const input = inputSchema.parse(rawInput);
  const limit = input.maximumObjects ?? MAXIMUM_PAGE_OBJECTS;
  const listOptions: R2ListOptions = { prefix: input.prefix, limit };
  if (input.cursor !== undefined) listOptions.cursor = input.cursor;
  const listed = await dependencies.bucket.list(listOptions);
  const openCircuit = dependencies.openCircuit ?? openUsageLogCircuit;
  const record = dependencies.record ?? recordParsedUsageLog;
  const objects = listed.objects.filter((object) => !isOwnershipChallenge(object, input.prefix));
  let importedObjects = 0;
  let replayedObjects = 0;
  let metadataRowsRead = 0;

  const failClosed = async (reason: UsageLogCircuitReason): Promise<ImportUsageLogPageResult> => {
    await openCircuit(dependencies.database, input.observedAt, reason);
    return { kind: "failed-closed", importedObjects, replayedObjects, metadataRowsRead };
  };

  if (
    listed.objects.length > limit ||
    objects.some((object) => !isSafeMetadata(object, input.prefix))
  ) {
    return failClosed("USAGE_LOG_IMPORT_INVALID");
  }

  const historical = new Set<string>();
  if (input.minimumHourKey !== undefined && objects.length > 0) {
    const known = await dependencies.database
      .withSession("first-primary")
      .prepare(
        `SELECT stored.object_key
       FROM json_each(?) AS listed
       JOIN usage_log_objects AS stored ON stored.object_key = json_extract(listed.value, '$.key')
       WHERE stored.parsed_sha256 IS NOT NULL AND stored.last_hour_key < ?
         AND stored.etag = json_extract(listed.value, '$.etag')
         AND stored.byte_size = json_extract(listed.value, '$.size')`,
      )
      .bind(
        JSON.stringify(objects.map(({ key, etag, size }) => ({ key, etag, size }))),
        input.minimumHourKey,
      )
      .all();
    metadataRowsRead = z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(known.meta.rows_read);
    const rows = z
      .array(z.object({ object_key: z.string().min(1).max(1_024) }).strict())
      .max(limit)
      .parse(known.results);
    for (const row of rows) historical.add(row.object_key);
  }

  for (const metadata of objects) {
    // Only older, already parsed immutable objects may skip body replay; target/future logs never do.
    if (historical.has(metadata.key)) continue;
    const object = await dependencies.bucket.get(metadata.key, {
      onlyIf: { etagMatches: metadata.etag },
    });
    if (
      !hasBody(object) ||
      object.key !== metadata.key ||
      object.etag !== metadata.etag ||
      object.size !== metadata.size
    ) {
      return failClosed("USAGE_LOG_OBJECT_CHANGED");
    }

    let parsed: ParsedTraceEvents;
    try {
      parsed = await parseGzipTraceEvents(object.body, dependencies.parserOptions);
    } catch {
      return failClosed("USAGE_LOG_IMPORT_INVALID");
    }
    const outcome = await record(dependencies.database, {
      objectKey: metadata.key,
      etag: metadata.etag,
      byteSize: metadata.size,
      observedAt: input.observedAt,
      parsed,
    });
    if (outcome.kind === "conflict") {
      return { kind: "failed-closed", importedObjects, replayedObjects, metadataRowsRead };
    }
    if (outcome.kind === "recorded") importedObjects += 1;
    else replayedObjects += 1;
  }

  if (!listed.truncated)
    return { kind: "complete", importedObjects, replayedObjects, metadataRowsRead };
  if (listed.cursor.length < 1 || listed.cursor === input.cursor) {
    return failClosed("USAGE_LOG_IMPORT_INVALID");
  }
  return {
    kind: "partial",
    importedObjects,
    replayedObjects,
    metadataRowsRead,
    cursor: listed.cursor,
  };
}
