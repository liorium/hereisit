import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/download-and-verify-github-artifact.mjs");
const headSha = "a".repeat(40);
const runId = 123;
const artifactId = 321;
const artifactName = "processing-built-candidate";
const temporaryRoots: string[] = [];

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hereisit-github-artifact-"));
  temporaryRoots.push(directory);
  return directory;
}

function defaultZip() {
  return zipSync({
    "processing-candidate.json": new TextEncoder().encode('{"state":"built"}\n'),
    "web/index.html": new TextEncoder().encode("<h1>HereIsIt</h1>\n"),
  });
}

async function startGitHubServer({
  zip = defaultZip(),
  downloadZip = zip,
  runHeadSha = headSha,
  artifacts,
  metadataDigest = `sha256:${sha256(zip)}`,
  expired = false,
  runStatus = "completed",
  runConclusion = "success" as string | null,
} = {}) {
  const requests: Array<{ authorization?: string; path: string; version?: string }> = [];
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    requests.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
      version: request.headers["x-github-api-version"] as string | undefined,
    });
    const sendJson = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === `/repos/liorium/hereisit/actions/runs/${runId}`) {
      sendJson({
        id: runId,
        head_sha: runHeadSha,
        status: runStatus,
        conclusion: runConclusion,
        repository: { full_name: "liorium/hereisit" },
      });
      return;
    }
    if (url.pathname === `/repos/liorium/hereisit/actions/runs/${runId}/artifacts`) {
      const baseArtifact = {
        id: artifactId,
        name: artifactName,
        size_in_bytes: zip.byteLength,
        expired,
        digest: metadataDigest,
        url: `${origin}/repos/liorium/hereisit/actions/artifacts/${artifactId}`,
        archive_download_url: `${origin}/repos/liorium/hereisit/actions/artifacts/${artifactId}/zip`,
        workflow_run: { id: runId, head_sha: runHeadSha },
      };
      const values = artifacts?.(baseArtifact) ?? [baseArtifact];
      sendJson({ total_count: values.length, artifacts: values });
      return;
    }
    if (url.pathname === `/repos/liorium/hereisit/actions/artifacts/${artifactId}/zip`) {
      response.writeHead(302, { location: `${origin}/download/${artifactId}` });
      response.end();
      return;
    }
    if (url.pathname === `/download/${artifactId}`) {
      if (request.headers.authorization !== undefined) {
        response.writeHead(400);
        response.end("authorization leaked");
        return;
      }
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(downloadZip.byteLength),
      });
      response.end(downloadZip);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function runDownloader(
  origin: string,
  outputDir: string,
  expectedSha256: string,
  extra: string[] = [],
) {
  return execFileAsync(
    process.execPath,
    [
      script,
      "--repo",
      "liorium/hereisit",
      "--run-id",
      String(runId),
      "--expected-head-sha",
      headSha,
      "--name",
      artifactName,
      "--expected-sha256",
      expectedSha256,
      "--output-dir",
      outputDir,
      ...extra,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GITHUB_API_URL: origin, GITHUB_TOKEN: "test-token" },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitHub artifact downloader", () => {
  it("accepts only an explicitly allowed in-progress same-run handoff", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({
      zip,
      runStatus: "in_progress",
      runConclusion: null,
    });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "allowed"), sha256(zip), [
          "--allow-in-progress",
          "true",
          "--expected-artifact-id",
          String(artifactId),
        ]),
      ).resolves.toBeDefined();
      await expect(
        runDownloader(server.origin, join(temporary, "default"), sha256(zip)),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("completed successfully") });
    } finally {
      await server.close();
    }
  });

  it.each([
    ["queued", null],
    ["completed", "failure"],
  ])("rejects %s runs even when in-progress handoff is allowed", async (runStatus, runConclusion) => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({ zip, runStatus, runConclusion });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, runStatus), sha256(zip), [
          "--allow-in-progress",
          "true",
          "--expected-artifact-id",
          String(artifactId),
        ]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("completed successfully") });
    } finally {
      await server.close();
    }
  });

  it("requires an exact artifact ID for in-progress handoffs", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({
      zip,
      runStatus: "in_progress",
      runConclusion: null,
    });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip), [
          "--allow-in-progress",
          "true",
        ]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("exact artifact ID") });
    } finally {
      await server.close();
    }
  });

  it("rejects non-literal in-progress opt-in values", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({ zip });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip), [
          "--allow-in-progress",
          "yes",
        ]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("exactly true") });
    } finally {
      await server.close();
    }
  });

  it("binds run, artifact metadata, ZIP digest, and safe extracted bytes", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({ zip });
    const output = join(temporary, "candidate");
    try {
      const result = JSON.parse(
        (
          await runDownloader(server.origin, output, sha256(zip), [
            "--expected-artifact-id",
            String(artifactId),
            "--expected-size",
            String(zip.byteLength),
          ])
        ).stdout,
      );
      expect(result).toEqual({
        version: 1,
        repository: "liorium/hereisit",
        runId,
        headSha,
        artifactId,
        artifactName,
        sizeInBytes: zip.byteLength,
        sha256: sha256(zip),
        fileCount: 2,
      });
      expect(await readFile(join(output, "processing-candidate.json"), "utf8")).toBe(
        '{"state":"built"}\n',
      );
      expect(await readFile(join(output, "web", "index.html"), "utf8")).toBe("<h1>HereIsIt</h1>\n");
      expect(
        server.requests.every(
          (request) => request.version === "2026-03-10" || request.path.startsWith("/download/"),
        ),
      ).toBe(true);
      expect(
        server.requests.find((request) => request.path.startsWith("/download/"))?.authorization,
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("rejects a source workflow SHA mismatch", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({ zip, runHeadSha: "b".repeat(40) });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("workflow run head SHA mismatch"),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects duplicate or expired artifacts before download", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const duplicate = await startGitHubServer({
      zip,
      artifacts: (artifact) => [artifact, { ...artifact, id: artifactId + 1 }],
    });
    try {
      await expect(
        runDownloader(duplicate.origin, join(temporary, "duplicate"), sha256(zip)),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("exactly one named artifact") });
    } finally {
      await duplicate.close();
    }

    const expired = await startGitHubServer({ zip, expired: true });
    try {
      await expect(
        runDownloader(expired.origin, join(temporary, "expired"), sha256(zip)),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("artifact is expired") });
    } finally {
      await expired.close();
    }
  });

  it("requires caller and GitHub digests to match downloaded ZIP bytes", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const metadataMismatch = await startGitHubServer({
      zip,
      metadataDigest: `sha256:${"c".repeat(64)}`,
    });
    try {
      await expect(
        runDownloader(metadataMismatch.origin, join(temporary, "metadata"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("GitHub artifact digest mismatch"),
      });
    } finally {
      await metadataMismatch.close();
    }

    const changedZip = Buffer.from(zip);
    changedZip[0] ^= 1;
    const bytesMismatch = await startGitHubServer({ zip, downloadZip: changedZip });
    try {
      await expect(
        runDownloader(bytesMismatch.origin, join(temporary, "bytes"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("downloaded artifact SHA-256 mismatch"),
      });
    } finally {
      await bytesMismatch.close();
    }
  });

  it("rejects ZIP path escape entries without writing outside output", async () => {
    const temporary = await temporaryDirectory();
    const zip = zipSync({ "../escape.txt": new TextEncoder().encode("no") });
    const server = await startGitHubServer({ zip });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("ZIP entry path is not canonical"),
      });
      await expect(lstat(join(temporary, "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });

  it("rejects Unix symlink entries", async () => {
    const temporary = await temporaryDirectory();
    const zip = Buffer.from(zipSync({ "link.txt": new TextEncoder().encode("target") }));
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const central = zip.indexOf(signature);
    expect(central).toBeGreaterThanOrEqual(0);
    zip.writeUInt16LE(0x0314, central + 4);
    zip.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    const server = await startGitHubServer({ zip });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("ZIP symlink entries are prohibited"),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects ZIP entries with a CRC mismatch after digest verification", async () => {
    const temporary = await temporaryDirectory();
    const zip = Buffer.from(defaultZip());
    const local = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(local).toBeGreaterThanOrEqual(0);
    expect(central).toBeGreaterThanOrEqual(0);
    const invalidCrc = (zip.readUInt32LE(central + 16) ^ 0xffff_ffff) >>> 0;
    zip.writeUInt32LE(invalidCrc, local + 14);
    zip.writeUInt32LE(invalidCrc, central + 16);
    const server = await startGitHubServer({ zip });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("ZIP entry CRC-32 mismatch"),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects unsupported ZIP general-purpose flags", async () => {
    const temporary = await temporaryDirectory();
    const zip = Buffer.from(defaultZip());
    const local = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(local).toBeGreaterThanOrEqual(0);
    expect(central).toBeGreaterThanOrEqual(0);
    zip.writeUInt16LE(zip.readUInt16LE(local + 6) | 0x0040, local + 6);
    zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 0x0040, central + 8);
    const server = await startGitHubServer({ zip });
    try {
      await expect(
        runDownloader(server.origin, join(temporary, "candidate"), sha256(zip)),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("ZIP general-purpose flags are unsupported"),
      });
    } finally {
      await server.close();
    }
  });

  it("never overwrites an existing output directory", async () => {
    const temporary = await temporaryDirectory();
    const zip = defaultZip();
    const server = await startGitHubServer({ zip });
    const output = join(temporary, "candidate");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(output));
    await writeFile(join(output, "sentinel.txt"), "keep-me");
    try {
      await expect(runDownloader(server.origin, output, sha256(zip))).rejects.toMatchObject({
        stderr: expect.stringContaining("output directory already exists"),
      });
      expect(await readFile(join(output, "sentinel.txt"), "utf8")).toBe("keep-me");
    } finally {
      await server.close();
    }
  });
});
