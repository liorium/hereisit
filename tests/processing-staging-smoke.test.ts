import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../scripts/image-lab-common.mjs";
import * as smokeModule from "../scripts/smoke-image-compress-server.mjs";
import {
  classifyJobCreateRateLimit,
  runProcessingPublicSmokeCli,
  runProcessingStagingSmokeCli,
  smokeImageCompressServer,
} from "../scripts/smoke-image-compress-server.mjs";

const browserSmoke = vi.hoisted(() => vi.fn());
const browserLaunch = vi.hoisted(() => vi.fn());
vi.mock("../scripts/support/processing-staging-smoke-runtime.mjs", () => ({
  runProcessingStagingBrowserSmoke: browserSmoke,
}));
vi.mock("@playwright/test", () => ({ chromium: { launch: browserLaunch } }));

const PROCESSING_STAGING_ORIGIN = "https://processing-staging.hereisit.pages.dev";
const PROCESSING_PRODUCTION_ORIGIN = "https://hereisit.app";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const publicBucketZeroSessionId = "eb8f99c7-54e5-48f0-9233-218cc5b7ffef";
const temporaryRoots: string[] = [];

beforeEach(() => {
  browserSmoke.mockReset();
  browserSmoke.mockResolvedValue(stagingSmokeResult());
  browserLaunch.mockReset();
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function outputPath() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-staging-smoke-"));
  temporaryRoots.push(root);
  return join(root, "result.json");
}

function stagingSmokeResult() {
  return {
    schema: "hereisit-processing-staging-smoke@1",
    version: 1,
    passed: true,
    rolloutPercent: 0,
    nonMaintainerLocal: true,
    maintainerServer: true,
    browserPreflight: true,
    exactLengthUpload: true,
    directDownload: true,
    downloadAcknowledged: true,
    sourceFilenameLeak: false,
  };
}

function productionSmokeResult() {
  return {
    ...stagingSmokeResult(),
    schema: "hereisit-processing-production-canary-smoke@1",
  };
}

function publicSmokeResult() {
  return {
    schema: "hereisit-processing-production-public-smoke@1",
    version: 1,
    passed: true,
    rolloutPercent: 100,
    nonMaintainerServer: true,
    directDownload: true,
    downloadAcknowledged: true,
    exactLengthUpload: true,
    sourceFilenameLeak: false,
  };
}

function browserThatStopsAtJobSubmit(publicServer = false) {
  let contextCount = 0;
  return {
    newContext: async () => {
      const maintainer = contextCount++ === 1;
      const listeners = new Map<string, Array<(value: unknown) => void>>();
      let fileSelected = false;
      const page = {
        on: (event: string, listener: (value: unknown) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
        route: async () => undefined,
        goto: async () => {
          const response = {
            url: () => `${PROCESSING_STAGING_ORIGIN}/v1/policy`,
            status: () => 200,
            request: () => ({ method: () => "GET" }),
            json: async () =>
              maintainer
                ? { maintainer: true, execution: "server", reason: null }
                : {
                    maintainer: false,
                    execution: publicServer ? "server" : "local",
                    reason: publicServer ? null : "LOCAL_FALLBACK_REQUIRED",
                  },
          };
          for (const listener of listeners.get("response") ?? []) listener(response);
        },
        locator: (selector: string) => ({
          waitFor: async () => undefined,
          setInputFiles: async () => {
            if (selector === 'input[type="file"]') fileSelected = true;
          },
        }),
        getByText: () => ({
          click: async () => {
            if (!fileSelected) throw new Error("settings are not rendered before file selection");
          },
        }),
        getByRole: (role: string) => ({
          check: async () => undefined,
          click: async () => {
            if (role === "button") throw new Error("stop after setup");
          },
        }),
        waitForTimeout: async () => undefined,
      };
      return {
        addInitScript: async () => undefined,
        newPage: async () => page,
        newCDPSession: async () => ({
          send: async () => undefined,
          on: () => undefined,
        }),
        close: async () => undefined,
      };
    },
    close: async () => undefined,
  };
}

describe("authenticated processing staging smoke", () => {
  it("distinguishes HereIsIt rate limits from an upstream 429", () => {
    expect(
      classifyJobCreateRateLimit({
        scope: "network",
        body: { contract: "tool-job@1", error: { code: "RATE_LIMITED" } },
      }),
    ).toBe("network");
    expect(
      classifyJobCreateRateLimit({
        scope: "session",
        body: { contract: "tool-job@1", error: { code: "RATE_LIMITED" } },
      }),
    ).toBe("session");
    expect(
      classifyJobCreateRateLimit({
        body: { contract: "tool-job@1", error: { code: "RATE_LIMITED" } },
      }),
    ).toBe("application-unscoped");
    expect(
      classifyJobCreateRateLimit({
        body: { contract: "tool-job@1", error: { code: "QUOTA_EXCEEDED" } },
      }),
    ).toBe("quota");
    expect(classifyJobCreateRateLimit({ body: "upstream response" })).toBe("upstream");
  });

  it("selects a file before opening its conditional compression settings", async () => {
    browserLaunch.mockResolvedValue(browserThatStopsAtJobSubmit());
    browserSmoke.mockImplementation((input, implementation) => implementation(input));

    await expect(
      smokeImageCompressServer({
        pageOrigin: PROCESSING_STAGING_ORIGIN,
        maintainerSessionId: sessionId,
      }),
    ).rejects.toThrow("processing staging smoke failed [job-submit]");
  });

  it("requires a non-maintainer server policy before a public job", async () => {
    browserSmoke.mockImplementation((input, implementation) => implementation(input));
    browserLaunch.mockResolvedValue(browserThatStopsAtJobSubmit(false));

    await expect(
      smokeImageCompressServer({
        pageOrigin: PROCESSING_PRODUCTION_ORIGIN,
        publicAdmission: true,
      }),
    ).rejects.toThrow("processing staging smoke failed [public-policy-execution]");

    browserLaunch.mockResolvedValue(browserThatStopsAtJobSubmit(true));

    await expect(
      smokeImageCompressServer({
        pageOrigin: PROCESSING_PRODUCTION_ORIGIN,
        publicAdmission: true,
      }),
    ).rejects.toThrow("processing staging smoke failed [job-submit]");
  });

  it("uses CDP for preflight and a public deterministic rollout-zero session", async () => {
    const digest = createHash("sha256").update(publicBucketZeroSessionId).digest();
    expect(digest.readUInt32BE(0) % 100).toBe(0);

    const source = await readFile("scripts/smoke-image-compress-server.mjs", "utf8");
    expect(source).toContain(publicBucketZeroSessionId);
    expect(source).toContain("newCDPSession(page)");
    expect(source).toContain('send("Network.enable")');
    expect(source).toContain("policy.status !== 200");
    expect(source).toContain("maintainer: false");
    expect(source).toContain('execution: "local"');
    expect(source).toContain('reason: "LOCAL_FALLBACK_REQUIRED"');
    expect(source).toContain(
      'const WEB_ANALYTICS_COLLECTION_URL = "https://cloudflareinsights.com/cdn-cgi/rum"',
    );
    expect(source.match(/page\.route\(WEB_ANALYTICS_COLLECTION_URL/gu)).toHaveLength(2);
    expect(source.match(/route\.fulfill\(\{ status: 204 \}\)/gu)).toHaveLength(2);
    expect(source).toContain("expectedMaintainer: true");
    expect(source).toContain("expectedMaintainer: false");
    expect(source).toContain('execution: "server"');
    expect(source).toContain("reason: null");
    expect(source.match(/maintainer: expectedMaintainer/gu)).toHaveLength(2);
    expect(source).toContain('getByText("압축 설정 · 추천", { exact: true }).click()');
    expect(source).toContain('getByRole("radio", { name: /최소 용량/ }).check()');
  });

  it("proves exact uploads through the validating endpoint response", async () => {
    const source = await readFile("scripts/smoke-image-compress-server.mjs", "utf8");

    expect(source).not.toContain('request.headers()["content-length"]');
    expect(source).toContain("inputPutAccepted");
    expect(source).toContain("response.status() === 204");
  });

  it("checks server uploads before separating browser download and acknowledgement failures", async () => {
    const source = await readFile("scripts/smoke-image-compress-server.mjs", "utf8");
    const uploadCheck = source.indexOf("if (state.inputOptions !== 1)");
    const downloadWait = source.indexOf('page.waitForEvent("download"');

    expect(uploadCheck).toBeGreaterThan(-1);
    expect(downloadWait).toBeGreaterThan(uploadCheck);
    expect(source).toContain("Promise.allSettled([downloadPromise, acknowledgementPromise])");
    expect(source).toContain("[browser-download]");
    expect(source).toContain("[download-ack]");
  });

  it("classifies a failed job creation before reporting a missing upload", async () => {
    const source = await readFile("scripts/smoke-image-compress-server.mjs", "utf8");
    const serverJobSource = source.slice(
      source.indexOf("async function assertServerJob"),
      source.indexOf("async function main"),
    );

    expect(serverJobSource).toContain("jobCreateStatuses: []");
    expect(serverJobSource).toContain("jobCreateRateLimitScopes: []");
    expect(serverJobSource).toContain("jobCreateNetworkFailures: 0");
    expect(source).toContain("[job-create-network]");
    expect(source).toContain("[job-create-network-rate-limit]");
    expect(source).toContain("[job-create-session-rate-limit]");
    expect(source).toContain("[job-create-quota]");
    expect(source).toContain("[job-create-unknown-rate-limit]");
    expect(source).toContain("[job-create-503]");
    expect(source).toContain("[job-create-missing]");
  });

  it("does not expose a production result-minting dependency parameter", async () => {
    const source = await readFile("scripts/smoke-image-compress-server.mjs", "utf8");
    expect(source).not.toMatch(/runProcessingStagingSmokeCli\([\s\S]*?smoke\s*=/u);
    expect(source).not.toContain("const result = await smoke({");
  });

  it("uses the exact focused compression action in both browser paths", async () => {
    const [smokeSource, componentSource] = await Promise.all([
      readFile("scripts/smoke-image-compress-server.mjs", "utf8"),
      readFile("apps/web/src/components/image-compress-workbench.tsx", "utf8"),
    ]);
    expect(smokeSource.match(/name: "용량 줄이기", exact: true/gu)).toHaveLength(1);
    expect(smokeSource).not.toContain("이미지 1개 압축하기");
    expect(componentSource).toContain("용량 줄이기");
  });

  it("accepts only the fixed staging origin, output path, and canonical environment session", async () => {
    const output = await outputPath();
    await runProcessingStagingSmokeCli({
      argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
      environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
    });
    expect(browserSmoke).toHaveBeenCalledWith(
      { pageOrigin: PROCESSING_STAGING_ORIGIN, maintainerSessionId: sessionId },
      expect.any(Function),
    );

    for (const argv of [
      ["--page-origin", "https://example.com", "--output", "result.json"],
      ["--page-origin", PROCESSING_STAGING_ORIGIN],
      [
        "--page-origin",
        PROCESSING_STAGING_ORIGIN,
        "--output",
        "result.json",
        "--session",
        sessionId,
      ],
      ["--output", "result.json", "--page-origin", PROCESSING_STAGING_ORIGIN],
    ]) {
      await expect(
        runProcessingStagingSmokeCli({
          argv,
          environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
        }),
      ).rejects.toThrow("processing staging smoke configuration is invalid");
    }
    for (const invalidSession of [
      undefined,
      "",
      sessionId.toUpperCase(),
      "123e4567-e89b-72d3-a456-426614174000",
      "not-a-session",
    ]) {
      const invalidOutput = await outputPath();
      await expect(
        runProcessingStagingSmokeCli({
          argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", invalidOutput],
          environment:
            invalidSession === undefined ? {} : { STAGING_MAINTAINER_SESSION_ID: invalidSession },
        }),
      ).rejects.toThrow("processing staging smoke configuration is invalid");
    }
  });

  it("uses the isolated production session for the fixed production origin", async () => {
    const output = await outputPath();
    browserSmoke.mockResolvedValue(productionSmokeResult());

    const result = await runProcessingStagingSmokeCli({
      argv: ["--page-origin", PROCESSING_PRODUCTION_ORIGIN, "--output", output],
      environment: { PRODUCTION_MAINTAINER_SESSION_ID: sessionId },
    });

    expect(browserSmoke).toHaveBeenCalledWith(
      { pageOrigin: PROCESSING_PRODUCTION_ORIGIN, maintainerSessionId: sessionId },
      expect.any(Function),
    );
    expect(result).toEqual(productionSmokeResult());
    expect(await readFile(output, "utf8")).toBe(canonicalJson(productionSmokeResult()));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("runs the fixed production public smoke without a maintainer environment", async () => {
    const output = await outputPath();
    browserSmoke.mockResolvedValue(publicSmokeResult());

    const result = await runProcessingPublicSmokeCli({
      argv: ["--page-origin", PROCESSING_PRODUCTION_ORIGIN, "--output", output],
    });

    expect(browserSmoke).toHaveBeenCalledWith(
      { pageOrigin: PROCESSING_PRODUCTION_ORIGIN, publicAdmission: true },
      expect.any(Function),
    );
    expect(result).toEqual(publicSmokeResult());
    expect(await readFile(output, "utf8")).toBe(canonicalJson(publicSmokeResult()));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    for (const argv of [
      ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", "result.json"],
      ["--output", "result.json", "--page-origin", PROCESSING_PRODUCTION_ORIGIN],
      [
        "--page-origin",
        PROCESSING_PRODUCTION_ORIGIN,
        "--output",
        "result.json",
        "--session",
        sessionId,
      ],
    ]) {
      await expect(runProcessingPublicSmokeCli({ argv })).rejects.toThrow(
        /public smoke configuration/i,
      );
    }
  });

  it("keeps the module surface narrow and rejects non-HTTP origins before browser launch", async () => {
    expect(Object.keys(smokeModule).sort()).toEqual([
      "classifyJobCreateRateLimit",
      "projectSmokeRequest",
      "runProcessingPublicSmokeCli",
      "runProcessingStagingSmokeCli",
      "smokeImageCompressServer",
      "summarizeSmokeRequests",
    ]);
    await expect(
      smokeImageCompressServer({ pageOrigin: "ftp://processing.example" }),
    ).rejects.toThrow("page origin must be HTTP(S)");
  });

  it("writes only the canonical mode-0600 result and refuses overwrite", async () => {
    const output = await outputPath();
    const result = await runProcessingStagingSmokeCli({
      argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
      environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
    });

    expect(result).toEqual(stagingSmokeResult());
    expect(browserSmoke).toHaveBeenCalledWith(
      { pageOrigin: PROCESSING_STAGING_ORIGIN, maintainerSessionId: sessionId },
      expect.any(Function),
    );
    expect(await readFile(output, "utf8")).toBe(canonicalJson(stagingSmokeResult()));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(Object.keys(result).sort()).toEqual([
      "browserPreflight",
      "directDownload",
      "downloadAcknowledged",
      "exactLengthUpload",
      "maintainerServer",
      "nonMaintainerLocal",
      "passed",
      "rolloutPercent",
      "schema",
      "sourceFilenameLeak",
      "version",
    ]);
    expect(JSON.stringify(result)).not.toContain(sessionId);
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      }),
    ).rejects.toThrow();
    expect(browserSmoke).toHaveBeenCalledTimes(1);
  });

  it("does not disclose the session or internal failure through direct execution", async () => {
    const output = await outputPath();
    await writeFile(output, "occupied", { mode: 0o600 });
    await chmod(output, 0o600);
    const child = spawnSync(
      process.execPath,
      [
        resolve("scripts/smoke-image-compress-server.mjs"),
        "--page-origin",
        PROCESSING_STAGING_ORIGIN,
        "--output",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, STAGING_MAINTAINER_SESSION_ID: sessionId },
      },
    );

    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("processing staging smoke failed\n");
    expect(`${child.stdout}${child.stderr}`).not.toContain(sessionId);
  });

  it("collapses browser failures before they can disclose private state", async () => {
    const output = await outputPath();
    browserSmoke.mockRejectedValue(new Error(`private ${sessionId}`));
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      }),
    ).rejects.toThrow("processing staging smoke failed");
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      }),
    ).rejects.not.toThrow(sessionId);
  });

  it("preserves only allowlisted policy phase diagnostics", async () => {
    const output = await outputPath();
    browserSmoke.mockRejectedValue(
      new Error("processing staging smoke failed [maintainer-policy-execution]"),
    );
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      }),
    ).rejects.toThrow("processing staging smoke failed [maintainer-policy-execution]");
  });

  it("preserves only allowlisted public policy diagnostics", async () => {
    const output = await outputPath();
    browserSmoke.mockRejectedValue(
      new Error("processing staging smoke failed [public-policy-execution]"),
    );
    await expect(
      runProcessingPublicSmokeCli({
        argv: ["--page-origin", PROCESSING_PRODUCTION_ORIGIN, "--output", output],
      }),
    ).rejects.toThrow("processing staging smoke failed [public-policy-execution]");
  });

  it("preserves only allowlisted browser invariant diagnostics", async () => {
    const output = await outputPath();
    browserSmoke.mockRejectedValue(
      new Error("processing staging smoke failed [maintainer-input-put]"),
    );
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      }),
    ).rejects.toThrow("processing staging smoke failed [maintainer-input-put]");
  });
});
