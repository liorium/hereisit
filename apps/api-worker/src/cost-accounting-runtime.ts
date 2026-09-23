import { z } from "zod";
import { queryContainerUsageHour } from "./container-provider-usage";
import { reconcileContainerProviderHour } from "./container-provider-usage-reconciler";
import type { CostAccountingScheduleDependencies } from "./cost-accounting-scheduler";
import type { LiveCostModelV1 } from "./env";
import { sealNextHourlyCost } from "./hourly-cost-sealer";
import { prepareOperationalCounter } from "./operational-counters";
import { checkLogpushHour } from "./provider-usage";
import { reconcileWorkerProviderHour } from "./provider-usage-reconciler";
import { importUsageLogPage } from "./usage-log-importer";
import { observeUsageLogHour } from "./usage-log-observer";
import { createCloudflareSha256Digest } from "./usage-log-parser";

export const PROCESSING_USAGE_LOG_ENTRYPOINTS: ReadonlySet<string> = new Set([
  "",
  "ImageEngineContainer",
  "PdfEngineContainer",
]);

const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const targetRowSchema = z
  .object({
    cost_accounting_started_at: nonnegativeInteger,
    last_sealed_hour_key: nonnegativeInteger.nullable(),
  })
  .strict();
const cursorRowSchema = z.object({ cursor: z.string().min(1).max(4_096).nullable() }).strict();
const attestationRowSchema = z
  .object({
    worker_module_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    generated_config_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const accountIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const canonicalPositiveIntegerSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const workerScriptNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const usageLogPrefixSchema = z
  .string()
  .regex(/^workers-trace-events\/(?:local|staging|production)\/$/);
const analyticsDatasetNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

export interface CostAccountingRuntimeConfig {
  readonly accountId: string;
  readonly logpushJobId: number;
  readonly containerApplicationId: string;
  readonly workerScriptName: string;
  readonly usageLogPrefix: string;
  readonly analyticsDatasetName: string;
  readonly environment: "local" | "staging" | "production";
  readonly liveCostModel: LiveCostModelV1;
  readonly liveCostModelSha256: string;
  readonly providerUsageSchemaSha256: string;
  readonly releaseReportSha256: string;
}

export interface CostAccountingRuntimeEnvironment {
  readonly DB: D1Database;
  readonly USAGE_LOGS: R2Bucket;
  readonly ANALYTICS_READ_TOKEN: string;
  readonly LOGPUSH_STATUS_TOKEN: string;
  readonly WORKER_VERSION: WorkerVersionMetadata;
}

export interface CostAccountingRuntimeSettings {
  readonly COST_ACCOUNTING_MODE: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly LOGPUSH_JOB_ID: string;
  readonly CONTAINER_APPLICATION_ID: string;
  readonly WORKER_SCRIPT_NAME: string;
  readonly USAGE_LOG_PREFIX: string;
  readonly USAGE_ANALYTICS_DATASET_NAME: string;
}

export function parseCostAccountingMode(
  settings: Pick<CostAccountingRuntimeSettings, "COST_ACCOUNTING_MODE">,
): "bootstrap" | "active" {
  return z.enum(["bootstrap", "active"]).parse(settings.COST_ACCOUNTING_MODE);
}

export function parseCostAccountingRuntimeConfig(
  settings: CostAccountingRuntimeSettings,
  operational: Pick<
    CostAccountingRuntimeConfig,
    | "environment"
    | "liveCostModel"
    | "liveCostModelSha256"
    | "providerUsageSchemaSha256"
    | "releaseReportSha256"
  >,
): CostAccountingRuntimeConfig {
  if (parseCostAccountingMode(settings) !== "active") {
    throw new TypeError("Cost accounting runtime cannot start in bootstrap mode.");
  }
  const prefix = usageLogPrefixSchema.parse(settings.USAGE_LOG_PREFIX);
  if (prefix !== `workers-trace-events/${operational.environment}/`) {
    throw new TypeError("USAGE_LOG_PREFIX must match ENVIRONMENT.");
  }
  const workerScriptName = workerScriptNameSchema.parse(settings.WORKER_SCRIPT_NAME);
  if (
    operational.environment !== "local" &&
    workerScriptName !== `hereisit-processing-${operational.environment}`
  ) {
    throw new TypeError("WORKER_SCRIPT_NAME must match ENVIRONMENT.");
  }
  return {
    accountId: accountIdSchema.parse(settings.CLOUDFLARE_ACCOUNT_ID),
    logpushJobId: canonicalPositiveIntegerSchema.parse(settings.LOGPUSH_JOB_ID),
    containerApplicationId: z.string().uuid().parse(settings.CONTAINER_APPLICATION_ID),
    workerScriptName,
    usageLogPrefix: prefix,
    analyticsDatasetName: analyticsDatasetNameSchema.parse(settings.USAGE_ANALYTICS_DATASET_NAME),
    ...operational,
  };
}

async function activeAttestation(
  database: D1Database,
  versionId: string,
): Promise<z.infer<typeof attestationRowSchema> | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT worker_module_sha256, generated_config_sha256
       FROM worker_version_attestations
       WHERE version_id = ? AND kind IN ('bootstrap', 'secret-intermediate', 'active')`,
    )
    .bind(versionId)
    .first();
  const parsed = attestationRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function createCostAccountingRuntime(
  env: CostAccountingRuntimeEnvironment,
  config: CostAccountingRuntimeConfig,
): CostAccountingScheduleDependencies {
  const targetHour = async () => {
    const row = targetRowSchema.parse(
      await env.DB.withSession("first-primary")
        .prepare(
          "SELECT cost_accounting_started_at, last_sealed_hour_key FROM rollout_control WHERE id = 1",
        )
        .first(),
    );
    const firstHour = Math.ceil(row.cost_accounting_started_at / 3_600_000);
    return row.last_sealed_hour_key === null ? firstHour : row.last_sealed_hour_key + 1;
  };
  return {
    targetHour,
    importUsageLogs: async (now) => {
      const session = env.DB.withSession("first-primary");
      const cursor = cursorRowSchema.safeParse(
        await session
          .prepare("SELECT cursor FROM maintenance_cursors WHERE task = 'usage-log-import'")
          .first(),
      );
      let nextCursor = cursor.success ? cursor.data.cursor : null;
      let bodyReads = 0;
      let listCalls = 0;
      let metadataRowsRead = 0;
      const minimumHourKey = await targetHour();
      // ponytail: scan at most 64 pages and replay 128 bodies per tick; queue imports if this ceiling is reached routinely.
      for (; listCalls < 64 && bodyReads < 128; ) {
        listCalls += 1;
        const result = await importUsageLogPage(
          {
            bucket: env.USAGE_LOGS,
            database: env.DB,
            parserOptions: {
              scriptName: config.workerScriptName,
              allowedEntrypoints: PROCESSING_USAGE_LOG_ENTRYPOINTS,
              createDigest: createCloudflareSha256Digest,
            },
          },
          {
            observedAt: now,
            prefix: config.usageLogPrefix,
            ...(nextCursor !== null ? { cursor: nextCursor } : {}),
            maximumObjects: 128 - bodyReads,
            minimumHourKey,
          },
        );
        bodyReads += result.importedObjects + result.replayedObjects;
        metadataRowsRead += result.metadataRowsRead;
        if (result.kind === "failed-closed") return "conflict";
        nextCursor = result.kind === "partial" ? result.cursor : null;
        if (result.kind === "complete") break;
      }
      await session.batch([
        session
          .prepare(
            `INSERT INTO maintenance_cursors (task, cursor, updated_at)
             VALUES ('usage-log-import', ?, ?)
             ON CONFLICT(task) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
          )
          .bind(nextCursor, now),
        prepareOperationalCounter(session, {
          recordedAt: now,
          d1RowsRead: 5 + metadataRowsRead,
          d1RowsWritten: 2,
          r2ClassAOperations: listCalls,
          r2ClassBOperations: bodyReads,
        }),
      ]);
      return nextCursor !== null ? "partial" : "complete";
    },
    observeUsageHour: async (hourKey, now) => {
      const result = await observeUsageLogHour(env.DB, {
        hourKey,
        observedAt: now,
        createDigest: createCloudflareSha256Digest,
      });
      return result.kind === "conflict" ? "conflict" : result.kind;
    },
    reconcileWorker: async (hourKey, now) => {
      try {
        const attestation = await activeAttestation(env.DB, env.WORKER_VERSION.id);
        if (attestation === null) return "incomplete";
        const logpush = await checkLogpushHour(fetch, {
          accountId: config.accountId,
          token: env.LOGPUSH_STATUS_TOKEN,
          jobId: config.logpushJobId,
          hourKey,
        });
        const result = await reconcileWorkerProviderHour(env.DB, {
          hourKey,
          observedAt: now,
          logpush,
          liveCostModelSha256: config.liveCostModelSha256,
          providerUsageSchemaSha256: config.providerUsageSchemaSha256,
          releaseReportSha256: config.releaseReportSha256,
          expectedWorkerModuleSha256: attestation.worker_module_sha256,
          expectedGeneratedConfigSha256: attestation.generated_config_sha256,
        });
        return result.kind === "verified" ? "verified" : result.kind;
      } catch {
        return "incomplete";
      }
    },
    reconcileContainer: async (hourKey, now) => {
      try {
        const usage = await queryContainerUsageHour(fetch, {
          accountId: config.accountId,
          token: env.ANALYTICS_READ_TOKEN,
          applicationId: config.containerApplicationId,
          hourKey,
          expectedSchemaSha256: config.providerUsageSchemaSha256,
        });
        const result = await reconcileContainerProviderHour(env.DB, {
          hourKey,
          observedAt: now,
          usage,
          liveCostModelSha256: config.liveCostModelSha256,
          providerUsageSchemaSha256: config.providerUsageSchemaSha256,
          releaseReportSha256: config.releaseReportSha256,
        });
        return result.kind === "verified" ? "verified" : result.kind;
      } catch {
        return "incomplete";
      }
    },
    sealHour: async (now) => {
      const result = await sealNextHourlyCost(env.DB, {
        now,
        model: config.liveCostModel,
        liveCostModelSha256: config.liveCostModelSha256,
        providerUsageSchemaSha256: config.providerUsageSchemaSha256,
        releaseReportSha256: config.releaseReportSha256,
      });
      return result.kind;
    },
  };
}
