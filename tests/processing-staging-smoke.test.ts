import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../scripts/image-lab-common.mjs";
import * as smokeModule from "../scripts/smoke-image-compress-server.mjs";
import {
  runProcessingStagingSmokeCli,
  smokeImageCompressServer,
} from "../scripts/smoke-image-compress-server.mjs";

const browserSmoke = vi.hoisted(() => vi.fn());
vi.mock("../scripts/support/processing-staging-smoke-runtime.mjs", () => ({
  runProcessingStagingBrowserSmoke: browserSmoke,
}));

const PROCESSING_STAGING_ORIGIN = "https://processing-staging.hereisit.pages.dev";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const publicBucketZeroSessionId = "eb8f99c7-54e5-48f0-9233-218cc5b7ffef";
const temporaryRoots: string[] = [];

beforeEach(() => {
  browserSmoke.mockReset();
  browserSmoke.mockResolvedValue(stagingSmokeResult());
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

describe("authenticated processing staging smoke", () => {
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
    expect(source).toContain("maintainer: true");
    expect(source).toContain('execution: "server"');
    expect(source).toContain("reason: null");
    expect(source.indexOf("await assertPolicies(state, { maintainer: true")).toBeLessThan(
      source.indexOf("await page.locator('[data-policy=\"server\"] strong')"),
    );
  });

  it("does not expose a production result-minting dependency parameter", async () => {
    const source = await readFile("scripts/smoke-image-compress-server.mjs", "utf8");
    expect(source).not.toMatch(/runProcessingStagingSmokeCli\([\s\S]*?smoke\s*=/u);
    expect(source).not.toContain("const result = await smoke({");
  });

  it("uses the real one-item compression action name in both browser paths", async () => {
    const [smokeSource, componentSource] = await Promise.all([
      readFile("scripts/smoke-image-compress-server.mjs", "utf8"),
      readFile("apps/web/src/components/image-compress-workbench.tsx", "utf8"),
    ]);
    expect(smokeSource.match(/1개 이미지 용량 줄이기 →/gu)).toHaveLength(2);
    expect(smokeSource).not.toContain("이미지 1개 압축하기");
    expect(componentSource).toContain("{items.length}개 이미지 용량 줄이기 →");
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

  it("keeps the module surface narrow and rejects non-HTTP origins before browser launch", async () => {
    expect(Object.keys(smokeModule).sort()).toEqual([
      "projectSmokeRequest",
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
      new Error("processing staging smoke failed [maintainer-policy]"),
    );
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      }),
    ).rejects.toThrow("processing staging smoke failed [maintainer-policy]");
  });
});
