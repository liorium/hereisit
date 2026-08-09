import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sha256Bytes, sha256Canonical } from "./image-lab-common.mjs";
import { smokeImageCompressServer } from "./smoke-image-compress-server.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const mimeByFormat = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function redactProcessingStackOutput(value) {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1[redacted]")
    .replace(/\/v1\/jobs\/[0-9a-f-]+\/input/gi, "/v1/jobs/[redacted]/input")
    .replace(/(x-download-lease\s*[:=]\s*)\S+/gi, "$1[redacted]");
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port allocation failed");
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
  return address.port;
}

export function createEdgeForwardHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || ["connection", "host"].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("cf-connecting-ip", "203.0.113.10");
  return headers;
}

export function shouldForwardEdgeResponseHeader(name) {
  return !["connection", "content-encoding", "content-length", "transfer-encoding"].includes(
    name.toLowerCase(),
  );
}

async function startLocalEdgeProxy(port, upstreamOrigin) {
  const server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const method = request.method ?? "GET";
        const upstream = await fetch(new URL(request.url ?? "/", upstreamOrigin), {
          method,
          headers: createEdgeForwardHeaders(request.headers),
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: Readable.toWeb(request), duplex: "half" }),
        });
        response.statusCode = upstream.status;
        for (const [name, value] of upstream.headers) {
          if (shouldForwardEdgeResponseHeader(name)) {
            response.setHeader(name, value);
          }
        }
        if (upstream.body === null) response.end();
        else await pipeline(Readable.fromWeb(upstream.body), response);
      } catch {
        if (!response.headersSent) response.statusCode = 502;
        response.end();
      }
    })();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return server;
}

async function stopServer(server) {
  if (server === undefined) return;
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

function publicCorsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-download-lease",
    "access-control-expose-headers":
      "content-length, content-type, etag, retry-after, x-download-lease",
    vary: "Origin",
  };
}

function sendJson(response, status, body, origin) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...publicCorsHeaders(origin),
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": String(bytes.byteLength),
  });
  response.end(bytes);
}

async function readSmallJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024) throw new Error("composed API JSON body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicPolicy() {
  return {
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    execution: "server",
    reason: null,
    maintainer: false,
    disclosure: {
      upload: true,
      inputDeletion: "terminal",
      resultDeletion: {
        mode: "server-temporary",
        acknowledged: "immediate-delete-attempt",
        unacknowledgedDueSeconds: 1800,
        applicationSloSeconds: 2100,
        lifecycleExpirationDays: 1,
        exceptionalDelayPossible: true,
      },
    },
    limits: {
      maxFiles: 20,
      maxBytesPerFile: 30 * 1024 * 1024,
      maxPixelsPerFile: 40_000_000,
    },
  };
}

export function publicEngineStatus(status) {
  const now = new Date().toISOString();
  const processingMs = status.measurements?.processingMs ?? 0;
  const timing = { queueMs: 0, processingMs, totalMs: processingMs };
  if (status.state === "succeeded") {
    const result =
      status.result.kind === "download"
        ? {
            kind: "download",
            mime: status.result.mime,
            byteLength: status.result.byteLength,
            width: status.result.width,
            height: status.result.height,
            engineBuildId: status.result.engineBuildId,
            codecBuildId: status.result.codecBuildId,
            warnings: status.result.warnings,
            timing,
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }
        : {
            kind: "original-retained",
            reason: "NO_SIZE_REDUCTION",
            testedCandidates: status.result.testedCandidates,
            engineBuildId: status.result.engineBuildId,
            codecBuildId: status.result.codecBuildId,
            warnings: status.result.warnings,
            timing,
          };
    return {
      contract: "tool-job@1",
      jobId: status.jobId,
      state: "succeeded",
      phase: "completed",
      phaseFraction: 1,
      sequence: status.sequence,
      attempt: 1,
      result,
      updatedAt: now,
    };
  }
  if (status.state === "failed" || status.state === "cancelled") {
    return {
      contract: "tool-job@1",
      jobId: status.jobId,
      state: status.state,
      phase: status.phase ?? "validating",
      phaseFraction: status.fraction,
      sequence: status.sequence,
      attempt: 1,
      error: {
        ...status.error,
        message:
          status.state === "cancelled" ? "작업이 취소되었습니다." : "이미지를 처리하지 못했습니다.",
      },
      updatedAt: now,
    };
  }
  return {
    contract: "tool-job@1",
    jobId: status.jobId,
    state: status.state === "running" ? "running" : "queued",
    phase: status.state === "running" ? status.phase : "queued",
    phaseFraction: status.state === "running" ? status.fraction : 0,
    sequence: status.sequence,
    attempt: 1,
    updatedAt: now,
  };
}

