import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./image-lab-common.mjs";
import { readWranglerOutput } from "./read-wrangler-output.mjs";

const accountPattern = /^[0-9a-f]{32}$/;
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const deploymentIdPattern = /^[a-z0-9][a-z0-9-]{7,63}$/;
const cloudflareApiOrigin = "https://api.cloudflare.com";

class PagesAliasPendingError extends Error {
  constructor() {
    super("Pages stable alias has not reached the deployment yet");
    this.name = "PagesAliasPendingError";
  }
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertName(value, label) {
  if (typeof value !== "string" || !namePattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertDeploymentId(value) {
  if (typeof value !== "string" || !deploymentIdPattern.test(value)) {
    throw new TypeError("Pages deployment ID is invalid");
  }
  return value;
}

function assertHttpsOrigin(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an HTTPS origin`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} must be an exact HTTPS origin`);
  }
  return url.origin;
}

function validateEnvelope(document) {
  const envelope = assertObject(document, "Pages deployment response");
  if (envelope.success !== true) throw new Error("Pages deployment response was not successful");
  if (!Array.isArray(envelope.errors) || envelope.errors.length !== 0) {
    throw new Error("Pages deployment response contains API errors");
  }
  if (!Array.isArray(envelope.messages)) {
    throw new TypeError("Pages deployment response messages are malformed");
  }
  return envelope;
}

export function verifyPagesAlias({
  document,
  project,
  branch,
  deploymentId,
  uniqueUrl,
  stableUrl,
}) {
  assertName(project, "Pages project");
  assertName(branch, "Pages branch");
  assertDeploymentId(deploymentId);
  assertHttpsOrigin(uniqueUrl, "Pages unique URL");
  assertHttpsOrigin(stableUrl, "Pages stable URL");
  if (uniqueUrl === stableUrl) throw new TypeError("Pages unique and stable URLs must differ");
  const deployment = assertObject(validateEnvelope(document).result, "Pages deployment");
  if (deployment.id !== deploymentId) throw new TypeError("Pages deployment ID does not match");
  if (deployment.project_name !== project) throw new TypeError("Pages project does not match");
  if (deployment.url !== uniqueUrl) throw new TypeError("Pages unique URL does not match");
  const trigger = assertObject(deployment.deployment_trigger, "Pages deployment trigger");
  const metadata = assertObject(trigger.metadata, "Pages deployment trigger metadata");
  if (metadata.branch !== branch) throw new TypeError("Pages branch does not match");
  const stage = assertObject(deployment.latest_stage, "Pages deployment latest stage");
  if (stage.status !== "success") throw new Error("Pages deployment stage is not successful");
  if (deployment.aliases === null) {
    if (deployment.environment !== "production" || stableUrl !== `https://${project}.pages.dev`) {
      throw new TypeError("Pages production domain does not match");
    }
  } else {
    if (!Array.isArray(deployment.aliases)) throw new TypeError("Pages aliases must be an array");
    const aliases = deployment.aliases.map((alias) => assertHttpsOrigin(alias, "Pages alias"));
    if (new Set(aliases).size !== aliases.length)
      throw new TypeError("Pages aliases must be unique");
    if (!aliases.includes(stableUrl)) throw new PagesAliasPendingError();
  }
  return { deploymentId, stableUrl, verified: true };
}

function validateApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Cloudflare API origin is invalid");
  }
  if (url.origin !== value || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Cloudflare API origin must contain only an origin");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new TypeError("Cloudflare API origin must use HTTPS or loopback HTTP");
  }
  return url.origin;
}

async function readApiJson(response) {
  if (!response.ok) throw new Error(`Pages deployment API returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1024 * 1024)
    throw new RangeError("Pages deployment response exceeds 1 MiB");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError("Pages deployment response is not valid JSON");
  }
}

export async function inspectPagesAlias({
  accountId,
  apiToken,
  project,
  branch,
  deploymentId,
  uniqueUrl,
  stableUrl,
  apiOrigin = cloudflareApiOrigin,
  timeoutMs = 120_000,
  pollIntervalMs = 500,
}) {
  if (typeof accountId !== "string" || !accountPattern.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  if (
    typeof apiToken !== "string" ||
    apiToken.length < 1 ||
    apiToken.length > 512 ||
    /[\r\n]/.test(apiToken)
  ) {
    throw new TypeError("Cloudflare API token is invalid");
  }
  assertName(project, "Pages project");
  assertName(branch, "Pages branch");
  assertDeploymentId(deploymentId);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError("Pages alias timeout is invalid");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
    throw new RangeError("Pages alias polling interval is invalid");
  }
  const origin = validateApiOrigin(apiOrigin);
  const endpoint = `${origin}/client/v4/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    try {
      return verifyPagesAlias({
        document: await readApiJson(response),
        project,
        branch,
        deploymentId,
        uniqueUrl,
        stableUrl,
      });
    } catch (error) {
      if (!(error instanceof PagesAliasPendingError) || Date.now() >= deadline) {
        if (error instanceof PagesAliasPendingError) {
          throw new Error("Pages stable alias did not update before the deadline");
        }
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
    }
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["pages-output", "project", "branch", "stable-url"]);
  if (Object.keys(args).some((key) => !allowed.has(key)) || Object.keys(args).length !== 4) {
    throw new TypeError(
      "usage: verify-pages-alias --pages-output <file> --project <name> --branch <name> --stable-url <origin>",
    );
  }
  const record = readWranglerOutput({
    text: await readFile(resolve(args["pages-output"]), "utf8"),
    event: "pages-deploy",
    expectedPagesProject: args.project,
    expectedBranch: args.branch,
  });
  const result = await inspectPagesAlias({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    project: args.project,
    branch: args.branch,
    deploymentId: record.deployment_id,
    uniqueUrl: record.url,
    stableUrl: args["stable-url"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
