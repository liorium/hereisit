import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { canonicalJson, parseCliArguments, writeCanonicalJsonAtomic } from "./image-lab-common.mjs";
import { runProcessingStagingBrowserSmoke } from "./support/processing-staging-smoke-runtime.mjs";

const PROCESSING_STAGING_ORIGIN = "https://processing-staging.hereisit.pages.dev";
const SESSION_STORAGE_KEY = "hereisit.processing-session.v1";
const PUBLIC_BUCKET_ZERO_SESSION_ID = "eb8f99c7-54e5-48f0-9233-218cc5b7ffef";
const JOB_UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_UUID_PATTERN = new RegExp(`^${SESSION_UUID_SEGMENT}$`);
const privateSourceName = "stack-source-private.jpg";
const expectedDownloadName = "stack-source-private-hereisit.jpg";
const jobIdPattern = new RegExp(`/v1/jobs/${JOB_UUID_SEGMENT}`, "g");
const inputPathPattern = new RegExp(`^/v1/jobs/${JOB_UUID_SEGMENT}/input$`);
const downloadedPathPattern = new RegExp(`^/v1/jobs/${JOB_UUID_SEGMENT}/downloaded$`);
const stableFailure = "processing staging smoke failed";
const safeFailures = new Set([
  `${stableFailure} [browser-launch]`,
  `${stableFailure} [public-context]`,
  `${stableFailure} [public-navigation]`,
  `${stableFailure} [public-policy]`,
  `${stableFailure} [public-ui]`,
  `${stableFailure} [public-invariants]`,
  `${stableFailure} [maintainer-context]`,
  `${stableFailure} [maintainer-navigation]`,
  `${stableFailure} [maintainer-policy]`,
  `${stableFailure} [maintainer-ui]`,
  `${stableFailure} [preset-selection]`,
  `${stableFailure} [file-selection]`,
  `${stableFailure} [job-submit]`,
  `${stableFailure} [job-completion]`,
  `${stableFailure} [download-handoff]`,
  `${stableFailure} [maintainer-console]`,
  `${stableFailure} [maintainer-page-error]`,
  `${stableFailure} [maintainer-request-failed]`,
  `${stableFailure} [maintainer-source-leak]`,
  `${stableFailure} [maintainer-input-options]`,
  `${stableFailure} [maintainer-input-put]`,
  `${stableFailure} [maintainer-input-size]`,
  `${stableFailure} [maintainer-download-ack-count]`,
  `${stableFailure} [maintainer-download-ack-status]`,
]);

async function runSmokeStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && safeFailures.has(error.message)) throw error;
    throw new Error(`${stableFailure} [${stage}]`);
  }
}

export function projectSmokeRequest({ method, url, bodyBytes }) {
  const path = new URL(url).pathname.replace(jobIdPattern, "/v1/jobs/[job]");
  return {
    method,
    path,
    ...(bodyBytes === undefined ? {} : { bodyBytes }),
  };
}

export function summarizeSmokeRequests(requests) {
  return requests.map((value) => {
    const separator = value.indexOf(" ");
    const projected = projectSmokeRequest({
      method: value.slice(0, separator),
      url: value.slice(separator + 1),
    });
    return `${projected.method} ${projected.path}`;
  });
}