async function startComposedProcessingApi(port, engineOrigin, pageOrigin) {
  const jobs = new Map();
  const server = createHttpServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://composed.local");
      if (method === "OPTIONS") {
        response.writeHead(204, publicCorsHeaders(pageOrigin));
        response.end();
        return;
      }
      if (method === "POST" && url.pathname === "/v1/policy") {
        await readSmallJson(request);
        sendJson(response, 200, publicPolicy(), pageOrigin);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/jobs") {
        const body = await readSmallJson(request);
        const jobId = randomUUID();
        const engineRequest = {
          protocol: 1,
          jobId,
          attempt: 1,
          tool: "image.optimize",
          toolVersion: 1,
          spec: body.spec,
          specHash: sha256Canonical(body.spec),
          input: {
            byteLength: body.input.byteLength,
            etag: `composed-${jobId}`,
            mimeHint: body.input.mimeHint,
          },
          resourceClass: "image-standard-v1",
        };
        const created = await fetch(`${engineOrigin}/v1/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(engineRequest),
        });
        if (created.status !== 201) throw new Error("composed engine create failed");
        jobs.set(jobId, { mime: body.input.mimeHint, byteLength: body.input.byteLength });
        sendJson(
          response,
          201,
          {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              contentType: body.input.mimeHint,
              byteLength: body.input.byteLength,
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            },
            reservedWeightedUnits: 1,
          },
          pageOrigin,
        );
        return;
      }
      const match = /^\/v1\/jobs\/([0-9a-f-]+)(?:\/(input|result|cancel|downloaded))?$/.exec(
        url.pathname,
      );
      const jobId = match?.[1];
      const action = match?.[2] ?? null;
      if (jobId === undefined || !jobs.has(jobId)) {
        sendJson(
          response,
          404,
          {
            contract: "tool-job@1",
            error: {
              code: "INVALID_REQUEST",
              message: "작업을 찾을 수 없습니다.",
              retryable: false,
            },
          },
          pageOrigin,
        );
        return;
      }
      if (method === "PUT" && action === "input") {
        const job = jobs.get(jobId);
        const uploaded = await fetch(`${engineOrigin}/v1/jobs/${jobId}/input`, {
          method: "PUT",
          headers: {
            "content-type": job.mime,
            "content-length": String(job.byteLength),
          },
          body: Readable.toWeb(request),
          duplex: "half",
        });
        if (uploaded.status !== 204) throw new Error("composed engine upload failed");
        const run = await fetch(`${engineOrigin}/v1/jobs/${jobId}/run`, { method: "POST" });
        if (run.status !== 202) throw new Error("composed engine run failed");
        response.writeHead(204, publicCorsHeaders(pageOrigin));
        response.end();
        return;
      }
      if (method === "GET" && action === null) {
        const engine = await fetch(`${engineOrigin}/v1/jobs/${jobId}`);
        sendJson(response, engine.status, publicEngineStatus(await engine.json()), pageOrigin);
        return;
      }
      if (method === "GET" && action === "result") {
        const engine = await fetch(`${engineOrigin}/v1/jobs/${jobId}/output`);
        const contentLength = engine.headers.get("content-length");
        if (contentLength === null) throw new Error("composed engine result length missing");
        response.writeHead(engine.status, {
          ...publicCorsHeaders(pageOrigin),
          "content-length": contentLength,
          "content-type": engine.headers.get("content-type") ?? "application/octet-stream",
          "x-download-lease": "a".repeat(43),
        });
        if (engine.body === null) response.end();
        else await pipeline(Readable.fromWeb(engine.body), response);
        return;
      }
      if (
        (method === "POST" && ["cancel", "downloaded"].includes(action ?? "")) ||
        (method === "DELETE" && action === null)
      ) {
        await fetch(`${engineOrigin}/v1/jobs/${jobId}`, { method: "DELETE" });
        jobs.delete(jobId);
        response.writeHead(204, publicCorsHeaders(pageOrigin));
        response.end();
        return;
      }
      response.writeHead(405, publicCorsHeaders(pageOrigin));
      response.end();
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(
          response,
          500,
          {
            contract: "tool-job@1",
            error: { code: "STORAGE_FAILURE", message: "로컬 합성 API 오류", retryable: true },
          },
          pageOrigin,
        );
      } else response.destroy();
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return server;
}

function forward(child, label) {
  for (const [stream, destination] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream?.on("data", (chunk) => {
      destination.write(`[${label}] ${redactProcessingStackOutput(String(chunk))}`);
    });
  }
}

function startChild(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  forward(child, options.label);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  const timeout = new Promise((resolvePromise) => setTimeout(resolvePromise, 8_000, "timeout"));
  if ((await Promise.race([exited, timeout])) === "timeout") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

async function waitForEndpoint(url, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child !== undefined && child.exitCode !== null) {
      throw new Error(`stack child exited before readiness: ${url}`);
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`stack endpoint did not become ready: ${url}`);
}

async function docker(...args) {
  const result = await execute("docker", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

async function prepareLocalEngineOverlay() {
  await docker("image", "inspect", "hereisit-image-engine:test").catch(() => {
    throw new Error(
      "prebuilt local engine image is required; build it once before running the stack test",
    );
  });
  await execute("pnpm", ["prepare:image-engine:local"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function pollEngine(origin, jobId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/v1/jobs/${jobId}`);
    if (!response.ok) throw new Error(`stack engine status failed: ${response.status}`);
    const status = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(status.state)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("stack engine job hung");
}

async function runEngineInput({ origin, path, format, expected }) {
  const bytes = await readFile(path);
  const jobId = randomUUID();
  const spec = {
    version: 1,
    mode: "smart",
    preset: "balanced",
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  };
  let outcome;
  let processingError;
  try {
    const created = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: 1,
        jobId,
        attempt: 1,
        tool: "image.optimize",
        toolVersion: 1,
        spec,
        specHash: sha256Canonical(spec),
        input: {
          byteLength: bytes.byteLength,
          etag: `stack-${sha256Bytes(bytes)}`,
          mimeHint: mimeByFormat[format],
        },
        resourceClass: "image-standard-v1",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (created.status !== 201) throw new Error(`stack engine create failed: ${created.status}`);
    const upload = await fetch(`${origin}/v1/jobs/${jobId}/input`, {
      method: "PUT",
      headers: {
        "content-type": mimeByFormat[format],
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
      signal: AbortSignal.timeout(10_000),
    });
    if (upload.status !== 204) throw new Error(`stack engine upload failed: ${upload.status}`);
    const run = await fetch(`${origin}/v1/jobs/${jobId}/run`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    if (run.status !== 202) throw new Error(`stack engine run failed: ${run.status}`);
    const status = await pollEngine(origin, jobId);
    if (expected === "success" && status.state !== "succeeded") {
      throw new Error(`stack engine unexpectedly rejected ${format}`);
    }
    if (expected === "reject" && status.state !== "failed") {
      throw new Error(`stack engine unexpectedly accepted invalid ${format}`);
    }
    if (expected === "original-retained") {
      if (status.state !== "succeeded" || status.result.kind !== "original-retained") {
        throw new Error(`stack engine did not retain the optimized ${format} original`);
      }
    }
    outcome = status.state === "succeeded" ? status.result.kind : `rejected:${status.error.code}`;
  } catch (error) {
    processingError = error;
  }
  let deletionError;
  try {
    const deleted = await fetch(`${origin}/v1/jobs/${jobId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    if (deleted.status !== 204 && deleted.status !== 404) {
      throw new Error(`stack engine delete failed: ${deleted.status}`);
    }
    const afterDelete = await fetch(`${origin}/v1/jobs/${jobId}`);
    if (afterDelete.status !== 404) throw new Error("stack engine retained a deleted job");
  } catch (error) {
    deletionError = error;
  }
  if (processingError !== undefined) throw processingError;
  if (deletionError !== undefined) throw deletionError;
  return outcome;
}

async function verifyEngineCases(origin) {
  const corpus = resolve(root, "tests/image-corpus/public");
  const cases = [
    ["photo-ordinary-jpeg.jpg", "jpeg", "success"],
    ["ui-controls-png.png", "png", "success"],
    ["illustration-webp.webp", "webp", "success"],
    ["malformed-png.png", "png", "reject"],
    ["bomb-declaration-png.png", "png", "reject"],
    ["already-optimized-webp.webp", "webp", "original-retained"],
  ];
  const outcomes = [];
  for (const [name, format, expected] of cases) {
    outcomes.push(await runEngineInput({ origin, path: resolve(corpus, name), format, expected }));
  }
  return outcomes;
}

export function dynamicWorkerConfig(
  source,
  pageOrigin,
  identity,
  { reuseLocalEngineImage = false, localCompatibilityDate = null } = {},
) {
  const appOrigins = JSON.stringify([pageOrigin]);
  let replaced = source
    .replace('"name": "hereisit-api-worker-local"', `"name": "hereisit-stack-${identity}"`)
    .replace(/^\s*"APP_ORIGINS":.*$/m, `    "APP_ORIGINS": ${JSON.stringify(appOrigins)},`);
  if (reuseLocalEngineImage) {
    replaced = replaced
      .replace(
        '"image": "../image-engine/Dockerfile"',
        '"image": "../image-engine/Dockerfile.local-reuse"',
      )
      .replace('"image_build_context": "../.."', '"image_build_context": "../image-engine"');
    if (!replaced.includes('"image": "../image-engine/Dockerfile.local-reuse"')) {
      throw new Error("stack Worker configuration could not enable local image reuse");
    }
  }
  if (localCompatibilityDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localCompatibilityDate)) {
      throw new TypeError("local compatibility date is invalid");
    }
    replaced = replaced.replace(
      /"compatibility_date":\s*"\d{4}-\d{2}-\d{2}"/,
      `"compatibility_date": "${localCompatibilityDate}"`,
    );
    if (!replaced.includes(`"compatibility_date": "${localCompatibilityDate}"`)) {
      throw new Error("stack Worker compatibility date could not be specialized");
    }
  }
  if (replaced === source || !replaced.includes(pageOrigin)) {
    throw new Error("stack Worker configuration could not be specialized");
  }
  return replaced;
}

async function testComposedProcessingStack() {
  const [apiPort, pagePort] = await Promise.all([availablePort(), availablePort()]);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const pageOrigin = `http://127.0.0.1:${pagePort}`;
  process.stdout.write(`${JSON.stringify({ mode: "composed", apiPort, pagePort })}\n`);

  const children = [];
  let engineContainer;
  let processingApi;
  try {
    engineContainer = await docker(
      "run",
      "--detach",
      "--rm",
      "--publish",
      "127.0.0.1::8080",
      "--env",
      "ENGINE_BUILD_ID=stack",
      "--env",
      "JPEG_CODEC_BUILD_ID=mozjpeg",
      "--env",
      "PNG_CODEC_BUILD_ID=oxipng-quantizr",
      "--env",
      "WEBP_CODEC_BUILD_ID=libwebp",
      "--env",
      "TRANSFORM_BUILD_ID=libvips",
      "hereisit-image-engine:local-source",
    );
    const enginePortLine = await docker("port", engineContainer, "8080/tcp");
    const enginePort = enginePortLine.match(/:(\d+)$/)?.[1];
    if (enginePort === undefined) throw new Error("stack engine port was not published");
    const engineOrigin = `http://127.0.0.1:${enginePort}`;
    await waitForEndpoint(`${engineOrigin}/healthz`);
    const engineOutcomes = await verifyEngineCases(engineOrigin);

    processingApi = await startComposedProcessingApi(apiPort, engineOrigin, pageOrigin);
    await execute("pnpm", ["--filter", "@hereisit/web", "build"], {
      cwd: root,
      env: {
        ...process.env,
        NEXT_PUBLIC_PROCESSING_API_ORIGIN: apiOrigin,
        ALLOW_LOCAL_PROCESSING_ORIGINS: "1",
      },
      maxBuffer: 16 * 1024 * 1024,
    });

    const pages = startChild(
      "pnpm",
      [
        "--filter",
        "@hereisit/web",
        "exec",
        "wrangler",
        "pages",
        "dev",
        "out",
        "--ip",
        "127.0.0.1",
        "--port",
        String(pagePort),
        "--compatibility-date=2026-07-10",
        "--log-level",
        "warn",
        "--show-interactive-dev-session=false",
      ],
      { label: "pages" },
    );
    children.push(pages);
    await waitForEndpoint(`${pageOrigin}/`, pages);
    const browser = await smokeImageCompressServer({ pageOrigin });
    return {
      mode: "composed",
      engineOutcomes,
      browser,
      workerIntegration: "separate-test:worker",
      orphanObjects: 0,
    };
  } finally {
    for (const child of children.reverse()) await stopChild(child);
    await stopServer(processingApi);
    if (engineContainer !== undefined) {
      await docker("rm", "--force", engineContainer).catch(() => undefined);
    }
  }
}

export async function testProcessingStack() {
  await prepareLocalEngineOverlay();
  if (process.env.HEREISIT_FULL_CLOUDFLARE_LOCAL !== "1") {
    return testComposedProcessingStack();
  }
  const identity = `${process.pid}-${Date.now()}`;
  const artifactRoot = resolve(root, ".artifacts/processing-stack", identity);
  const persistence = resolve(artifactRoot, "wrangler-state");
  const environmentFile = resolve(artifactRoot, "worker.env");
  const workerConfig = resolve(root, "apps/api-worker", `wrangler.stack-${identity}.jsonc`);
  const [workerPort, apiPort, pagePort, inspectorPort] = await Promise.all([
    availablePort(),
    availablePort(),
    availablePort(),
    availablePort(),
  ]);
  const workerOrigin = `http://127.0.0.1:${workerPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const pageOrigin = `http://127.0.0.1:${pagePort}`;
  process.stdout.write(`${JSON.stringify({ workerPort, apiPort, pagePort })}\n`);
  const children = [];
  let engineContainer;
  let edgeProxy;
  try {
    await mkdir(persistence, { recursive: true });
    await writeFile(
      environmentFile,
      [
        "ABUSE_HMAC_SECRET_CURRENT=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        "ABUSE_HMAC_SECRET_PREVIOUS=__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const baseConfig = await readFile(
      resolve(root, "apps/api-worker/wrangler.local.jsonc"),
      "utf8",
    );
    await writeFile(
      workerConfig,
      dynamicWorkerConfig(baseConfig, pageOrigin, identity, {
        reuseLocalEngineImage: true,
      }),
      { mode: 0o600 },
    );

    engineContainer = await docker(
      "run",
      "--detach",
      "--rm",
      "--publish",
      "127.0.0.1::8080",
      "--env",
      "ENGINE_BUILD_ID=stack",
      "--env",
      "JPEG_CODEC_BUILD_ID=mozjpeg",
      "--env",
      "PNG_CODEC_BUILD_ID=oxipng-quantizr",
      "--env",
      "WEBP_CODEC_BUILD_ID=libwebp",
      "--env",
      "TRANSFORM_BUILD_ID=libvips",
      "hereisit-image-engine:local-source",
    );
    const enginePortLine = await docker("port", engineContainer, "8080/tcp");
    const enginePort = enginePortLine.match(/:(\d+)$/)?.[1];
    if (enginePort === undefined) throw new Error("stack engine port was not published");
    const engineOrigin = `http://127.0.0.1:${enginePort}`;
    await waitForEndpoint(`${engineOrigin}/healthz`);
    const engineOutcomes = await verifyEngineCases(engineOrigin);

    await execute(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        persistence,
        "--config",
        workerConfig,
      ],
      { cwd: root, env: { ...process.env, CI: "1" }, maxBuffer: 8 * 1024 * 1024 },
    );
    await execute("pnpm", ["--filter", "@hereisit/web", "build"], {
      cwd: root,
      env: {
        ...process.env,
        NEXT_PUBLIC_PROCESSING_API_ORIGIN: apiOrigin,
        ALLOW_LOCAL_PROCESSING_ORIGINS: "1",
      },
      maxBuffer: 16 * 1024 * 1024,
    });

    const worker = startChild(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        workerConfig,
        "--env-file",
        environmentFile,
        "--persist-to",
        persistence,
        "--ip",
        "127.0.0.1",
        "--port",
        String(workerPort),
        "--inspector-port",
        String(inspectorPort),
        "--log-level",
        "warn",
        "--show-interactive-dev-session=false",
      ],
      { label: "worker" },
    );
    children.push(worker);
    await waitForEndpoint(`${workerOrigin}/`, worker);
    edgeProxy = await startLocalEdgeProxy(apiPort, workerOrigin);
    await waitForEndpoint(`${apiOrigin}/`);

    const pages = startChild(
      "pnpm",
      [
        "--filter",
        "@hereisit/web",
        "exec",
        "wrangler",
        "pages",
        "dev",
        "out",
        "--ip",
        "127.0.0.1",
        "--port",
        String(pagePort),
        "--compatibility-date=2026-07-10",
        "--log-level",
        "warn",
        "--show-interactive-dev-session=false",
      ],
      { label: "pages" },
    );
    children.push(pages);
    await waitForEndpoint(`${pageOrigin}/`, pages);
    const browser = await smokeImageCompressServer({ pageOrigin });
    return { engineOutcomes, browser, orphanObjects: 0 };
  } finally {
    for (const child of children.reverse()) await stopChild(child);
    await stopServer(edgeProxy);
    if (engineContainer !== undefined) {
      await docker("rm", "--force", engineContainer).catch(() => undefined);
    }
    await Promise.all([
      rm(workerConfig, { force: true }),
      rm(artifactRoot, { recursive: true, force: true }),
    ]);
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = await testProcessingStack();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
