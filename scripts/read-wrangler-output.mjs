import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./image-lab-common.mjs";

const allowedFields = {
  deploy: new Set(["version_id", "worker_name", "worker_tag", "targets", "targets.0"]),
  "pages-deploy": new Set(["pages_project", "deployment_id", "url"]),
};

function parseRecords(text) {
  if (typeof text !== "string") throw new TypeError("Wrangler output must be text");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new TypeError("Wrangler output is empty");
  return lines.map((line, index) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TypeError(`Wrangler output line ${index + 1} is malformed JSON`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Wrangler output line ${index + 1} must be an object`);
    }
    return value;
  });
}

function assertHttps(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a URL`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError(`${label} must use authenticated HTTPS`);
  }
  return url;
}

function selectOne(records, type) {
  const selected = records.filter((record) => record.type === type && record.version === 1);
  if (selected.length !== 1) {
    throw new TypeError(`Wrangler output must contain exactly one ${type} version 1 record`);
  }
  return selected[0];
}

function validateWorker(record) {
  if (
    !Array.isArray(record.targets) ||
    record.targets.length === 0 ||
    record.targets.length > 100
  ) {
    throw new TypeError("Worker deploy targets are invalid");
  }
  if (
    record.targets.some(
      (target) => typeof target !== "string" || target.length === 0 || target.length > 2_048,
    )
  ) {
    throw new TypeError("Worker deploy target is invalid");
  }
  assertHttps(record.targets[0], "Worker target");
  if (typeof record.version_id !== "string" || record.version_id.length === 0) {
    throw new TypeError("Worker deploy version_id is missing");
  }
}

function validatePages(record) {
  if (typeof record.pages_project !== "string" || record.pages_project.length === 0) {
    throw new TypeError("Pages project is missing");
  }
  if (typeof record.deployment_id !== "string" || record.deployment_id.length === 0) {
    throw new TypeError("Pages deployment ID is missing");
  }
  assertHttps(record.url, "Pages deployment URL");
}

function crossCheckPages(records, primary, expectedPagesProject, expectedBranch) {
  const details = records.filter(
    (record) => record.type === "pages-deploy-detailed" && record.version === 1,
  );
  if (details.length !== 1) {
    throw new TypeError("Pages cross-check requires exactly one detailed record");
  }
  const detail = details[0];
  if (
    detail.pages_project !== primary.pages_project ||
    detail.deployment_id !== primary.deployment_id ||
    detail.url !== primary.url
  ) {
    throw new TypeError("Pages detailed record does not match the primary deployment");
  }
  if (primary.pages_project !== expectedPagesProject) {
    throw new TypeError("Pages project does not match the expected project");
  }
  if (typeof expectedBranch !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(expectedBranch)) {
    throw new TypeError("expected Pages branch is invalid");
  }
  const expectedPreviewHost = `${expectedBranch}.${expectedPagesProject}.pages.dev`;
  const expectedProduction =
    detail.environment === "production" && detail.production_branch === expectedBranch;
  if (expectedProduction) return;
  const alias = assertHttps(detail.alias, "Pages detailed alias");
  if (alias.hostname !== expectedPreviewHost || alias.pathname !== "/") {
    throw new TypeError("Pages detailed branch alias does not match the expected branch");
  }
}

export function readWranglerOutput({ text, event, expectedPagesProject, expectedBranch }) {
  if (event !== "deploy" && event !== "pages-deploy") {
    throw new TypeError("Wrangler event must be deploy or pages-deploy");
  }
  const records = parseRecords(text);
  if (records.some((record) => record.type === "command-failed")) {
    throw new Error("Wrangler reported command-failed");
  }
  const record = selectOne(records, event);
  if (event === "deploy") {
    if (expectedPagesProject !== undefined || expectedBranch !== undefined) {
      throw new TypeError("Pages expectations are not valid for Worker deploys");
    }
    validateWorker(record);
  } else {
    validatePages(record);
    if ((expectedPagesProject === undefined) !== (expectedBranch === undefined)) {
      throw new TypeError("Pages project and branch expectations must be provided together");
    }
    if (expectedPagesProject !== undefined) {
      crossCheckPages(records, record, expectedPagesProject, expectedBranch);
    }
  }
  return record;
}

export function readWranglerField(record, field) {
  const event = record?.type;
  const fields = allowedFields[event];
  if (fields === undefined || typeof field !== "string" || !fields.has(field)) {
    throw new TypeError("Wrangler field is not allowlisted");
  }
  const value = field === "targets.0" ? record.targets?.[0] : record[field];
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new TypeError("Wrangler field must resolve to a scalar");
  }
  return value;
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["file", "event", "field", "expected-pages-project", "expected-branch"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new TypeError("unknown Wrangler reader argument");
  }
  if (args.file === undefined || args.event === undefined || args.field === undefined) {
    throw new TypeError("--file, --event, and --field are required");
  }
  const record = readWranglerOutput({
    text: await readFile(resolve(args.file), "utf8"),
    event: args.event,
    expectedPagesProject: args["expected-pages-project"],
    expectedBranch: args["expected-branch"],
  });
  process.stdout.write(`${String(readWranglerField(record, args.field))}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
