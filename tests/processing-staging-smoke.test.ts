import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../scripts/image-lab-common.mjs";
import * as smokeModule from "../scripts/smoke-image-compress-server.mjs";
import {
  runProcessingStagingSmokeCli,
  smokeImageCompressServer,
} from "../scripts/smoke-image-compress-server.mjs";

const PROCESSING_STAGING_ORIGIN = "https://processing-staging.hereisit.pages.dev";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const temporaryRoots: string[] = [];

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
  it("accepts only the fixed staging origin, output path, and canonical environment session", async () => {
    const output = await outputPath();
    const smoke = vi.fn(async () => stagingSmokeResult());
    await runProcessingStagingSmokeCli({
      argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
      environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      smoke,
    });
    expect(smoke).toHaveBeenCalledWith({
      pageOrigin: PROCESSING_STAGING_ORIGIN,
      maintainerSessionId: sessionId,
    });

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
          smoke,
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
          smoke,
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
    const smoke = vi.fn(async () => stagingSmokeResult());
    const result = await runProcessingStagingSmokeCli({
      argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
      environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
      smoke,
    });

    expect(result).toEqual(stagingSmokeResult());
    expect(smoke).toHaveBeenCalledWith({
      pageOrigin: PROCESSING_STAGING_ORIGIN,
      maintainerSessionId: sessionId,
    });
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
        smoke,
      }),
    ).rejects.toThrow();
    expect(smoke).toHaveBeenCalledTimes(1);
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
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
        smoke: async () => {
          throw new Error(`private ${sessionId}`);
        },
      }),
    ).rejects.toThrow("processing staging smoke failed");
    await expect(
      runProcessingStagingSmokeCli({
        argv: ["--page-origin", PROCESSING_STAGING_ORIGIN, "--output", output],
        environment: { STAGING_MAINTAINER_SESSION_ID: sessionId },
        smoke: async () => {
          throw new Error(`private ${sessionId}`);
        },
      }),
    ).rejects.not.toThrow(sessionId);
  });
});