function assertOrigin(value, label) {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError(`${label} must be HTTP(S)`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} must be an origin`);
  }
  return url.origin;
}

function assertQuietPage(page, state) {
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") state.consoleError = true;
    if (text.includes(privateSourceName)) state.sourceFilenameLeak = true;
  });
  page.on("pageerror", () => {
    state.pageError = true;
  });
  page.on("requestfailed", () => {
    state.requestFailed = true;
  });
}

function injectSession(context, pageOrigin, sessionId) {
  return context.addInitScript(
    ({ origin, injectedSessionId, storageKey }) => {
      if (location.origin === origin) localStorage.setItem(storageKey, injectedSessionId);
    },
    { origin: pageOrigin, injectedSessionId: sessionId, storageKey: SESSION_STORAGE_KEY },
  );
}

function observePolicies(page, state) {
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/v1/policy") return;
    state.policyReads.push(
      response
        .json()
        .then((body) => {
          state.policies.push({
            status: response.status(),
            maintainer: body?.maintainer,
            execution: body?.execution,
            reason: body?.reason,
          });
        })
        .catch(() => {
          state.invalidPolicy = true;
        }),
    );
  });
}

async function assertPolicies(state, expected) {
  await Promise.all(state.policyReads);
  if (
    state.invalidPolicy ||
    state.policies.length < 1 ||
    state.policies.some(
      (policy) =>
        policy.status !== 200 ||
        policy.maintainer !== expected.maintainer ||
        policy.execution !== expected.execution ||
        policy.reason !== expected.reason,
    )
  ) {
    throw new Error(
      `${stableFailure} [${expected.maintainer ? "maintainer-policy" : "public-policy"}]`,
    );
  }
}

async function assertNonMaintainerLocal(browser, pageOrigin, timeoutMs) {
  const context = await runSmokeStage("public-context", () => browser.newContext());
  await runSmokeStage("public-context", () =>
    injectSession(context, pageOrigin, PUBLIC_BUCKET_ZERO_SESSION_ID),
  );
  const page = await runSmokeStage("public-context", () => context.newPage());
  const cdp = await runSmokeStage("public-context", () => context.newCDPSession(page));
  await runSmokeStage("public-context", () => cdp.send("Network.enable"));
  const state = {
    jobRequest: false,
    consoleError: false,
    pageError: false,
    requestFailed: false,
    sourceFilenameLeak: false,
    invalidPolicy: false,
    policies: [],
    policyReads: [],
  };
  assertQuietPage(page, state);
  observePolicies(page, state);
  cdp.on("Network.requestWillBeSent", ({ request: { method: _method, url } }) => {
    if (new URL(url).pathname.startsWith("/v1/jobs")) state.jobRequest = true;
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(privateSourceName)) state.sourceFilenameLeak = true;
  });
  try {
    await runSmokeStage("public-navigation", () =>
      page.goto(`${pageOrigin}/image/compress`, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      }),
    );
    await assertPolicies(state, {
      maintainer: false,
      execution: "local",
      reason: "LOCAL_FALLBACK_REQUIRED",
    });
    await runSmokeStage("public-ui", () =>
      page.locator('[data-policy="local"] strong').waitFor({ timeout: timeoutMs }),
    );
    await page.waitForTimeout(250);
    if (
      state.jobRequest ||
      state.consoleError ||
      state.pageError ||
      state.requestFailed ||
      state.sourceFilenameLeak
    ) {
      throw new Error(`${stableFailure} [public-invariants]`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function assertMaintainerServer(
  browser,
  pageOrigin,
  maintainerSessionId,
  sourcePath,
  timeoutMs,
) {
  const context = await runSmokeStage("maintainer-context", () =>
    browser.newContext({ acceptDownloads: true }),
  );
  await runSmokeStage("maintainer-context", () =>
    injectSession(context, pageOrigin, maintainerSessionId),
  );
  const page = await runSmokeStage("maintainer-context", () => context.newPage());
  const cdp = await runSmokeStage("maintainer-context", () => context.newCDPSession(page));
  await runSmokeStage("maintainer-context", () => cdp.send("Network.enable"));
  const state = {
    consoleError: false,
    pageError: false,
    requestFailed: false,
    sourceFilenameLeak: false,
    inputOptions: 0,
    inputPuts: 0,
    putBodyBytes: [],
    downloadAcknowledgements: 0,
    downloadAcknowledged: false,
    invalidPolicy: false,
    policies: [],
    policyReads: [],
  };
  const sizeReads = [];
  assertQuietPage(page, state);
  observePolicies(page, state);
  cdp.on("Network.requestWillBeSent", ({ request: { method, url } }) => {
    const path = new URL(url).pathname;
    if (method === "OPTIONS" && inputPathPattern.test(path)) state.inputOptions += 1;
  });
  page.on("request", (request) => {
    const url = request.url();
    const path = new URL(url).pathname;
    if (url.includes(privateSourceName)) state.sourceFilenameLeak = true;
    if (inputPathPattern.test(path) && request.method() === "PUT") state.inputPuts += 1;
    if (downloadedPathPattern.test(path) && request.method() === "POST") {
      state.downloadAcknowledgements += 1;
    }
  });
  page.on("requestfinished", (request) => {
    const path = new URL(request.url()).pathname;
    if (!inputPathPattern.test(path) || request.method() !== "PUT") return;
    sizeReads.push(
      request.sizes().then((sizes) => {
        state.putBodyBytes.push(sizes.requestBodySize);
      }),
    );
  });
  page.on("response", (response) => {
    const request = response.request();
    if (
      downloadedPathPattern.test(new URL(response.url()).pathname) &&
      request.method() === "POST" &&
      response.ok()
    ) {
      state.downloadAcknowledged = true;
    }
  });
  try {
    await runSmokeStage("maintainer-navigation", () =>
      page.goto(`${pageOrigin}/image/compress`, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      }),
    );
    await assertPolicies(state, { maintainer: true, execution: "server", reason: null });
    await runSmokeStage("maintainer-ui", () =>
      page.locator('[data-policy="server"] strong').waitFor({ timeout: timeoutMs }),
    );
    await runSmokeStage("preset-selection", () =>
      page.getByRole("radio", { name: /최소 용량/ }).check(),
    );
    const source = await readFile(sourcePath);
    await runSmokeStage("file-selection", () =>
      page.locator('input[type="file"]').setInputFiles({
        name: privateSourceName,
        mimeType: "image/jpeg",
        buffer: source,
      }),
    );
    await runSmokeStage("job-submit", () =>
      page.getByRole("button", { name: "1개 이미지 용량 줄이기 →" }).click(),
    );
    const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
    await runSmokeStage("job-completion", () => downloadButton.waitFor({ timeout: timeoutMs }));
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
    const acknowledgementPromise = page.waitForResponse(
      (response) =>
        downloadedPathPattern.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST" &&
        response.ok(),
      { timeout: timeoutMs },
    );
    const [download] = await runSmokeStage("download-handoff", async () => {
      await downloadButton.click();
      return Promise.all([downloadPromise, acknowledgementPromise]);
    });
    if (download.suggestedFilename() !== expectedDownloadName) throw new Error(stableFailure);
    const stream = await download.createReadStream();
    if (stream === null) throw new Error(stableFailure);
    let downloadBytes = 0;
    for await (const chunk of stream) downloadBytes += chunk.byteLength;
    if (downloadBytes < 1) throw new Error(stableFailure);
    await Promise.all(sizeReads);
    await page.waitForTimeout(250);
    if (state.consoleError) throw new Error(`${stableFailure} [maintainer-console]`);
    if (state.pageError) throw new Error(`${stableFailure} [maintainer-page-error]`);
    if (state.requestFailed) throw new Error(`${stableFailure} [maintainer-request-failed]`);
    if (state.sourceFilenameLeak) throw new Error(`${stableFailure} [maintainer-source-leak]`);
    if (state.inputOptions !== 1) throw new Error(`${stableFailure} [maintainer-input-options]`);
    if (state.inputPuts !== 1) throw new Error(`${stableFailure} [maintainer-input-put]`);
    if (state.putBodyBytes.length !== 1 || state.putBodyBytes[0] !== source.byteLength) {
      throw new Error(`${stableFailure} [maintainer-input-size]`);
    }
    if (state.downloadAcknowledgements !== 1) {
      throw new Error(`${stableFailure} [maintainer-download-ack-count]`);
    }
    if (!state.downloadAcknowledged) {
      throw new Error(`${stableFailure} [maintainer-download-ack-status]`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
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

async function performImageCompressServerSmoke({
  pageOrigin,
  sourcePath = resolve("tests/image-corpus/public/photo-ordinary-jpeg.jpg"),
  timeoutMs = 120_000,
  maintainerSessionId,
}) {
  const origin = pageOrigin;
  const browser = await runSmokeStage("browser-launch", () => chromium.launch({ headless: true }));
  try {
    if (maintainerSessionId !== undefined) {
      if (origin !== PROCESSING_STAGING_ORIGIN || !SESSION_UUID_PATTERN.test(maintainerSessionId)) {
        throw new TypeError(stableFailure);
      }
      await assertNonMaintainerLocal(browser, origin, timeoutMs);
      await assertMaintainerServer(browser, origin, maintainerSessionId, sourcePath, timeoutMs);
      return stagingSmokeResult();
    }

    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const network = [];
    let sourceFilenameLeak = false;
    page.on("request", (request) => {
      network.push(`${request.method()} ${request.url()}`);
      if (request.url().includes(privateSourceName)) sourceFilenameLeak = true;
    });
    page.on("console", (message) => {
      if (message.text().includes(privateSourceName)) sourceFilenameLeak = true;
    });
    try {
      await page.goto(`${origin}/image/compress`, { waitUntil: "networkidle", timeout: timeoutMs });
      await page.locator('[data-policy="server"] strong').waitFor({ timeout: timeoutMs });
      const source = await readFile(sourcePath);
      await page.locator('input[type="file"]').setInputFiles({
        name: privateSourceName,
        mimeType: "image/jpeg",
        buffer: source,
      });
      await page.getByRole("button", { name: "1개 이미지 용량 줄이기 →" }).click();
      const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
      await downloadButton.waitFor({ timeout: timeoutMs });
      const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
      await downloadButton.click();
      const download = await downloadPromise;
      if (download.suggestedFilename() !== expectedDownloadName) throw new Error(stableFailure);
      const stream = await download.createReadStream();
      if (stream === null) throw new Error(stableFailure);
      let bytes = 0;
      for await (const chunk of stream) bytes += chunk.byteLength;
      if (bytes < 1 || sourceFilenameLeak) throw new Error(stableFailure);
      const jobRequests = network.filter((value) => value.includes("/v1/jobs"));
      if (!jobRequests.some((value) => value.startsWith("PUT "))) throw new Error(stableFailure);
      return {
        directDownload: true,
        workerRequests: jobRequests.length,
        sourceFilenameLeak: false,
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function smokeImageCompressServer(input) {
  const pageOrigin = assertOrigin(input.pageOrigin, "page origin");
  return runProcessingStagingBrowserSmoke(
    { ...input, pageOrigin },
    performImageCompressServerSmoke,
  );
}

function parseStagingSmokeCli(argv, environment) {
  try {
    const args = parseCliArguments(argv);
    if (
      argv.join("\0") !==
        `--page-origin\0${PROCESSING_STAGING_ORIGIN}\0--output\0${args.output ?? ""}` ||
      Object.keys(args).sort().join() !== "output,page-origin" ||
      typeof args.output !== "string" ||
      args.output.length === 0 ||
      !SESSION_UUID_PATTERN.test(environment.STAGING_MAINTAINER_SESSION_ID ?? "")
    ) {
      throw new TypeError(stableFailure);
    }
    return {
      pageOrigin: PROCESSING_STAGING_ORIGIN,
      outputPath: args.output,
      sessionId: environment.STAGING_MAINTAINER_SESSION_ID,
    };
  } catch {
    throw new TypeError("processing staging smoke configuration is invalid");
  }
}

export async function runProcessingStagingSmokeCli({ argv, environment }) {
  const input = parseStagingSmokeCli(argv, environment);
  try {
    await lstat(input.outputPath).then(
      () => Promise.reject(new Error(stableFailure)),
      (error) => {
        if (error?.code !== "ENOENT") throw new Error(stableFailure);
      },
    );
    const result = await smokeImageCompressServer({
      pageOrigin: input.pageOrigin,
      maintainerSessionId: input.sessionId,
    });
    if (canonicalJson(result) !== canonicalJson(stagingSmokeResult())) {
      throw new Error(stableFailure);
    }
    await writeCanonicalJsonAtomic(input.outputPath, result, {
      refuseOverwrite: true,
      mode: 0o600,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && safeFailures.has(error.message)) {
      throw new Error(error.message);
    }
    throw new Error(stableFailure);
  }
}

async function main() {
  await runProcessingStagingSmokeCli({ argv: process.argv.slice(2), environment: process.env });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof Error && safeFailures.has(error.message) ? error.message : stableFailure;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
