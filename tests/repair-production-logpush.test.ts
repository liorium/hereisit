import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudflareProcessingResourceApi } from "../scripts/cloudflare-processing-resource-api.mjs";
import {
  repairProductionLogpush,
  runProductionLogpushRepair,
} from "../scripts/repair-production-logpush.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const config = {
  accountId,
  environment: "production",
  workerScriptName: "hereisit-processing-production",
  usageLogBucketName: "hereisit-processing-usage-production",
};
const credentials = { accessKeyId: "private-access", secretAccessKey: "private-secret" };
const response = (result: unknown) => Response.json({ success: true, errors: [], result });

function setup(list: unknown, failList = false) {
  const requests: string[] = [];
  let jobs = list;
  const api = createCloudflareProcessingResourceApi({
    config,
    apiToken: "private-token",
    d1ApiToken: "private-token",
    logpushApiToken: "private-token",
    logpushR2AccessKeyId: credentials.accessKeyId,
    logpushR2SecretAccessKey: credentials.secretAccessKey,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      expect(path).toMatch(/\/logpush\/jobs(?:\/123)?$/);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.dataset).toBe("workers_trace_events");
        expect(JSON.parse(body.filter)).toEqual({
          where: { key: "ScriptName", operator: "eq", value: config.workerScriptName },
        });
        expect(body.output_options.field_names).toEqual([
          "CPUTimeMs",
          "Entrypoint",
          "EventTimestampMs",
          "EventType",
          "Outcome",
          "ScriptName",
          "ScriptVersion",
        ]);
        expect(body.output_options.sample_rate).toBe(1);
        jobs = [{ ...body, id: 123, last_error: null, error_message: null }];
        return response((jobs as object[])[0]);
      }
      if (path.endsWith("/123")) return response((jobs as object[])[0]);
      if (failList)
        return Response.json(
          { success: false, errors: [{ code: 10000, message: "private" }] },
          { status: 403 },
        );
      return response(jobs);
    },
  });
  return { api, requests };
}

describe("production Logpush recovery", () => {
  it("does not create anything when listing is denied", async () => {
    const { api, requests } = setup([], true);
    await expect(
      repairProductionLogpush({ api, config, credentials, expectedJobId: 99, repairMissing: true }),
    ).rejects.toThrow(/HTTP 403/);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("reports missing in inspect mode without changing provider state", async () => {
    const { api, requests } = setup([]);
    expect(
      await repairProductionLogpush({
        api,
        config,
        credentials,
        expectedJobId: 99,
        repairMissing: false,
      }),
    ).toEqual({ state: "missing", expectedJobId: 99, jobCount: 0 });
    expect(requests).toHaveLength(1);
  });

  it("creates only the missing production job and reuses it on a repeated repair", async () => {
    const { api, requests } = setup([]);
    const options = { api, config, credentials, expectedJobId: 99, repairMissing: true };
    const created = await repairProductionLogpush(options);
    expect(created).toEqual({
      state: "created",
      expectedJobId: 99,
      jobId: 123,
      bindingUpdateRequired: true,
    });
    expect(await repairProductionLogpush(options)).toEqual({ ...created, state: "existing" });
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(1);
    expect(JSON.stringify(created)).not.toContain("private");
  });

  it.each([
    [{ id: 99, name: "other", dataset: "other", filter: "{}" }],
    [
      {
        id: 12,
        name: "hereisit-processing-production-usage-ledger",
        dataset: "other",
        filter: "{}",
      },
    ],
    [{ id: 12, name: "other", dataset: "workers_trace_events", filter: "invalid" }],
    [{ id: 12, name: "other", dataset: "workers_trace_events", filter: null }],
    [
      {
        id: 12,
        name: "other",
        dataset: "workers_trace_events",
        filter: '{"where":{"key":"ScriptName","operator":"eq","value":17}}',
      },
    ],
    [{ name: "other", dataset: "workers_trace_events", filter: "{}" }],
  ])("refuses ambiguous or invalid existing jobs without writes: %j", async (job) => {
    const { api, requests } = setup([job]);
    await expect(
      repairProductionLogpush({ api, config, credentials, expectedJobId: 99, repairMissing: true }),
    ).rejects.toThrow();
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("checks the active version and binding before using credentials, and keeps CLI inspection read-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "logpush-cli-"));
    try {
      const id = "123e4567-e89b-42d3-a456-426614174000";
      const stateFile = join(dir, "state.json");
      const versionFile = join(dir, "version.json");
      const bindings = {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        ENVIRONMENT: "production",
        WORKER_SCRIPT_NAME: config.workerScriptName,
        USAGE_LOG_BUCKET_NAME: config.usageLogBucketName,
        USAGE_LOG_PREFIX: "workers-trace-events/production/",
        LOGPUSH_JOB_ID: "99",
      };
      await writeFile(stateFile, JSON.stringify({ activeVersionId: id }));
      await writeFile(
        versionFile,
        JSON.stringify({
          id,
          resources: {
            bindings: Object.entries(bindings).map(([name, text]) => ({
              name,
              text,
              type: "plain_text",
            })),
          },
        }),
      );
      const args = [
        "--account-id",
        accountId,
        "--expected-job-id",
        "99",
        "--repair-missing",
        "false",
        "--state",
        stateFile,
        "--worker-version",
        versionFile,
      ];
      const requests: string[] = [];
      let printed = "";
      const options = {
        env: {
          CLOUDFLARE_LOGPUSH_API_TOKEN: "private-token",
          LOGPUSH_R2_ACCESS_KEY_ID: "private-access",
          LOGPUSH_R2_SECRET_ACCESS_KEY: "private-secret",
        },
        fetchImpl: async (input, init) => {
          expect(init.method).toBe("GET");
          expect(init.signal).toBeInstanceOf(AbortSignal);
          requests.push(String(input));
          return response([]);
        },
        stdout: {
          write: (text: string) => {
            printed += text;
          },
        },
      };
      await runProductionLogpushRepair(args, options);
      expect(JSON.parse(printed)).toEqual({ state: "missing", expectedJobId: 99, jobCount: 0 });
      expect(requests).toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/logpush/jobs`,
      ]);
      args[3] = "100";
      await expect(runProductionLogpushRepair(args, options)).rejects.toThrow(/binding mismatch/);
      expect(requests).toHaveLength(1);
      expect(printed).not.toContain("private");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
