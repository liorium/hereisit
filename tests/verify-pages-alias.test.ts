import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPagesAlias, verifyPagesAlias } from "../scripts/verify-pages-alias.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const project = "hereisit";
const branch = "processing-staging";
const deploymentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const uniqueUrl = "https://aaaaaaaa.hereisit.pages.dev";
const stableUrl = "https://processing-staging.hereisit.pages.dev";

function deployment(aliases = [stableUrl]) {
  return {
    id: deploymentId,
    aliases,
    created_on: "2026-07-19T00:00:00.000Z",
    deployment_trigger: {
      metadata: {
        branch,
        commit_dirty: false,
        commit_hash: "f".repeat(40),
        commit_message: "release",
      },
      type: "ad_hoc",
    },
    environment: "preview",
    is_skipped: false,
    latest_stage: {
      ended_on: "2026-07-19T00:01:00.000Z",
      name: "deploy",
      started_on: "2026-07-19T00:00:00.000Z",
      status: "success",
    },
    modified_on: "2026-07-19T00:01:00.000Z",
    project_id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    project_name: project,
    short_id: "aaaaaaaa",
    url: uniqueUrl,
  };
}

function envelope(result: unknown) {
  return { errors: [], messages: [], result, success: true };
}

const servers: Array<ReturnType<typeof createServer>> = [];

async function startApi(results: unknown[]) {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  let index = 0;
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(envelope(results[Math.min(index++, results.length - 1)])));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server failed");
  return { apiOrigin: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("Pages stable alias verifier", () => {
  it("polls the exact deployment until its branch alias points to it", async () => {
    const api = await startApi([deployment([]), deployment()]);

    await expect(
      inspectPagesAlias({
        accountId,
        apiToken: "test-token",
        project,
        branch,
        deploymentId,
        uniqueUrl,
        stableUrl,
        apiOrigin: api.apiOrigin,
        timeoutMs: 500,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ deploymentId, stableUrl, verified: true });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]).toEqual({
      url: `/client/v4/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}`,
      authorization: "Bearer test-token",
    });
  });

  it("validates the deployment, project, branch, unique URL, and alias together", () => {
    expect(
      verifyPagesAlias({
        document: envelope(deployment()),
        project,
        branch,
        deploymentId,
        uniqueUrl,
        stableUrl,
      }),
    ).toEqual({ deploymentId, stableUrl, verified: true });
  });

  it.each([
    ["deployment", { id: "wrong" }],
    ["project", { project_name: "other" }],
    ["branch", { deployment_trigger: { metadata: { branch: "main" } } }],
    ["unique URL", { url: "https://other.pages.dev" }],
    ["failed stage", { latest_stage: { status: "failure" } }],
    ["duplicate alias", { aliases: [stableUrl, stableUrl] }],
  ])("rejects a mismatched %s", (_label, override) => {
    expect(() =>
      verifyPagesAlias({
        document: envelope({ ...deployment(), ...override }),
        project,
        branch,
        deploymentId,
        uniqueUrl,
        stableUrl,
      }),
    ).toThrow();
  });

  it("fails when the stable alias remains stale until the deadline", async () => {
    const api = await startApi([deployment([])]);
    await expect(
      inspectPagesAlias({
        accountId,
        apiToken: "test-token",
        project,
        branch,
        deploymentId,
        uniqueUrl,
        stableUrl,
        apiOrigin: api.apiOrigin,
        timeoutMs: 20,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/alias|deadline/i);
  });
});
