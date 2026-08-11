import { describe, expect, it } from "vitest";
import { readWranglerField, readWranglerOutput } from "../scripts/read-wrangler-output.mjs";

const worker = {
  type: "deploy",
  version: 1,
  worker_name: "hereisit-processing-staging",
  worker_tag: "tag",
  version_id: "11111111-2222-3333-4444-555555555555",
  targets: [
    "https://hereisit-processing-staging.example.workers.dev",
    "schedule: */5 * * * *",
    "Producer for hereisit-image-jobs-staging",
    "Consumer for hereisit-image-jobs-staging",
  ],
  wrangler_environment: null,
  worker_name_overridden: false,
};

const pages = {
  type: "pages-deploy",
  version: 1,
  pages_project: "hereisit",
  deployment_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  url: "https://aaaaaaaa.hereisit.pages.dev",
};

const pagesDetailed = {
  type: "pages-deploy-detailed",
  version: 1,
  pages_project: "hereisit",
  deployment_id: pages.deployment_id,
  url: pages.url,
  alias: "https://processing-staging.hereisit.pages.dev",
  environment: "preview",
  production_branch: "main",
  deployment_trigger: { metadata: { commit_hash: "f".repeat(40) } },
};

function ndjson(...records: unknown[]) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("Wrangler NDJSON reader", () => {
  it("selects exactly one Worker deploy and exposes only approved scalar fields", () => {
    const record = readWranglerOutput({ text: ndjson(worker), event: "deploy" });

    expect(record).toEqual(worker);
    expect(readWranglerField(record, "targets.0")).toBe(worker.targets[0]);
    expect(readWranglerField(record, "version_id")).toBe(worker.version_id);
    expect(() => readWranglerField(record, "constructor.prototype")).toThrow(/field/i);
    expect(() => readWranglerField(record, "targets")).toThrow(/scalar/i);
  });

  it("selects one exact Worker target without depending on target order", () => {
    const customTarget = "https://api.hereisit.app";
    const renderedCustomTarget = "api.hereisit.app (custom domain)";
    const record = readWranglerOutput({
      text: ndjson({
        ...worker,
        targets: [worker.targets[0], renderedCustomTarget, ...worker.targets.slice(1)],
      }),
      event: "deploy",
    });

    expect(readWranglerField(record, "target", customTarget)).toBe(customTarget);
    expect(() => readWranglerField(record, "target", "https://missing.example")).toThrow(/target/i);
    expect(() =>
      readWranglerField(
        { ...record, targets: [...record.targets, renderedCustomTarget] },
        "target",
        customTarget,
      ),
    ).toThrow(/target/i);
    expect(() => readWranglerField(record, "target", "http://api.hereisit.app")).toThrow(/HTTPS/i);
  });

  it("selects the primary Pages record and cross-checks its detailed record", () => {
    const record = readWranglerOutput({
      text: ndjson(pagesDetailed, pages),
      event: "pages-deploy",
      expectedPagesProject: "hereisit",
      expectedBranch: "processing-staging",
    });

    expect(record).toEqual(pages);
    expect(readWranglerField(record, "url")).toBe(pages.url);
    expect(readWranglerField(record, "deployment_id")).toBe(pages.deployment_id);
  });

  it.each([
    ["malformed line", `${JSON.stringify(worker)}\nnot-json\n`],
    ["command failure", ndjson(worker, { type: "command-failed", version: 1, message: "no" })],
    ["missing deploy", ndjson({ type: "notice", version: 1 })],
    ["duplicate deploy", ndjson(worker, worker)],
    ["non-HTTPS target", ndjson({ ...worker, targets: ["http://example.test"] })],
    ["invalid trigger target", ndjson({ ...worker, targets: [worker.targets[0], 1] })],
  ])("rejects %s", (_label, text) => {
    expect(() => readWranglerOutput({ text, event: "deploy" })).toThrow();
  });

  it("rejects Pages project, branch, and detailed-record mismatches", () => {
    expect(() =>
      readWranglerOutput({
        text: ndjson(pages, pagesDetailed),
        event: "pages-deploy",
        expectedPagesProject: "other",
        expectedBranch: "processing-staging",
      }),
    ).toThrow(/project/i);
    expect(() =>
      readWranglerOutput({
        text: ndjson(pages, pagesDetailed),
        event: "pages-deploy",
        expectedPagesProject: "hereisit",
        expectedBranch: "main",
      }),
    ).toThrow(/branch/i);
    expect(() =>
      readWranglerOutput({
        text: ndjson(pages, { ...pagesDetailed, deployment_id: "different" }),
        event: "pages-deploy",
        expectedPagesProject: "hereisit",
        expectedBranch: "processing-staging",
      }),
    ).toThrow(/detailed/i);
  });

  it("requires exactly one detailed record when Pages cross-checking is requested", () => {
    expect(() =>
      readWranglerOutput({
        text: ndjson(pages),
        event: "pages-deploy",
        expectedPagesProject: "hereisit",
        expectedBranch: "processing-staging",
      }),
    ).toThrow(/detailed/i);
  });
});
